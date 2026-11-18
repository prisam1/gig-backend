-- The profile screens and the Top Rated lists show content the app used to hold itself:
-- 1. Each member's "About me" text and "Positive experience" score, on their profile (served on
--    GET /me). Members start with the text and score the app showed.
-- 2. The Top Rated rows' person line and the "View Details" card, served whole from
--    GET /content/toprated.card.

alter table app.user_profiles
  add column about_me text not null default
    'Passionate about supporting ambitious founders and scalable business ideas. I believe in long-term value creation through strategic guidance, networking opportunities, and capital support.'
    check (char_length(about_me) <= 1000),
  add column positive_experience numeric(2, 1) not null default 4.8
    check (positive_experience between 0 and 5);

create or replace function public.app_get_user(p_user_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'publicId', u.public_id, 'email', u.email, 'phone', u.phone, 'tier', u.tier,
    'requestedTier', u.requested_tier, 'kycStatus', u.kyc_status, 'tierSelectedAt', u.tier_selected_at,
    'createdAt', u.created_at, 'name', p.name, 'experienceYears', p.experience_years,
    'jobProfileCode', p.job_profile_code, 'otherJob', p.other_job,
    'location', p.location, 'avatarBucket', f.bucket, 'avatarObjectKey', f.object_key,
    'aboutMe', p.about_me, 'positiveExperience', p.positive_experience::float8,
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

insert into public.app_content (key, value) values
('toprated.card', $json${
  "personName": "Rakesh Gupta",
  "fallbackName": "Zenith Capital",
  "location": "INDIA",
  "fields": ["Insurance", "Nexa", "", "2026"],
  "rating": "4.0",
  "sentiment": "POSITIVE",
  "tags": ["Transparent Communication", "Digital Experience", "Ease of boarding", "Ethical conduct"],
  "experience": "Genuine experience and factual knowledge.",
  "investAgain": "MAYBE",
  "metrics": [
    { "label": "TRANSPARENCY", "value": "4.0" },
    { "label": "EASEOFPROCESS", "value": "2.0" },
    { "label": "RESPONSIVENESS", "value": "2.0" },
    { "label": "TRUSTWORTHINESS", "value": "2.0" },
    { "label": "OVERALLSATISFACTION", "value": "3.0" }
  ],
  "resolution": "CONTACTED"
}$json$::jsonb)
on conflict (key) do update set value = excluded.value;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
