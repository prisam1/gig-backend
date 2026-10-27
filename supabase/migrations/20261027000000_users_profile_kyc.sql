-- Users, profile and KYC.
-- Only the API (service role) reads these tables: RLS is enabled with no policies,
-- so the anon and authenticated keys used by the mobile app cannot touch them directly.

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Enumerations: Supabase type generation turns these into TypeScript unions --

create type membership_tier       as enum ('OBSERVER', 'PRIVE', 'INSTITUTIONAL');
-- Tiers that need an approved KYC submission.
create type verified_tier         as enum ('PRIVE', 'INSTITUTIONAL');
create type kyc_status            as enum ('NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED');
create type kyc_submission_status as enum ('PENDING', 'APPROVED', 'REJECTED');
create type kyc_document_type     as enum ('ID_PROOF', 'ADDRESS_PROOF', 'TAX_ID',
                                           'INCORPORATION_CERTIFICATE', 'AUTHORISATION_LETTER');
create type user_status           as enum ('ACTIVE', 'SUSPENDED');
create type file_purpose          as enum ('AVATAR', 'KYC_DOCUMENT', 'REVIEW_EVIDENCE');
create type file_scan_status      as enum ('PENDING', 'CLEAN', 'INFECTED');
create type preference_type       as enum ('FOCUS', 'RISK', 'STYLE', 'SECTOR');
create type lookup_type           as enum ('JOB_PROFILE', 'FOCUS', 'RISK', 'STYLE', 'SECTOR',
                                           'ASSET_CLASS', 'APPRECIATION_TAG', 'CONCERN_TAG',
                                           'RATING_FACTOR', 'RISK_FACTOR', 'INVESTOR_TYPE');

-- Identity ------------------------------------------------------------------

create table users (
  id             bigint generated always as identity primary key,
  public_id      uuid not null unique default gen_random_uuid(),
  auth_user_id   uuid not null unique references auth.users (id) on delete cascade,
  email          text,
  phone          text,
  tier           membership_tier not null default 'OBSERVER',
  -- Tier the user chose but that still needs KYC approval.
  requested_tier verified_tier,
  kyc_status     kyc_status not null default 'NOT_STARTED',
  status         user_status not null default 'ACTIVE',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger users_updated_at before update on users
  for each row execute function set_updated_at();

create table files (
  id           bigint generated always as identity primary key,
  public_id    uuid not null unique default gen_random_uuid(),
  owner_id     bigint not null references users (id) on delete cascade,
  purpose      file_purpose not null,
  bucket       text not null,
  object_key   text not null unique,
  mime_type    text not null,
  size_bytes   integer not null check (size_bytes > 0),
  scan_status  file_scan_status not null default 'PENDING',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index files_owner_idx on files (owner_id);
create trigger files_updated_at before update on files
  for each row execute function set_updated_at();

create table user_profiles (
  user_id         bigint primary key references users (id) on delete cascade,
  name            text check (char_length(name) >= 4),
  avatar_file_id  bigint references files (id) on delete set null,
  experience      text,
  job_profile     text,
  other_job       text,
  location        text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger user_profiles_updated_at before update on user_profiles
  for each row execute function set_updated_at();

create table user_preferences (
  user_id      bigint not null references users (id) on delete cascade,
  type         preference_type not null,
  option_code  text not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, type, option_code)
);

create table follows (
  follower_id  bigint not null references users (id) on delete cascade,
  followee_id  bigint not null references users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);

create index follows_followee_idx on follows (followee_id);

-- Lookups -------------------------------------------------------------------

create table lookup_options (
  type        lookup_type not null,
  code        text not null,
  label       text not null,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  primary key (type, code)
);

-- Verification --------------------------------------------------------------

create table kyc_submissions (
  id            bigint generated always as identity primary key,
  public_id     uuid not null unique default gen_random_uuid(),
  user_id       bigint not null references users (id) on delete cascade,
  tier          verified_tier not null,
  status        kyc_submission_status not null default 'PENDING',
  provider      text not null default 'MANUAL',
  reference     text,
  reviewer_id   bigint references users (id),
  reason        text,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index kyc_submissions_user_idx on kyc_submissions (user_id, created_at desc);
-- At most one open submission per user.
create unique index kyc_submissions_one_pending on kyc_submissions (user_id) where status = 'PENDING';
create trigger kyc_submissions_updated_at before update on kyc_submissions
  for each row execute function set_updated_at();

create table kyc_documents (
  submission_id  bigint not null references kyc_submissions (id) on delete cascade,
  file_id        bigint not null references files (id),
  document_type  kyc_document_type not null,
  primary key (submission_id, file_id)
);

create table consents (
  id           bigint generated always as identity primary key,
  user_id      bigint not null references users (id) on delete cascade,
  type         text not null,
  version      text not null,
  accepted_at  timestamptz not null default now(),
  ip_address   text,
  app_version  text
);

create table tier_history (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references users (id) on delete cascade,
  from_tier   membership_tier not null,
  to_tier     membership_tier not null,
  created_at  timestamptz not null default now()
);

create or replace function record_tier_change() returns trigger
language plpgsql as $$
begin
  insert into tier_history (user_id, from_tier, to_tier) values (new.id, old.tier, new.tier);
  return new;
end;
$$;

create trigger users_tier_history after update of tier on users
  for each row when (old.tier is distinct from new.tier) execute function record_tier_change();

-- Row level security: API-only access --------------------------------------

alter table users            enable row level security;
alter table files            enable row level security;
alter table user_profiles    enable row level security;
alter table user_preferences enable row level security;
alter table follows          enable row level security;
alter table lookup_options   enable row level security;
alter table kyc_submissions  enable row level security;
alter table kyc_documents    enable row level security;
alter table consents         enable row level security;
alter table tier_history     enable row level security;

-- Multi-row writes that must be atomic -------------------------------------

create or replace function replace_user_preferences(p_user_id bigint, p_preferences jsonb)
returns void
language plpgsql as $$
begin
  delete from user_preferences where user_id = p_user_id;
  insert into user_preferences (user_id, type, option_code)
    select p_user_id, (pref ->> 'type')::preference_type, pref ->> 'code'
    from jsonb_array_elements(p_preferences) as pref;
end;
$$;

create or replace function submit_kyc(
  p_user_id bigint,
  p_tier verified_tier,
  p_documents jsonb,
  p_consent jsonb
) returns uuid
language plpgsql as $$
declare
  v_submission_id bigint;
  v_public_id uuid;
begin
  insert into kyc_submissions (user_id, tier)
    values (p_user_id, p_tier)
    returning id, public_id into v_submission_id, v_public_id;

  insert into kyc_documents (submission_id, file_id, document_type)
    select v_submission_id, (doc ->> 'file_id')::bigint, (doc ->> 'document_type')::kyc_document_type
    from jsonb_array_elements(p_documents) as doc;

  if p_consent is not null then
    insert into consents (user_id, type, version, ip_address, app_version)
      values (p_user_id, p_consent ->> 'type', p_consent ->> 'version',
              p_consent ->> 'ip_address', p_consent ->> 'app_version');
  end if;

  update users set kyc_status = 'PENDING' where id = p_user_id;

  return v_public_id;
end;
$$;

revoke execute on function replace_user_preferences(bigint, jsonb) from public, anon, authenticated;
revoke execute on function submit_kyc(bigint, verified_tier, jsonb, jsonb) from public, anon, authenticated;

-- Storage buckets: the size cap and type allow-list are enforced by Supabase too --

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars',         'avatars',         true,  10485760, array['image/jpeg', 'image/png']),
  ('kyc-documents',   'kyc-documents',   false, 10485760, array['application/pdf', 'image/jpeg', 'image/png']),
  ('review-evidence', 'review-evidence', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;
