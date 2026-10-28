-- Removes what the mobile app has no screen for (checked against every screen of the GIG app):
--   OTP login (the app signs in with email/phone + password only), session listing and revoking,
--   replacing preferences or the tier after sign-up (register carries them), public profiles and
--   follows, "my KYC submission", "my ratings", learn ratings, the notification inbox and push
--   tokens.
-- Kept: the follows table (GET /me still shows follower counts) and the notifications table
-- (admin decisions, credit grants and Pool joins still write to it, ready for an inbox screen).

-- ---------------------------------------------------------------------------------------------
-- OTP login
-- ---------------------------------------------------------------------------------------------

delete from app.otp_challenges where purpose = 'LOGIN';
alter table app.otp_challenges drop constraint otp_challenges_purpose_check;
alter table app.otp_challenges
  add constraint otp_challenges_purpose_check check (purpose in ('SIGNUP', 'PASSWORD_RESET'));

-- Only password resets start a challenge outside sign-up. Unknown and suspended accounts get a
-- decoy challenge, so the response never reveals whether an email or phone is registered.
create or replace function public.app_otp_start(
  p_purpose text, p_channel text, p_destination_hash text, p_challenge jsonb, p_ttl_seconds integer,
  p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id bigint;
begin
  if p_purpose is distinct from 'PASSWORD_RESET' then
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

  perform app.write_audit(p_ctx, 'auth.password.reset_requested', v_user_id,
    jsonb_build_object('channel', p_channel));
  return jsonb_build_object('userExists', v_user_id is not null);
end $$;

-- Sign-up and password reset only (the LOGIN branch is gone).
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

  -- PASSWORD_RESET: only the newest reset ticket for a user is valid.
  update app.password_reset_tickets set used_at = now() where user_id = v_c.user_id and used_at is null;
  insert into app.password_reset_tickets (token_hash, user_id, challenge_id, expires_at)
  values (p_reset ->> 'tokenHash', v_c.user_id, v_c.id,
    now() + make_interval(secs => (p_reset ->> 'ttlSeconds')::integer));
  return jsonb_build_object('status', 'RESET_TOKEN_ISSUED');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Functions whose endpoints are removed
-- ---------------------------------------------------------------------------------------------

drop function public.app_list_sessions(bigint);
drop function public.app_revoke_session(bigint, uuid, jsonb);
drop function public.app_revoke_other_sessions(bigint, bigint, jsonb);
drop function public.app_set_preferences(bigint, jsonb, jsonb);
drop function public.app_select_tier(bigint, text, jsonb);
drop function public.app_public_user(uuid);
drop function public.app_count_follows(bigint);
drop function public.app_follow(bigint, bigint);
drop function public.app_unfollow(bigint, bigint);
drop function public.app_kyc_latest(bigint);
drop function public.app_ratings_mine(bigint, text[], integer, integer);

-- ---------------------------------------------------------------------------------------------
-- Tables nothing reads or writes any more
-- ---------------------------------------------------------------------------------------------

drop table public.device_tokens;
-- learn_items keeps its rating_avg / rating_count columns (shown on the cards).
drop table public.learn_ratings;
drop function public.learn_ratings_refresh_stats();

revoke execute on all functions in schema app from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
