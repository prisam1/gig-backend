-- One way into the database: supabase-js with the service-role key.
--
-- The private "app" schema (accounts, sessions, OTP codes, profiles, files, KYC, audit log, rate
-- limits) stays hidden from the Supabase Data API. The API server reaches it only through the
-- public.app_* functions below. They run as their owner (security definer), take a fixed set of
-- arguments, and can be called by the service role alone, so even the server cannot run
-- arbitrary SQL against these tables.
--
-- Each function is one atomic operation. Expected failures (a wrong OTP, an expired sign-up) are
-- returned as { "error": CODE } rather than raised, so the state that must be kept (a counted
-- attempt, a revoked session) is committed. Hashing, encryption and token generation stay in
-- the API, which holds the keys; the database only ever sees hashes and ciphertext.

-- ---------------------------------------------------------------------------------------------
-- Internal helpers (app schema, not callable through the API)
-- ---------------------------------------------------------------------------------------------

create or replace function app.write_audit(p_ctx jsonb, p_action text, p_user_id bigint, p_metadata jsonb)
returns void language sql set search_path = '' as $$
  insert into app.audit_logs (action, actor_user_id, ip, user_agent, request_id, metadata)
  values (p_action, p_user_id, (p_ctx ->> 'ip')::inet, p_ctx ->> 'userAgent', p_ctx ->> 'requestId',
          coalesce(p_metadata, '{}'::jsonb));
$$;

-- Counts one hit on a shared limit. Returns { limited, retryAfter }.
create or replace function app.rate_limit_hit(p_key text, p_max integer, p_window_seconds integer)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_count integer;
  v_retry double precision;
begin
  insert into app.rate_limits as r (key, count, expires_at)
  values (p_key, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (key) do update set
    count = case when r.expires_at <= now() then 1 else r.count + 1 end,
    expires_at = case when r.expires_at <= now() then excluded.expires_at else r.expires_at end
  returning r.count, extract(epoch from r.expires_at - now())::double precision into v_count, v_retry;
  return jsonb_build_object('limited', v_count > p_max, 'retryAfter', v_retry);
end $$;

-- p_challenge: { publicId, codeHash, decoyHash }. A decoy stores a hash no code can match.
create or replace function app.create_challenge(
  p_challenge jsonb, p_purpose text, p_channel text, p_destination_hash text, p_user_id bigint,
  p_signup_id bigint, p_is_decoy boolean, p_ttl_seconds integer, p_ctx jsonb
) returns void language sql set search_path = '' as $$
  insert into app.otp_challenges (public_id, purpose, channel, destination_hash, user_id,
    signup_request_id, is_decoy, code_hash, expires_at, created_ip)
  values ((p_challenge ->> 'publicId')::uuid, p_purpose, p_channel, p_destination_hash, p_user_id,
    p_signup_id, p_is_decoy,
    case when p_is_decoy then p_challenge ->> 'decoyHash' else p_challenge ->> 'codeHash' end,
    now() + make_interval(secs => p_ttl_seconds), (p_ctx ->> 'ip')::inet);
$$;

-- p_session: { publicId, refreshHash, deviceName, platform, idleDays, maxDays, maxActive }.
-- Keeps at most maxActive devices (least recently used signed out). Returns the refresh expiry.
create or replace function app.create_session(p_user_id bigint, p_session jsonb, p_ctx jsonb)
returns timestamptz language plpgsql set search_path = '' as $$
declare
  v_absolute timestamptz := now() + make_interval(days => (p_session ->> 'maxDays')::integer);
  v_expires timestamptz := least(now() + make_interval(days => (p_session ->> 'idleDays')::integer), v_absolute);
begin
  update app.user_sessions set revoked_at = now(), revoked_reason = 'SESSION_LIMIT'
  where id in (
    select id from app.user_sessions
    where user_id = p_user_id and revoked_at is null
    order by last_used_at desc
    offset (p_session ->> 'maxActive')::integer - 1
  );
  insert into app.user_sessions (public_id, user_id, refresh_token_hash, device_name, platform,
    app_version, ip, user_agent, expires_at, absolute_expires_at)
  values ((p_session ->> 'publicId')::uuid, p_user_id, p_session ->> 'refreshHash',
    p_session ->> 'deviceName', coalesce(p_session ->> 'platform', 'OTHER'), p_ctx ->> 'appVersion',
    (p_ctx ->> 'ip')::inet, p_ctx ->> 'userAgent', v_expires, v_absolute);
  update app.users set last_login_at = now() where id = p_user_id;
  return v_expires;
end $$;

create or replace function app.revoke_sessions(p_user_id bigint, p_reason text, p_except_session_id bigint)
returns void language sql set search_path = '' as $$
  update app.user_sessions set revoked_at = now(), revoked_reason = p_reason
  where user_id = p_user_id and revoked_at is null and id is distinct from p_except_session_id;
$$;

create or replace function app.option_is_active(p_type text, p_code text)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from app.lookup_options where type = p_type and code = p_code and active);
$$;

-- ---------------------------------------------------------------------------------------------
-- Infrastructure
-- ---------------------------------------------------------------------------------------------

create or replace function public.app_ping()
returns boolean language sql security definer set search_path = '' as $$
  select true;
$$;

create or replace function public.app_purge_expired()
returns void language sql security definer set search_path = '' as $$
  select app.purge_expired();
$$;

create or replace function public.app_rate_limit_hit(p_key text, p_max integer, p_window_seconds integer)
returns jsonb language sql security definer set search_path = '' as $$
  select app.rate_limit_hit(p_key, p_max, p_window_seconds);
$$;

create or replace function public.app_rate_limit_reset(p_keys text[])
returns void language sql security definer set search_path = '' as $$
  delete from app.rate_limits where key = any (p_keys);
$$;

create or replace function public.app_audit(p_ctx jsonb, p_action text, p_user_id bigint, p_metadata jsonb)
returns void language sql security definer set search_path = '' as $$
  select app.write_audit(p_ctx, p_action, p_user_id, p_metadata);
$$;

-- ---------------------------------------------------------------------------------------------
-- Sessions: the check behind every authenticated request
-- ---------------------------------------------------------------------------------------------

create or replace function public.app_member(p_user_public_id uuid, p_session_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'userId', u.id::text, 'userPublicId', u.public_id, 'sessionId', s.id::text,
    'sessionPublicId', s.public_id, 'tier', u.tier, 'requestedTier', u.requested_tier,
    'kycStatus', u.kyc_status, 'fullName', coalesce(p.name, ''))
  from app.user_sessions s
  join app.users u on u.id = s.user_id
  left join app.user_profiles p on p.user_id = u.id
  where s.public_id = p_session_public_id and u.public_id = p_user_public_id
    and s.revoked_at is null and s.expires_at > now() and s.absolute_expires_at > now()
    and u.status = 'ACTIVE';
$$;

create or replace function public.app_logout(p_user_id bigint, p_session_id bigint, p_ctx jsonb)
returns void language sql security definer set search_path = '' as $$
  update app.user_sessions set revoked_at = now(), revoked_reason = 'LOGOUT'
  where id = p_session_id and user_id = p_user_id and revoked_at is null;
  select app.write_audit(p_ctx, 'auth.logout', p_user_id, '{}'::jsonb);
$$;

create or replace function public.app_list_sessions(p_user_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', public_id, 'deviceName', device_name, 'platform', platform, 'appVersion', app_version,
      'ip', host(ip), 'createdAt', created_at, 'lastUsedAt', last_used_at)
    order by last_used_at desc), '[]'::jsonb)
  from app.user_sessions
  where user_id = p_user_id and revoked_at is null and expires_at > now() and absolute_expires_at > now();
$$;

create or replace function public.app_revoke_session(p_user_id bigint, p_session_public_id uuid, p_ctx jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update app.user_sessions set revoked_at = now(), revoked_reason = 'REVOKED_BY_USER'
  where user_id = p_user_id and public_id = p_session_public_id and revoked_at is null;
  if not found then
    return false;
  end if;
  perform app.write_audit(p_ctx, 'auth.session.revoked', p_user_id,
    jsonb_build_object('session', p_session_public_id));
  return true;
end $$;

create or replace function public.app_revoke_other_sessions(p_user_id bigint, p_keep_session_id bigint, p_ctx jsonb)
returns void language sql security definer set search_path = '' as $$
  select app.revoke_sessions(p_user_id, 'REVOKED_BY_USER', p_keep_session_id);
  select app.write_audit(p_ctx, 'auth.session.revoked', p_user_id, '{"scope": "others"}'::jsonb);
$$;

-- ---------------------------------------------------------------------------------------------
-- Sign-up, OTP and login
-- ---------------------------------------------------------------------------------------------

-- p_signup: { name, emailEnc, emailHash, countryCode, phoneEnc, phoneHash, passwordHash,
-- ttlSeconds, otpTtlSeconds }. An email or phone that is already registered gets a decoy
-- challenge; the API sends its owner a notice instead of a code.
create or replace function public.app_signup_start(
  p_signup jsonb, p_email_challenge jsonb, p_phone_challenge jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email_taken boolean;
  v_phone_taken boolean;
  v_id bigint;
  v_public_id uuid;
  v_expires timestamptz;
  v_otp_ttl integer := (p_signup ->> 'otpTtlSeconds')::integer;
begin
  select exists (select 1 from app.users where email_hash = p_signup ->> 'emailHash') into v_email_taken;
  select exists (select 1 from app.users where phone_hash = p_signup ->> 'phoneHash') into v_phone_taken;

  insert into app.signup_requests (name, email_enc, email_hash, phone_country_code, phone_enc,
    phone_hash, password_hash, age_confirmed_at, created_ip, user_agent, app_version, expires_at)
  values (p_signup ->> 'name', p_signup ->> 'emailEnc', p_signup ->> 'emailHash',
    p_signup ->> 'countryCode', p_signup ->> 'phoneEnc', p_signup ->> 'phoneHash',
    p_signup ->> 'passwordHash', now(), (p_ctx ->> 'ip')::inet, p_ctx ->> 'userAgent',
    p_ctx ->> 'appVersion', now() + make_interval(secs => (p_signup ->> 'ttlSeconds')::integer))
  returning id, public_id, expires_at into v_id, v_public_id, v_expires;

  perform app.create_challenge(p_email_challenge, 'SIGNUP', 'EMAIL', p_signup ->> 'emailHash', null,
    v_id, v_email_taken, v_otp_ttl, p_ctx);
  perform app.create_challenge(p_phone_challenge, 'SIGNUP', 'PHONE', p_signup ->> 'phoneHash', null,
    v_id, v_phone_taken, v_otp_ttl, p_ctx);
  perform app.write_audit(p_ctx, 'auth.register.started', null, jsonb_build_object('signupId', v_public_id));

  return jsonb_build_object('signupId', v_public_id, 'expiresAt', v_expires,
    'emailTaken', v_email_taken, 'phoneTaken', v_phone_taken);
end $$;

-- Login or password-reset code. Unknown and suspended accounts get a decoy, so the response never
-- reveals whether an address is registered. Only the newest code per address and purpose works.
create or replace function public.app_otp_start(
  p_purpose text, p_channel text, p_destination_hash text, p_challenge jsonb, p_ttl_seconds integer,
  p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id bigint;
begin
  if p_purpose not in ('LOGIN', 'PASSWORD_RESET') then
    raise exception 'invalid purpose %', p_purpose;
  end if;
  if p_channel = 'EMAIL' then
    select id into v_user_id from app.users where email_hash = p_destination_hash and status = 'ACTIVE';
  else
    select id into v_user_id from app.users where phone_hash = p_destination_hash and status = 'ACTIVE';
  end if;

  update app.otp_challenges set expires_at = now()
  where destination_hash = p_destination_hash and purpose = p_purpose
    and verified_at is null and expires_at > now();
  perform app.create_challenge(p_challenge, p_purpose, p_channel, p_destination_hash, v_user_id, null,
    v_user_id is null, p_ttl_seconds, p_ctx);

  if p_purpose = 'PASSWORD_RESET' then
    perform app.write_audit(p_ctx, 'auth.password.reset_requested', v_user_id,
      jsonb_build_object('channel', p_channel));
  end if;
  return jsonb_build_object('userExists', v_user_id is not null);
end $$;

-- The address a challenge belongs to (a keyed hash), so the API can apply per-address limits.
create or replace function public.app_otp_peek(p_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('destinationHash', destination_hash)
  from app.otp_challenges where public_id = p_public_id;
$$;

-- New code on an existing challenge. p_limit: { key, max, window } for the per-address send limit.
-- Returns { channel, purpose, isDecoy, destinationEnc } or { error }.
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
    if v_c.signup_request_id is not null then
      select case when v_c.channel = 'EMAIL' then email_enc else phone_enc end into v_destination
      from app.signup_requests where id = v_c.signup_request_id;
    else
      select case when v_c.channel = 'EMAIL' then email_enc else phone_enc end into v_destination
      from app.users where id = v_c.user_id;
    end if;
  end if;
  return jsonb_build_object('channel', v_c.channel, 'purpose', v_c.purpose, 'isDecoy', v_c.is_decoy,
    'destinationEnc', v_destination);
end $$;

-- Checks a code and, when it matches, finishes what the challenge was for:
--   SIGNUP          marks the address verified; once both are, creates the account and a session
--   LOGIN           creates a session
--   PASSWORD_RESET  stores a single-use reset ticket (the API returns the token)
-- p_limits: [{ key, max, window }] per-address guess limits, counted before the code is checked
-- and cleared when it matches. p_session / p_reset are prepared by the API (hashes only).
create or replace function public.app_otp_verify(
  p_public_id uuid, p_code_hash text, p_max_attempts integer, p_limits jsonb, p_session jsonb,
  p_reset jsonb, p_age_consent_version text, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_c app.otp_challenges%rowtype;
  v_s app.signup_requests%rowtype;
  v_limit jsonb;
  v_hit jsonb;
  v_email_at timestamptz;
  v_phone_at timestamptz;
  v_user_id bigint;
  v_user_public_id uuid;
  v_expires timestamptz;
begin
  select * into v_c from app.otp_challenges where public_id = p_public_id for update;
  if not found or v_c.verified_at is not null then
    return jsonb_build_object('error', 'OTP_INVALID');
  end if;
  if v_c.expires_at <= now() then
    return jsonb_build_object('error', 'OTP_EXPIRED');
  end if;
  if v_c.attempts >= p_max_attempts then
    return jsonb_build_object('error', 'OTP_ATTEMPTS_EXCEEDED');
  end if;

  -- Per address, across every challenge and IP: once used up, even a correct code is refused.
  for v_limit in select * from jsonb_array_elements(coalesce(p_limits, '[]'::jsonb)) loop
    v_hit := app.rate_limit_hit(v_limit ->> 'key', (v_limit ->> 'max')::integer, (v_limit ->> 'window')::integer);
    if (v_hit ->> 'limited')::boolean then
      return jsonb_build_object('error', 'RATE_LIMITED', 'retryAfter', v_hit -> 'retryAfter');
    end if;
  end loop;

  update app.otp_challenges set attempts = attempts + 1 where id = v_c.id;
  if v_c.is_decoy or v_c.code_hash is distinct from p_code_hash then
    perform app.write_audit(p_ctx, 'auth.otp.failed', v_c.user_id,
      jsonb_build_object('purpose', v_c.purpose, 'remaining', p_max_attempts - v_c.attempts - 1));
    return jsonb_build_object('error', 'OTP_INCORRECT', 'remaining', p_max_attempts - v_c.attempts - 1);
  end if;

  update app.otp_challenges set verified_at = now() where id = v_c.id;
  delete from app.rate_limits
  where key in (select l ->> 'key' from jsonb_array_elements(coalesce(p_limits, '[]'::jsonb)) l);

  if v_c.purpose = 'SIGNUP' then
    select * into v_s from app.signup_requests where id = v_c.signup_request_id for update;
    if not found or v_s.completed_at is not null or v_s.expires_at <= now() then
      return jsonb_build_object('error', 'SIGNUP_EXPIRED');
    end if;

    v_email_at := case when v_c.channel = 'EMAIL' then now() else v_s.email_verified_at end;
    v_phone_at := case when v_c.channel = 'PHONE' then now() else v_s.phone_verified_at end;
    update app.signup_requests set email_verified_at = v_email_at, phone_verified_at = v_phone_at
    where id = v_s.id;

    if v_email_at is null or v_phone_at is null then
      return jsonb_build_object('status', 'PENDING', 'signupId', v_s.public_id,
        'verified', to_jsonb(array_remove(array[
          case when v_email_at is not null then 'EMAIL' end,
          case when v_phone_at is not null then 'PHONE' end], null)),
        'pending', to_jsonb(array_remove(array[
          case when v_email_at is null then 'EMAIL' end,
          case when v_phone_at is null then 'PHONE' end], null)));
    end if;

    -- A conflict means someone else completed sign-up with this email or phone first; the caller
    -- has proven they own both, so saying so is safe.
    insert into app.users (email_enc, email_hash, phone_country_code, phone_enc, phone_hash,
      password_hash, email_verified_at, phone_verified_at)
    values (v_s.email_enc, v_s.email_hash, v_s.phone_country_code, v_s.phone_enc, v_s.phone_hash,
      v_s.password_hash, v_email_at, v_phone_at)
    on conflict do nothing
    returning id, public_id into v_user_id, v_user_public_id;
    if v_user_id is null then
      return jsonb_build_object('error', 'ACCOUNT_EXISTS');
    end if;

    insert into app.user_profiles (user_id, name) values (v_user_id, v_s.name);
    insert into app.consents (user_id, type, version, accepted_at, ip, user_agent, app_version)
    values (v_user_id, 'AGE_18_PLUS', p_age_consent_version, v_s.age_confirmed_at, v_s.created_ip,
      v_s.user_agent, v_s.app_version);
    -- The pending copy, and any other open sign-ups for the same email or phone, are no longer needed.
    delete from app.signup_requests
    where id = v_s.id
       or (completed_at is null and (email_hash = v_s.email_hash or phone_hash = v_s.phone_hash));

    v_expires := app.create_session(v_user_id, p_session, p_ctx);
    perform app.write_audit(p_ctx, 'auth.register.completed', v_user_id, '{}'::jsonb);
    return jsonb_build_object('status', 'COMPLETED', 'userId', v_user_id::text,
      'userPublicId', v_user_public_id, 'sessionExpiresAt', v_expires);
  end if;

  if v_c.purpose = 'LOGIN' then
    select id, public_id into v_user_id, v_user_public_id
    from app.users where id = v_c.user_id and status = 'ACTIVE' for update;
    if v_user_id is null then
      return jsonb_build_object('error', 'OTP_INVALID');
    end if;
    v_expires := app.create_session(v_user_id, p_session, p_ctx);
    perform app.write_audit(p_ctx, 'auth.otp.login', v_user_id, jsonb_build_object('channel', v_c.channel));
    return jsonb_build_object('status', 'COMPLETED', 'userId', v_user_id::text,
      'userPublicId', v_user_public_id, 'sessionExpiresAt', v_expires);
  end if;

  -- PASSWORD_RESET: only the newest reset ticket for a user is valid.
  update app.password_reset_tickets set used_at = now() where user_id = v_c.user_id and used_at is null;
  insert into app.password_reset_tickets (token_hash, user_id, challenge_id, expires_at)
  values (p_reset ->> 'tokenHash', v_c.user_id, v_c.id,
    now() + make_interval(secs => (p_reset ->> 'ttlSeconds')::integer));
  return jsonb_build_object('status', 'RESET_TOKEN_ISSUED');
end $$;

-- The account behind an email or phone hash, for the password check (done in the API).
create or replace function public.app_login_lookup(p_channel text, p_id_hash text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('userId', id::text, 'userPublicId', public_id,
    'passwordHash', password_hash, 'status', status)
  from app.users
  where status <> 'DELETED'
    and ((p_channel = 'EMAIL' and email_hash = p_id_hash) or (p_channel = 'PHONE' and phone_hash = p_id_hash));
$$;

-- After a correct password: creates the session. { error } if the account stopped being active.
create or replace function public.app_login_complete(p_user_id bigint, p_session jsonb, p_ctx jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_expires timestamptz;
begin
  perform 1 from app.users where id = p_user_id and status = 'ACTIVE' for update;
  if not found then
    return jsonb_build_object('error', 'INVALID');
  end if;
  v_expires := app.create_session(p_user_id, p_session, p_ctx);
  perform app.write_audit(p_ctx, 'auth.login.succeeded', p_user_id, '{}'::jsonb);
  return jsonb_build_object('sessionExpiresAt', v_expires);
end $$;

-- Rotates the refresh token. Presenting the previous token again means it was copied: the
-- session is revoked and the device must log in again.
create or replace function public.app_refresh(
  p_session_public_id uuid, p_secret_hash text, p_new_secret_hash text, p_idle_days integer, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_s app.user_sessions%rowtype;
  v_user_public_id uuid;
  v_user_status text;
  v_expires timestamptz;
begin
  select s.* into v_s from app.user_sessions s where s.public_id = p_session_public_id for update;
  if not found then
    return jsonb_build_object('error', 'INVALID');
  end if;
  select public_id, status into v_user_public_id, v_user_status from app.users where id = v_s.user_id;

  if v_s.previous_refresh_token_hash = p_secret_hash then
    if v_s.revoked_at is null then
      update app.user_sessions set revoked_at = now(), revoked_reason = 'TOKEN_REUSE' where id = v_s.id;
      perform app.write_audit(p_ctx, 'auth.refresh.reuse_detected', v_s.user_id,
        jsonb_build_object('session', v_s.public_id));
    end if;
    return jsonb_build_object('error', 'INVALID');
  end if;
  if v_s.refresh_token_hash <> p_secret_hash or v_s.revoked_at is not null
     or v_s.expires_at <= now() or v_s.absolute_expires_at <= now() or v_user_status <> 'ACTIVE' then
    return jsonb_build_object('error', 'INVALID');
  end if;

  v_expires := least(now() + make_interval(days => p_idle_days), v_s.absolute_expires_at);
  update app.user_sessions set
    previous_refresh_token_hash = refresh_token_hash,
    refresh_token_hash = p_new_secret_hash,
    expires_at = v_expires,
    last_used_at = now(),
    ip = (p_ctx ->> 'ip')::inet,
    user_agent = p_ctx ->> 'userAgent',
    app_version = coalesce(p_ctx ->> 'appVersion', app_version)
  where id = v_s.id;
  return jsonb_build_object('userPublicId', v_user_public_id, 'sessionExpiresAt', v_expires);
end $$;

-- The account behind a usable reset ticket, so the API can check the new password against it.
create or replace function public.app_reset_lookup(p_token_hash text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('userId', u.id::text, 'passwordHash', u.password_hash,
    'emailEnc', u.email_enc, 'phoneEnc', u.phone_enc)
  from app.password_reset_tickets t join app.users u on u.id = t.user_id
  where t.token_hash = p_token_hash and t.used_at is null and t.expires_at > now() and u.status = 'ACTIVE';
$$;

-- Sets the new password, uses up every reset ticket and ends every session.
create or replace function public.app_reset_complete(p_token_hash text, p_password_hash text, p_ctx jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id bigint;
begin
  select t.user_id into v_user_id
  from app.password_reset_tickets t join app.users u on u.id = t.user_id
  where t.token_hash = p_token_hash and t.used_at is null and t.expires_at > now() and u.status = 'ACTIVE'
  for update of t, u;
  if v_user_id is null then
    return jsonb_build_object('ok', false);
  end if;

  update app.users set password_hash = p_password_hash, password_changed_at = now() where id = v_user_id;
  update app.password_reset_tickets set used_at = now() where user_id = v_user_id and used_at is null;
  perform app.revoke_sessions(v_user_id, 'PASSWORD_RESET', null);
  perform app.write_audit(p_ctx, 'auth.password.reset', v_user_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Users, profile, preferences, tier and follows
-- ---------------------------------------------------------------------------------------------

create or replace function public.app_list_options(p_type text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'label', label) order by sort_order, label), '[]'::jsonb)
  from app.lookup_options where type = p_type and active;
$$;

-- Everything GET /me shows. Email and phone stay encrypted; the API decrypts them.
create or replace function public.app_get_user(p_user_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'publicId', u.public_id, 'emailEnc', u.email_enc, 'phoneEnc', u.phone_enc, 'tier', u.tier,
    'requestedTier', u.requested_tier, 'kycStatus', u.kyc_status, 'tierSelectedAt', u.tier_selected_at,
    'createdAt', u.created_at, 'name', p.name, 'experienceYears', p.experience_years,
    'jobProfileCode', p.job_profile_code, 'jobProfileLabel', jl.label, 'otherJob', p.other_job,
    'location', p.location, 'avatarBucket', f.bucket, 'avatarObjectKey', f.object_key,
    'followers', (select count(*) from app.follows where followee_id = u.id),
    'following', (select count(*) from app.follows where follower_id = u.id),
    'preferences', (
      select coalesce(jsonb_agg(jsonb_build_object('type', up.type, 'code', up.option_code, 'label', l.label)
        order by l.sort_order), '[]'::jsonb)
      from app.user_preferences up
      join app.lookup_options l on l.type = up.type and l.code = up.option_code
      where up.user_id = u.id))
  from app.users u
  join app.user_profiles p on p.user_id = u.id
  left join app.lookup_options jl on jl.type = 'JOB_PROFILE' and jl.code = p.job_profile_code
  left join app.files f on f.id = p.avatar_file_id
  where u.id = p_user_id;
$$;

-- Sign-up step 2 and later profile edits. p_changes holds only the fields being changed:
-- name, experienceYears, jobProfile, otherJob, location, avatarFileId (internal file id).
-- Returns { ok } or { error: 'NOT_FOUND' } or { fields } with one message per invalid field.
create or replace function public.app_update_profile(p_user_id bigint, p_changes jsonb, p_ctx jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_current app.user_profiles%rowtype;
  v_job text;
  v_other text;
  v_avatar bigint := (p_changes ->> 'avatarFileId')::bigint;
begin
  select * into v_current from app.user_profiles where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;

  if p_changes ? 'jobProfile' and not app.option_is_active('JOB_PROFILE', p_changes ->> 'jobProfile') then
    return jsonb_build_object('fields', jsonb_build_object('jobProfile', 'Unknown option: ' || (p_changes ->> 'jobProfile')));
  end if;
  v_job := coalesce(p_changes ->> 'jobProfile', v_current.job_profile_code);

  if v_job = 'OTHERS' then
    v_other := coalesce(p_changes ->> 'otherJob', v_current.other_job);
    if v_other is null then
      return jsonb_build_object('fields', jsonb_build_object('otherJob', 'Specify your job profile'));
    end if;
  elsif p_changes ? 'otherJob' then
    return jsonb_build_object('fields', jsonb_build_object('otherJob', 'Only allowed when the job profile is Others'));
  end if;

  if v_avatar is not null and not exists (
    select 1 from app.files where id = v_avatar and owner_id = p_user_id and purpose = 'AVATAR'
  ) then
    return jsonb_build_object('fields', jsonb_build_object('avatarFileId', 'Upload the avatar with purpose AVATAR first'));
  end if;

  update app.user_profiles set
    name = coalesce(p_changes ->> 'name', name),
    experience_years = coalesce((p_changes ->> 'experienceYears')::smallint, experience_years),
    job_profile_code = v_job,
    other_job = v_other,
    location = coalesce(p_changes ->> 'location', location),
    avatar_file_id = coalesce(v_avatar, avatar_file_id)
  where user_id = p_user_id;
  perform app.write_audit(p_ctx, 'user.profile.updated', p_user_id,
    jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p_changes) k)));
  return jsonb_build_object('ok', true);
end $$;

-- Sign-up step 3. p_groups: [{ type, field, codes: [...] }] for the four preference types.
-- Replaces all preferences. Returns { ok } or { fields } naming the first unknown option.
create or replace function public.app_set_preferences(p_user_id bigint, p_groups jsonb, p_ctx jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_group jsonb;
  v_code text;
begin
  -- Serialises concurrent updates for the same user.
  perform 1 from app.users where id = p_user_id for update;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;

  for v_group in select * from jsonb_array_elements(p_groups) loop
    for v_code in select * from jsonb_array_elements_text(v_group -> 'codes') loop
      if not app.option_is_active(v_group ->> 'type', v_code) then
        return jsonb_build_object('fields', jsonb_build_object(v_group ->> 'field', 'Unknown option: ' || v_code));
      end if;
    end loop;
  end loop;

  delete from app.user_preferences where user_id = p_user_id;
  insert into app.user_preferences (user_id, type, option_code)
  select p_user_id, g ->> 'type', c
  from jsonb_array_elements(p_groups) g, jsonb_array_elements_text(g -> 'codes') c;
  perform app.write_audit(p_ctx, 'user.preferences.updated', p_user_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;

-- Observer is granted at once. Prive and Institutional are recorded as requested and granted only
-- when KYC is approved, never here. Blocked while KYC is under review for the requested tier.
create or replace function public.app_select_tier(p_user_id bigint, p_tier text, p_ctx jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u app.users%rowtype;
  v_to text;
  v_requested text;
begin
  if p_tier not in ('OBSERVER', 'PRIVE', 'INSTITUTIONAL') then
    raise exception 'invalid tier %', p_tier;
  end if;
  select * into v_u from app.users where id = p_user_id for update;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if v_u.kyc_status = 'PENDING' and p_tier <> coalesce(v_u.requested_tier, v_u.tier) then
    return jsonb_build_object('error', 'KYC_PENDING');
  end if;
  if not exists (
    select 1 from app.user_profiles
    where user_id = p_user_id and experience_years is not null and job_profile_code is not null and location is not null
  ) or (
    select count(distinct up.type) from app.user_preferences up
    join app.lookup_options l on l.type = up.type and l.code = up.option_code
    where up.user_id = p_user_id
  ) < 4 then
    return jsonb_build_object('error', 'ONBOARDING_INCOMPLETE');
  end if;

  v_to := case when p_tier = 'OBSERVER' then 'OBSERVER' else v_u.tier end;
  v_requested := case when p_tier = 'OBSERVER' or p_tier = v_u.tier then null else p_tier end;

  if v_to <> v_u.tier or v_requested is distinct from v_u.requested_tier or v_u.tier_selected_at is null then
    update app.users set tier = v_to, requested_tier = v_requested,
      tier_selected_at = coalesce(tier_selected_at, now())
    where id = p_user_id;
    insert into app.tier_history (user_id, from_tier, to_tier, requested_tier, reason)
    values (p_user_id, v_u.tier, v_to, v_requested, 'USER_SELECTED');
    perform app.write_audit(p_ctx, 'user.tier.selected', p_user_id,
      jsonb_build_object('from', v_u.tier, 'to', v_to, 'requested', v_requested));
  end if;
  return jsonb_build_object('ok', true, 'requestedTier', v_requested);
end $$;

-- An active user with the profile fields other members may see (no email, phone or KYC detail).
create or replace function public.app_public_user(p_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', u.id::text, 'publicId', u.public_id, 'tier', u.tier,
    'kycStatus', u.kyc_status, 'createdAt', u.created_at, 'name', p.name, 'location', p.location,
    'avatarBucket', f.bucket, 'avatarObjectKey', f.object_key)
  from app.users u
  join app.user_profiles p on p.user_id = u.id
  left join app.files f on f.id = p.avatar_file_id
  where u.public_id = p_public_id and u.status = 'ACTIVE';
$$;

create or replace function public.app_count_follows(p_user_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'followers', (select count(*) from app.follows where followee_id = p_user_id),
    'following', (select count(*) from app.follows where follower_id = p_user_id));
$$;

create or replace function public.app_follow(p_follower_id bigint, p_followee_id bigint)
returns void language sql security definer set search_path = '' as $$
  insert into app.follows (follower_id, followee_id) values (p_follower_id, p_followee_id)
  on conflict do nothing;
$$;

create or replace function public.app_unfollow(p_follower_id bigint, p_followee_id bigint)
returns void language sql security definer set search_path = '' as $$
  delete from app.follows where follower_id = p_follower_id and followee_id = p_followee_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- Files and KYC
-- ---------------------------------------------------------------------------------------------

create or replace function public.app_create_file(
  p_owner_id bigint, p_purpose text, p_bucket text, p_object_key text, p_mime_type text, p_size_bytes integer
) returns jsonb language sql security definer set search_path = '' as $$
  insert into app.files (owner_id, purpose, bucket, object_key, mime_type, size_bytes)
  values (p_owner_id, p_purpose, p_bucket, p_object_key, p_mime_type, p_size_bytes)
  returning jsonb_build_object('id', id::text, 'publicId', public_id, 'purpose', purpose,
    'bucket', bucket, 'objectKey', object_key, 'mimeType', mime_type, 'sizeBytes', size_bytes);
$$;

-- Files with the given public IDs that belong to the owner; unknown or foreign IDs are omitted.
create or replace function public.app_find_owned_files(p_owner_id bigint, p_public_ids uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id::text, 'publicId', public_id, 'purpose', purpose,
    'bucket', bucket, 'objectKey', object_key, 'mimeType', mime_type, 'sizeBytes', size_bytes)), '[]'::jsonb)
  from app.files where owner_id = p_owner_id and public_id = any (p_public_ids);
$$;

-- Saves the submission, its documents and consent, and marks the user PENDING, atomically.
-- p_documents: [{ fileId (internal), documentType }]. A second open submission violates the
-- one-pending index (SQLSTATE 23505).
create or replace function public.app_kyc_submit(
  p_user_id bigint, p_tier text, p_documents jsonb, p_consent_version text, p_ctx jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
  v_public_id uuid;
begin
  -- The API checked these already; checked again so no caller can attach someone else's file.
  if exists (
    select 1 from jsonb_array_elements(p_documents) d
    where not exists (
      select 1 from app.files f
      where f.id = (d ->> 'fileId')::bigint and f.owner_id = p_user_id and f.purpose = 'KYC_DOCUMENT'
    )
  ) then
    raise exception 'KYC document does not belong to the user';
  end if;

  insert into app.kyc_submissions (user_id, tier) values (p_user_id, p_tier)
  returning id, public_id into v_id, v_public_id;
  insert into app.kyc_documents (submission_id, file_id, document_type)
  select v_id, (d ->> 'fileId')::bigint, d ->> 'documentType' from jsonb_array_elements(p_documents) d;

  if p_consent_version is not null then
    insert into app.consents (user_id, type, version, accepted_at, ip, user_agent, app_version)
    values (p_user_id, 'KYC', p_consent_version, now(), (p_ctx ->> 'ip')::inet, p_ctx ->> 'userAgent',
      p_ctx ->> 'appVersion');
  end if;
  update app.users set kyc_status = 'PENDING' where id = p_user_id;
  perform app.write_audit(p_ctx, 'kyc.submitted', p_user_id,
    jsonb_build_object('submission', v_public_id, 'tier', p_tier));
  return v_public_id;
end $$;

create or replace function public.app_kyc_latest(p_user_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('publicId', s.public_id, 'tier', s.tier, 'status', s.status,
    'reason', s.reason, 'submittedAt', s.created_at, 'reviewedAt', s.reviewed_at,
    'documents', (
      select coalesce(jsonb_agg(jsonb_build_object('fileId', f.public_id, 'documentType', d.document_type)), '[]'::jsonb)
      from app.kyc_documents d join app.files f on f.id = d.file_id
      where d.submission_id = s.id))
  from app.kyc_submissions s
  where s.user_id = p_user_id
  order by s.created_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------------------------

-- Internal helpers: never callable directly.
revoke execute on all functions in schema app from public;

-- The public.app_* functions: the service role only.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
