-- Forgot password tells the user when no account has the email or phone ("create your account"),
-- so an unknown address no longer gets a decoy challenge: nothing is created, and the API answers
-- 404 ACCOUNT_NOT_FOUND. The request is still rate limited per IP and per address (API) and audited.
-- Suspended and deleted accounts count as not found.

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

  if v_user_id is null then
    perform app.write_audit(p_ctx, 'auth.password.reset_unknown_account', null,
      jsonb_build_object('channel', p_channel));
    return jsonb_build_object('userExists', false);
  end if;

  -- Only the newest code per address works.
  update app.otp_challenges set expires_at = now()
  where destination_hash = p_destination_hash and purpose = p_purpose
    and verified_at is null and expires_at > now();
  perform app.create_challenge(p_challenge, p_purpose, p_channel, p_destination_hash, v_user_id, null,
    false, p_ttl_seconds, p_ctx);

  perform app.write_audit(p_ctx, 'auth.password.reset_requested', v_user_id,
    jsonb_build_object('channel', p_channel));
  return jsonb_build_object('userExists', true);
end $$;
