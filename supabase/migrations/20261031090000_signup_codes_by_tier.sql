-- Which codes a sign-up needs follows the app's screens for the chosen tier:
--   Observer       email and phone codes (unchanged)
--   Prive          phone code only
--   Institutional  no code: the account is created when the registration is sent
-- The API decides which codes to issue; a sign-up is complete once every code it was given is
-- verified. An account therefore no longer always has a verified email and phone.

alter table app.users
  alter column email_verified_at drop not null,
  alter column phone_verified_at drop not null;

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
  insert into app.users (email_enc, email_hash, phone_country_code, phone_enc, phone_hash,
    password_hash, email_verified_at, phone_verified_at)
  values (v_s.email_enc, v_s.email_hash, v_s.phone_country_code, v_s.phone_enc, v_s.phone_hash,
    v_s.password_hash, v_s.email_verified_at, v_s.phone_verified_at)
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
     or (completed_at is null and (email_hash = v_s.email_hash or phone_hash = v_s.phone_hash));

  v_expires := app.create_session(v_user_id, p_session, p_ctx);
  perform app.write_audit(p_ctx, 'auth.register.completed', v_user_id, jsonb_build_object(
    'emailVerified', v_s.email_verified_at is not null, 'phoneVerified', v_s.phone_verified_at is not null));
  return jsonb_build_object('status', 'COMPLETED', 'userId', v_user_id::text,
    'userPublicId', v_user_public_id, 'sessionExpiresAt', v_expires);
end $$;

-- Same as before, except that either challenge may be left out (null): no code is created for it.
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
  v_errors jsonb := app.signup_onboarding_errors(p_signup -> 'onboarding');
begin
  if v_errors is not null then
    return jsonb_build_object('fields', v_errors);
  end if;

  select exists (select 1 from app.users where email_hash = p_signup ->> 'emailHash') into v_email_taken;
  select exists (select 1 from app.users where phone_hash = p_signup ->> 'phoneHash') into v_phone_taken;
  if v_email_taken or v_phone_taken then
    perform app.write_audit(p_ctx, 'auth.register.duplicate', null,
      jsonb_build_object('emailTaken', v_email_taken, 'phoneTaken', v_phone_taken));
    return jsonb_build_object('taken', jsonb_build_object('email', v_email_taken, 'phone', v_phone_taken));
  end if;

  insert into app.signup_requests (name, email_enc, email_hash, phone_country_code, phone_enc,
    phone_hash, password_hash, age_confirmed_at, created_ip, user_agent, app_version, expires_at, onboarding)
  values (p_signup ->> 'name', p_signup ->> 'emailEnc', p_signup ->> 'emailHash',
    p_signup ->> 'countryCode', p_signup ->> 'phoneEnc', p_signup ->> 'phoneHash',
    p_signup ->> 'passwordHash', now(), (p_ctx ->> 'ip')::inet, p_ctx ->> 'userAgent',
    p_ctx ->> 'appVersion', now() + make_interval(secs => (p_signup ->> 'ttlSeconds')::integer),
    p_signup -> 'onboarding')
  returning id, public_id, expires_at into v_id, v_public_id, v_expires;

  if p_email_challenge is not null then
    perform app.create_challenge(p_email_challenge, 'SIGNUP', 'EMAIL', p_signup ->> 'emailHash', null,
      v_id, false, v_otp_ttl, p_ctx);
  end if;
  if p_phone_challenge is not null then
    perform app.create_challenge(p_phone_challenge, 'SIGNUP', 'PHONE', p_signup ->> 'phoneHash', null,
      v_id, false, v_otp_ttl, p_ctx);
  end if;
  perform app.write_audit(p_ctx, 'auth.register.started', null, jsonb_build_object('signupId', v_public_id));

  return jsonb_build_object('signupId', v_public_id, 'expiresAt', v_expires);
end $$;

-- Institutional: a sign-up that needs no code. Stores it and creates the account at once.
create or replace function public.app_signup_create(
  p_signup jsonb, p_session jsonb, p_age_consent_version text, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_started jsonb;
  v_id bigint;
begin
  v_started := public.app_signup_start(p_signup, null, null, p_ctx);
  if not v_started ? 'signupId' then
    return v_started;
  end if;
  select id into v_id from app.signup_requests where public_id = (v_started ->> 'signupId')::uuid for update;
  return app.complete_signup(v_id, p_session, p_age_consent_version, p_ctx);
end $$;

-- Same as before, except that a sign-up is complete once every code it was given is verified
-- (both for Observer, the phone code for Prive).
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
  v_needs_email boolean;
  v_needs_phone boolean;
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

    -- Only the codes this sign-up was given are needed.
    select exists (select 1 from app.otp_challenges where signup_request_id = v_s.id and channel = 'EMAIL'),
           exists (select 1 from app.otp_challenges where signup_request_id = v_s.id and channel = 'PHONE')
    into v_needs_email, v_needs_phone;

    if (v_needs_email and v_email_at is null) or (v_needs_phone and v_phone_at is null) then
      return jsonb_build_object('status', 'PENDING', 'signupId', v_s.public_id,
        'verified', to_jsonb(array_remove(array[
          case when v_email_at is not null then 'EMAIL' end,
          case when v_phone_at is not null then 'PHONE' end], null)),
        'pending', to_jsonb(array_remove(array[
          case when v_needs_email and v_email_at is null then 'EMAIL' end,
          case when v_needs_phone and v_phone_at is null then 'PHONE' end], null)));
    end if;

    return app.complete_signup(v_s.id, p_session, p_age_consent_version, p_ctx);
  end if;

  -- PASSWORD_RESET: only the newest reset ticket for a user is valid.
  update app.password_reset_tickets set used_at = now() where user_id = v_c.user_id and used_at is null;
  insert into app.password_reset_tickets (token_hash, user_id, challenge_id, expires_at)
  values (p_reset ->> 'tokenHash', v_c.user_id, v_c.id,
    now() + make_interval(secs => (p_reset ->> 'ttlSeconds')::integer));
  return jsonb_build_object('status', 'RESET_TOKEN_ISSUED');
end $$;

revoke execute on all functions in schema app from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
