-- Email and phone are stored as they are: plain text, no encryption and no keyed hash. An account
-- is found by its email or phone directly, and each is unique.
--
-- This step adds the plain columns and switches every function to them. The encrypted copies and
-- the hashes stay for the moment, so the one-off scripts/backfill-contacts.mjs can decrypt the
-- existing rows into the plain columns; 20261102091000 then makes the plain columns required and
-- drops the old ones.

-- 1. Columns. Nullable until the backfill has run.
alter table app.users
  add column email text,
  add column phone text,
  alter column email_enc drop not null,
  alter column email_hash drop not null,
  alter column phone_enc drop not null,
  alter column phone_hash drop not null;
create unique index users_email_key on app.users (email);
create unique index users_phone_key on app.users (phone);

alter table app.signup_requests
  add column email text,
  add column phone text,
  alter column email_enc drop not null,
  alter column email_hash drop not null,
  alter column phone_enc drop not null,
  alter column phone_hash drop not null;
create index signup_requests_email_idx on app.signup_requests (email);
create index signup_requests_phone_idx on app.signup_requests (phone);

-- The address a code was sent to (an email or an E.164 phone number).
alter table app.otp_challenges
  add column destination text,
  alter column destination_hash drop not null;
-- Starting a reset expires the older open codes for the same address and purpose.
create index otp_challenges_destination_open_idx
  on app.otp_challenges (destination, purpose) where verified_at is null;

-- 2. Functions. Same behaviour as before; only the columns and the shape of the contact
--    arguments change (plain values instead of hashes and ciphertext).

-- p_challenge: { publicId, codeHash, decoyHash }. A decoy stores a hash no code can match.
drop function app.create_challenge(jsonb, text, text, text, bigint, bigint, boolean, integer, jsonb);
create function app.create_challenge(
  p_challenge jsonb, p_purpose text, p_channel text, p_destination text, p_user_id bigint,
  p_signup_id bigint, p_is_decoy boolean, p_ttl_seconds integer, p_ctx jsonb
) returns void language sql set search_path = '' as $$
  insert into app.otp_challenges (public_id, purpose, channel, destination, user_id,
    signup_request_id, is_decoy, code_hash, expires_at, created_ip)
  values ((p_challenge ->> 'publicId')::uuid, p_purpose, p_channel, p_destination, p_user_id,
    p_signup_id, p_is_decoy,
    case when p_is_decoy then p_challenge ->> 'decoyHash' else p_challenge ->> 'codeHash' end,
    now() + make_interval(secs => p_ttl_seconds), (p_ctx ->> 'ip')::inet);
$$;

-- Creates the account from a pending sign-up (locked by the caller) and starts its first session.
create or replace function app.complete_signup(
  p_signup_id bigint, p_session jsonb, p_age_consent_version text, p_ctx jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare
  v_s app.signup_requests%rowtype;
  v_user_id bigint;
  v_user_public_id uuid;
  v_expires timestamptz;
begin
  select * into v_s from app.signup_requests where id = p_signup_id;

  -- A conflict means someone else completed sign-up with this email or phone first.
  insert into app.users (email, phone_country_code, phone, password_hash, email_verified_at,
    phone_verified_at)
  values (v_s.email, v_s.phone_country_code, v_s.phone, v_s.password_hash, v_s.email_verified_at,
    v_s.phone_verified_at)
  on conflict do nothing
  returning id, public_id into v_user_id, v_user_public_id;
  if v_user_id is null then
    return jsonb_build_object('error', 'ACCOUNT_EXISTS');
  end if;

  insert into app.user_profiles (user_id, name) values (v_user_id, v_s.name);
  -- Steps 2-3 and the tier, when the app sent them with the registration.
  perform app.apply_signup_onboarding(v_user_id, v_s.onboarding, p_ctx);
  insert into app.consents (user_id, type, version, accepted_at, ip, user_agent, app_version)
  values (v_user_id, 'AGE_18_PLUS', p_age_consent_version, v_s.age_confirmed_at, v_s.created_ip,
    v_s.user_agent, v_s.app_version);
  -- The pending copy, and any other open sign-ups for the same email or phone, are no longer needed.
  delete from app.signup_requests
  where id = v_s.id
     or (completed_at is null and (email = v_s.email or phone = v_s.phone));

  v_expires := app.create_session(v_user_id, p_session, p_ctx);
  perform app.write_audit(p_ctx, 'auth.register.completed', v_user_id, jsonb_build_object(
    'emailVerified', v_s.email_verified_at is not null, 'phoneVerified', v_s.phone_verified_at is not null));
  return jsonb_build_object('status', 'COMPLETED', 'userId', v_user_id::text,
    'userPublicId', v_user_public_id, 'sessionExpiresAt', v_expires);
end $$;

-- p_signup: { name, email, countryCode, phone, passwordHash, ttlSeconds, otpTtlSeconds, onboarding }.
-- Either challenge may be left out (null): no code is created for it.
create or replace function public.app_signup_start(
  p_signup jsonb, p_email_challenge jsonb, p_phone_challenge jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text := p_signup ->> 'email';
  v_phone text := p_signup ->> 'phone';
  v_email_taken boolean;
  v_phone_taken boolean;
  v_id bigint;
  v_public_id uuid;
  v_expires timestamptz;
  v_otp_ttl integer := (p_signup ->> 'otpTtlSeconds')::integer;
  v_errors jsonb := app.signup_onboarding_errors(p_signup -> 'onboarding');
begin
  if v_errors is not null then
    return jsonb_build_object('fields', v_errors);
  end if;

  select exists (select 1 from app.users where email = v_email) into v_email_taken;
  select exists (select 1 from app.users where phone = v_phone) into v_phone_taken;
  if v_email_taken or v_phone_taken then
    perform app.write_audit(p_ctx, 'auth.register.duplicate', null,
      jsonb_build_object('emailTaken', v_email_taken, 'phoneTaken', v_phone_taken));
    return jsonb_build_object('taken', jsonb_build_object('email', v_email_taken, 'phone', v_phone_taken));
  end if;

  insert into app.signup_requests (name, email, phone_country_code, phone, password_hash,
    age_confirmed_at, created_ip, user_agent, app_version, expires_at, onboarding)
  values (p_signup ->> 'name', v_email, p_signup ->> 'countryCode', v_phone,
    p_signup ->> 'passwordHash', now(), (p_ctx ->> 'ip')::inet, p_ctx ->> 'userAgent',
    p_ctx ->> 'appVersion', now() + make_interval(secs => (p_signup ->> 'ttlSeconds')::integer),
    p_signup -> 'onboarding')
  returning id, public_id, expires_at into v_id, v_public_id, v_expires;

  if p_email_challenge is not null then
    perform app.create_challenge(p_email_challenge, 'SIGNUP', 'EMAIL', v_email, null,
      v_id, false, v_otp_ttl, p_ctx);
  end if;
  if p_phone_challenge is not null then
    perform app.create_challenge(p_phone_challenge, 'SIGNUP', 'PHONE', v_phone, null,
      v_id, false, v_otp_ttl, p_ctx);
  end if;
  perform app.write_audit(p_ctx, 'auth.register.started', null, jsonb_build_object('signupId', v_public_id));

  return jsonb_build_object('signupId', v_public_id, 'expiresAt', v_expires);
end $$;

-- Which of the two addresses already belong to an account (any status: they stay unique).
-- null: that address is not being checked.
drop function public.app_contact_taken(text, text);
create function public.app_contact_taken(p_email text, p_phone text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'emailTaken', exists (select 1 from app.users where email = p_email),
    'phoneTaken', exists (select 1 from app.users where phone = p_phone));
$$;

-- Password-reset code. A code is created only when an active account has the address; otherwise
-- nothing is created, the attempt is audited, and { userExists: false } is returned.
drop function public.app_otp_start(text, text, text, jsonb, integer, jsonb);
create function public.app_otp_start(
  p_purpose text, p_channel text, p_destination text, p_challenge jsonb, p_ttl_seconds integer,
  p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id bigint;
begin
  if p_purpose is distinct from 'PASSWORD_RESET' then
    raise exception 'invalid purpose %', p_purpose;
  end if;
  if p_channel = 'EMAIL' then
    select id into v_user_id from app.users where email = p_destination and status = 'ACTIVE';
  else
    select id into v_user_id from app.users where phone = p_destination and status = 'ACTIVE';
  end if;

  if v_user_id is null then
    perform app.write_audit(p_ctx, 'auth.password.reset_unknown_account', null,
      jsonb_build_object('channel', p_channel));
    return jsonb_build_object('userExists', false);
  end if;

  -- Only the newest code per address works.
  update app.otp_challenges set expires_at = now()
  where destination = p_destination and purpose = p_purpose
    and verified_at is null and expires_at > now();
  perform app.create_challenge(p_challenge, p_purpose, p_channel, p_destination, v_user_id, null,
    false, p_ttl_seconds, p_ctx);

  perform app.write_audit(p_ctx, 'auth.password.reset_requested', v_user_id,
    jsonb_build_object('channel', p_channel));
  return jsonb_build_object('userExists', true);
end $$;

-- The address a challenge belongs to, so the API can apply per-address limits.
create or replace function public.app_otp_peek(p_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('destination', destination)
  from app.otp_challenges where public_id = p_public_id;
$$;

-- New code on an existing challenge. p_limit: { key, max, window } for the per-address send limit.
-- Returns { channel, purpose, isDecoy, destination } or { error }.
create or replace function public.app_otp_resend(
  p_public_id uuid, p_challenge jsonb, p_cooldown_seconds integer, p_max_sends integer,
  p_ttl_seconds integer, p_limit jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_c app.otp_challenges%rowtype;
  v_since double precision;
  v_hit jsonb;
  v_destination text;
begin
  select * into v_c from app.otp_challenges where public_id = p_public_id for update;
  if not found or v_c.verified_at is not null then
    return jsonb_build_object('error', 'OTP_CHALLENGE_INVALID');
  end if;
  if v_c.signup_request_id is not null and not exists (
    select 1 from app.signup_requests
    where id = v_c.signup_request_id and completed_at is null and expires_at > now()
  ) then
    return jsonb_build_object('error', 'SIGNUP_EXPIRED');
  end if;

  v_since := extract(epoch from now() - v_c.last_sent_at);
  if v_since < p_cooldown_seconds then
    return jsonb_build_object('error', 'OTP_RESEND_COOLDOWN', 'retryAfter', ceil(p_cooldown_seconds - v_since));
  end if;
  if v_c.send_count >= p_max_sends then
    return jsonb_build_object('error', 'OTP_RESEND_LIMIT');
  end if;
  v_hit := app.rate_limit_hit(p_limit ->> 'key', (p_limit ->> 'max')::integer, (p_limit ->> 'window')::integer);
  if (v_hit ->> 'limited')::boolean then
    return jsonb_build_object('error', 'RATE_LIMITED', 'retryAfter', v_hit -> 'retryAfter');
  end if;

  update app.otp_challenges set
    code_hash = case when is_decoy then p_challenge ->> 'decoyHash' else p_challenge ->> 'codeHash' end,
    attempts = 0, send_count = send_count + 1, last_sent_at = now(),
    expires_at = now() + make_interval(secs => p_ttl_seconds)
  where id = v_c.id;

  if not v_c.is_decoy then
    v_destination := v_c.destination;
  end if;
  return jsonb_build_object('channel', v_c.channel, 'purpose', v_c.purpose, 'isDecoy', v_c.is_decoy,
    'destination', v_destination);
end $$;

-- The account behind an email or E.164 phone, for the password check (done in the API).
drop function public.app_login_lookup(text, text);
create function public.app_login_lookup(p_channel text, p_identifier text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('userId', id::text, 'userPublicId', public_id,
    'passwordHash', password_hash, 'status', status)
  from app.users
  where status <> 'DELETED'
    and ((p_channel = 'EMAIL' and email = p_identifier) or (p_channel = 'PHONE' and phone = p_identifier));
$$;

-- The account behind a usable reset ticket, so the API can check the new password against it.
create or replace function public.app_reset_lookup(p_token_hash text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('userId', u.id::text, 'passwordHash', u.password_hash,
    'email', u.email, 'phone', u.phone)
  from app.password_reset_tickets t join app.users u on u.id = t.user_id
  where t.token_hash = p_token_hash and t.used_at is null and t.expires_at > now() and u.status = 'ACTIVE';
$$;

-- Everything GET /me shows.
create or replace function public.app_get_user(p_user_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'publicId', u.public_id, 'email', u.email, 'phone', u.phone, 'tier', u.tier,
    'requestedTier', u.requested_tier, 'kycStatus', u.kyc_status, 'tierSelectedAt', u.tier_selected_at,
    'createdAt', u.created_at, 'name', p.name, 'experienceYears', p.experience_years,
    'jobProfileCode', p.job_profile_code, 'otherJob', p.other_job,
    'location', p.location, 'avatarBucket', f.bucket, 'avatarObjectKey', f.object_key,
    'followers', (select count(*) from app.follows where followee_id = u.id),
    'following', (select count(*) from app.follows where follower_id = u.id),
    'preferences', (
      select coalesce(jsonb_agg(jsonb_build_object('type', up.type, 'code', up.option_code)
        order by up.type, up.created_at, up.option_code), '[]'::jsonb)
      from app.user_preferences up
      where up.user_id = u.id))
  from app.users u
  join app.user_profiles p on p.user_id = u.id
  left join app.files f on f.id = p.avatar_file_id
  where u.id = p_user_id;
$$;

-- Member search. Exact email or phone, or a name pattern. Lists carry no contact details;
-- GET /admin/users/:id does, and is audited.
drop function public.app_admin_find_users(text, text, text, text[], text[], text[], boolean, integer, integer);
create function public.app_admin_find_users(
  p_q_pattern text, p_email text, p_phone text, p_tiers text[], p_kyc_statuses text[],
  p_statuses text[], p_staff_only boolean, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with matched as (
    select u.id, u.public_id, u.tier, u.requested_tier, u.kyc_status, u.status, u.credit_balance,
           u.created_at, u.last_login_at, coalesce(p.name, '') as name
    from app.users u
    left join app.user_profiles p on p.user_id = u.id
    where (p_q_pattern is null or lower(p.name) like p_q_pattern)
      and (p_email is null or u.email = p_email)
      and (p_phone is null or u.phone = p_phone)
      and (p_tiers is null or u.tier = any (p_tiers))
      and (p_kyc_statuses is null or u.kyc_status = any (p_kyc_statuses))
      and (p_statuses is null or u.status = any (p_statuses))
      and (not p_staff_only or exists (select 1 from app.user_roles r where r.user_id = u.id))
  ),
  page as (
    select m.*, row_number() over (order by m.created_at desc, m.id desc) as rn
    from matched m
    order by m.created_at desc, m.id desc
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pg.public_id, 'name', pg.name, 'tier', pg.tier, 'requestedTier', pg.requested_tier,
        'kycStatus', pg.kyc_status, 'status', pg.status, 'creditBalance', pg.credit_balance,
        'roles', (select coalesce(jsonb_agg(r.role order by r.role), '[]'::jsonb)
                  from app.user_roles r where r.user_id = pg.id),
        'createdAt', pg.created_at, 'lastLoginAt', pg.last_login_at)
        order by pg.rn)
      from page pg), '[]'::jsonb));
$$;

-- Everything a staff member sees about one account, including the email and phone. Viewing it
-- is audited. Null if the account does not exist.
create or replace function public.app_admin_get_user(p_actor_id bigint, p_user_public_id uuid, p_ctx jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id bigint;
  v_result jsonb;
begin
  select id into v_user_id from app.users where public_id = p_user_public_id;
  if v_user_id is null then
    return null;
  end if;

  select jsonb_build_object(
    'id', u.public_id, 'email', u.email, 'phone', u.phone,
    'name', coalesce(p.name, ''), 'experienceYears', p.experience_years,
    'jobProfileCode', p.job_profile_code, 'otherJob', p.other_job, 'location', p.location,
    'tier', u.tier, 'requestedTier', u.requested_tier, 'kycStatus', u.kyc_status,
    'status', u.status, 'creditBalance', u.credit_balance,
    'roles', (select coalesce(jsonb_agg(r.role order by r.role), '[]'::jsonb)
              from app.user_roles r where r.user_id = u.id),
    'createdAt', u.created_at, 'lastLoginAt', u.last_login_at, 'tierSelectedAt', u.tier_selected_at,
    'activeSessions', (
      select count(*) from app.user_sessions s
      where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()
        and s.absolute_expires_at > now()),
    'kyc', (
      select jsonb_build_object('id', k.public_id, 'tier', k.tier, 'status', k.status,
        'reason', k.reason, 'submittedAt', k.created_at, 'reviewedAt', k.reviewed_at)
      from app.kyc_submissions k where k.user_id = u.id
      order by k.created_at desc limit 1),
    'activity', jsonb_build_object(
      'reviews', (select count(*) from public.reviews r
                  where r.user_id = u.public_id and r.deleted_at is null),
      'ratings', (select count(*) from app.issuer_ratings r
                  where r.user_id = u.id and r.deleted_at is null),
      'signatures', (select count(*) from app.representation_signatures s
                     where s.user_id = u.id and s.deleted_at is null and s.status = 'VALID'),
      'poolMemberships', (select count(*) from public.pool_members m where m.user_id = u.public_id),
      'followers', (select count(*) from app.follows f where f.followee_id = u.id),
      'following', (select count(*) from app.follows f where f.follower_id = u.id)),
    'tierHistory', (
      select coalesce(jsonb_agg(jsonb_build_object('fromTier', h.from_tier, 'toTier', h.to_tier,
          'requestedTier', h.requested_tier, 'reason', h.reason, 'createdAt', h.created_at)
        order by h.created_at desc, h.id desc), '[]'::jsonb)
      from (select * from app.tier_history t where t.user_id = u.id
            order by t.created_at desc, t.id desc limit 20) h))
  into v_result
  from app.users u
  left join app.user_profiles p on p.user_id = u.id
  where u.id = v_user_id;

  perform app.write_audit(p_ctx, 'admin.user.viewed', p_actor_id,
    jsonb_build_object('user', p_user_public_id));
  return v_result;
end $$;

revoke execute on all functions in schema app from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
