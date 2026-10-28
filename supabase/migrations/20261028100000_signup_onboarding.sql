-- Sign-up in the app's order: the app collects personal details, professional details, investment
-- details and the tier, and only then shows the email + phone OTP screen. POST /auth/register can
-- now carry steps 2-3 and the tier; they wait on the pending sign-up and are applied in the same
-- transaction that creates the account, once both codes are verified. Sending them is optional:
-- PATCH /me, PUT /me/preferences and PUT /me/tier still work after sign-up.

alter table app.signup_requests add column onboarding jsonb;

-- Field errors for the onboarding part of a registration (same rules as the /me endpoints), or
-- null when it is valid or absent. Keys are request paths, e.g. "profile.jobProfile".
create or replace function app.signup_onboarding_errors(p_onboarding jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_profile jsonb := p_onboarding -> 'profile';
  v_job text := v_profile ->> 'jobProfile';
  v_group record;
  v_code text;
begin
  if p_onboarding is null then
    return null;
  end if;

  if v_profile is not null then
    if not app.option_is_active('JOB_PROFILE', v_job) then
      return jsonb_build_object('profile.jobProfile', 'Unknown option: ' || coalesce(v_job, ''));
    end if;
    if v_job = 'OTHERS' and v_profile ->> 'otherJob' is null then
      return jsonb_build_object('profile.otherJob', 'Specify your job profile');
    end if;
    if v_job <> 'OTHERS' and v_profile ? 'otherJob' then
      return jsonb_build_object('profile.otherJob', 'Only allowed when the job profile is Others');
    end if;
  end if;

  for v_group in
    select * from (values ('focus', 'INVESTMENT_FOCUS'), ('risk', 'RISK_LEVEL'),
                          ('style', 'INVESTMENT_STYLE'), ('sector', 'INVESTMENT_SECTOR')) g(field, type)
  loop
    for v_code in select jsonb_array_elements_text(coalesce(p_onboarding -> 'preferences' -> v_group.field, '[]'::jsonb)) loop
      if not app.option_is_active(v_group.type, v_code) then
        return jsonb_build_object('preferences.' || v_group.field, 'Unknown option: ' || v_code);
      end if;
    end loop;
  end loop;
  return null;
end $$;

-- Applies a registration's steps 2-3 and tier to the account just created (inside app_otp_verify).
-- Prive and Institutional are only requested; they are granted when KYC is approved.
create or replace function app.apply_signup_onboarding(p_user_id bigint, p_onboarding jsonb, p_ctx jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  v_profile jsonb := p_onboarding -> 'profile';
  v_tier text := p_onboarding ->> 'tier';
  v_requested text;
begin
  if p_onboarding is null then
    return;
  end if;

  if v_profile is not null then
    update app.user_profiles set
      experience_years = (v_profile ->> 'experienceYears')::smallint,
      job_profile_code = v_profile ->> 'jobProfile',
      other_job = v_profile ->> 'otherJob',
      location = v_profile ->> 'location'
    where user_id = p_user_id;
  end if;

  insert into app.user_preferences (user_id, type, option_code)
  select p_user_id, g.type, c
  from (values ('focus', 'INVESTMENT_FOCUS'), ('risk', 'RISK_LEVEL'),
               ('style', 'INVESTMENT_STYLE'), ('sector', 'INVESTMENT_SECTOR')) g(field, type),
       jsonb_array_elements_text(coalesce(p_onboarding -> 'preferences' -> g.field, '[]'::jsonb)) c;

  if v_tier is not null then
    v_requested := case when v_tier = 'OBSERVER' then null else v_tier end;
    update app.users set requested_tier = v_requested, tier_selected_at = now() where id = p_user_id;
    insert into app.tier_history (user_id, from_tier, to_tier, requested_tier, reason)
    values (p_user_id, 'OBSERVER', 'OBSERVER', v_requested, 'USER_SELECTED');
    perform app.write_audit(p_ctx, 'user.tier.selected', p_user_id,
      jsonb_build_object('from', 'OBSERVER', 'to', 'OBSERVER', 'requested', v_requested));
  end if;
end $$;

-- Same as before, plus: refuses invalid onboarding data before anything is stored or sent, and
-- keeps it on the pending sign-up. Returns { fields } on invalid onboarding data.
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

  insert into app.signup_requests (name, email_enc, email_hash, phone_country_code, phone_enc,
    phone_hash, password_hash, age_confirmed_at, created_ip, user_agent, app_version, expires_at, onboarding)
  values (p_signup ->> 'name', p_signup ->> 'emailEnc', p_signup ->> 'emailHash',
    p_signup ->> 'countryCode', p_signup ->> 'phoneEnc', p_signup ->> 'phoneHash',
    p_signup ->> 'passwordHash', now(), (p_ctx ->> 'ip')::inet, p_ctx ->> 'userAgent',
    p_ctx ->> 'appVersion', now() + make_interval(secs => (p_signup ->> 'ttlSeconds')::integer),
    p_signup -> 'onboarding')
  returning id, public_id, expires_at into v_id, v_public_id, v_expires;

  perform app.create_challenge(p_email_challenge, 'SIGNUP', 'EMAIL', p_signup ->> 'emailHash', null,
    v_id, v_email_taken, v_otp_ttl, p_ctx);
  perform app.create_challenge(p_phone_challenge, 'SIGNUP', 'PHONE', p_signup ->> 'phoneHash', null,
    v_id, v_phone_taken, v_otp_ttl, p_ctx);
  perform app.write_audit(p_ctx, 'auth.register.started', null, jsonb_build_object('signupId', v_public_id));

  return jsonb_build_object('signupId', v_public_id, 'expiresAt', v_expires,
    'emailTaken', v_email_taken, 'phoneTaken', v_phone_taken);
end $$;

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

revoke execute on all functions in schema app from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- The health check only reads; marking it stable lets the API retry it after a network failure.
alter function public.app_ping() stable;
