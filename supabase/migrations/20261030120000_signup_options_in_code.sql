-- The sign-up choices (job profile, investment focus, risk level, style, sector) are fixed lists in
-- the app, and the API accepts exactly their codes (src/constants/onboarding.ts). The database no
-- longer keeps a copy of the lists or their labels: it stores only the codes each user chose, and
-- the app shows its own label for each code. Works whether or not 20261030090000 has run.

-- 1. A user's choices no longer point at option rows; they keep the code only.
alter table app.user_profiles drop constraint user_profiles_job_profile_type_job_profile_code_fkey;
alter table app.user_profiles drop column job_profile_type;
alter table app.user_profiles add constraint user_profiles_job_profile_code_check
  check (job_profile_code ~ '^[A-Z0-9_]{1,64}$');

alter table app.user_preferences drop constraint user_preferences_type_option_code_fkey;
alter table app.user_preferences add constraint user_preferences_option_code_check
  check (option_code ~ '^[A-Z0-9_]{1,64}$');

-- 2. Functions that checked codes against the rows or joined their labels. The API validates every
--    code before it reaches the database.

-- Everything GET /me shows. Email and phone stay encrypted; the API decrypts them.
create or replace function public.app_get_user(p_user_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'publicId', u.public_id, 'emailEnc', u.email_enc, 'phoneEnc', u.phone_enc, 'tier', u.tier,
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

-- Profile edits (PATCH /me). p_changes holds only the fields being changed:
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

-- Field errors for the onboarding part of a registration, or null when it is valid or absent.
-- Keys are request paths, e.g. "profile.otherJob".
create or replace function app.signup_onboarding_errors(p_onboarding jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_profile jsonb := p_onboarding -> 'profile';
  v_job text := v_profile ->> 'jobProfile';
begin
  if p_onboarding is null or v_profile is null then
    return null;
  end if;
  if v_job = 'OTHERS' and v_profile ->> 'otherJob' is null then
    return jsonb_build_object('profile.otherJob', 'Specify your job profile');
  end if;
  if v_job <> 'OTHERS' and v_profile ? 'otherJob' then
    return jsonb_build_object('profile.otherJob', 'Only allowed when the job profile is Others');
  end if;
  return null;
end $$;

drop function app.option_is_active(text, text);

-- 3. The option rows go. app.lookup_options keeps only the lists other features still read
--    (rating factors, risk factors, investor types).
delete from app.lookup_options where type in (
  'JOB_PROFILE', 'INVESTMENT_FOCUS', 'RISK_LEVEL', 'INVESTMENT_STYLE', 'INVESTMENT_SECTOR', 'TIER', 'COUNTRY_CODE'
);
alter table app.lookup_options drop constraint lookup_options_type_check;
alter table app.lookup_options add constraint lookup_options_type_check
  check (type in ('RATING_FACTOR', 'RISK_FACTOR', 'INVESTOR_TYPE'));
alter table app.lookup_options drop constraint lookup_options_code_check;
alter table app.lookup_options add constraint lookup_options_code_check check (code ~ '^[A-Z0-9_]{1,64}$');
