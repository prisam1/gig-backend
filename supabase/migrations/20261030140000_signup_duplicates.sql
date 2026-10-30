-- Sign-up tells the user when the email or phone already belongs to an account ("already registered
-- with another account"), on step 1 (POST /auth/register/check) and again when the account is
-- requested (POST /auth/register, in case it was registered in between). A taken address no longer
-- gets a decoy sign-up: nothing is stored and no code is created. Both requests are rate limited
-- per IP by the API.

-- Which of the two addresses already belong to an account (any status: they stay unique).
create or replace function public.app_contact_taken(p_email_hash text, p_phone_hash text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'emailTaken', exists (select 1 from app.users where email_hash = p_email_hash),
    'phoneTaken', exists (select 1 from app.users where phone_hash = p_phone_hash));
$$;

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

  perform app.create_challenge(p_email_challenge, 'SIGNUP', 'EMAIL', p_signup ->> 'emailHash', null,
    v_id, false, v_otp_ttl, p_ctx);
  perform app.create_challenge(p_phone_challenge, 'SIGNUP', 'PHONE', p_signup ->> 'phoneHash', null,
    v_id, false, v_otp_ttl, p_ctx);
  perform app.write_audit(p_ctx, 'auth.register.started', null, jsonb_build_object('signupId', v_public_id));

  return jsonb_build_object('signupId', v_public_id, 'expiresAt', v_expires);
end $$;

revoke execute on all functions in schema app from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
