-- Users, profile and KYC (Phase 1): uploaded files, avatars, follows and KYC submissions.
-- Same rules as the auth migration: private "app" schema, no Data API access, RLS on.

-- Every upload gets a row first; the app then PUTs the file to a signed Storage URL.
-- Object keys start with the owner's public_id, so each user has their own folder.
create table app.files (
  id bigint generated always as identity primary key,
  public_id uuid not null unique default gen_random_uuid(),
  owner_id bigint not null references app.users (id) on delete cascade,
  purpose text not null check (purpose in ('AVATAR', 'KYC_DOCUMENT', 'REVIEW_EVIDENCE')),
  bucket text not null check (bucket in ('avatars', 'kyc-documents', 'review-evidence')),
  object_key text not null unique,
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  scan_status text not null default 'PENDING' check (scan_status in ('PENDING', 'CLEAN', 'INFECTED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index files_owner_idx on app.files (owner_id);
create trigger files_updated_at before update on app.files
  for each row execute function app.set_updated_at();

alter table app.user_profiles
  add column avatar_file_id bigint references app.files (id) on delete set null;

create table app.follows (
  follower_id bigint not null references app.users (id) on delete cascade,
  followee_id bigint not null references app.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index follows_followee_idx on app.follows (followee_id);

create table app.kyc_submissions (
  id bigint generated always as identity primary key,
  public_id uuid not null unique default gen_random_uuid(),
  user_id bigint not null references app.users (id) on delete cascade,
  tier text not null check (tier in ('PRIVE', 'INSTITUTIONAL')),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  provider text not null default 'MANUAL',
  reference text,
  reviewer_id bigint references app.users (id),
  reason text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index kyc_submissions_user_idx on app.kyc_submissions (user_id, created_at desc);
-- At most one open submission per user.
create unique index kyc_submissions_one_pending on app.kyc_submissions (user_id) where status = 'PENDING';
create trigger kyc_submissions_updated_at before update on app.kyc_submissions
  for each row execute function app.set_updated_at();

create table app.kyc_documents (
  submission_id bigint not null references app.kyc_submissions (id) on delete cascade,
  file_id bigint not null references app.files (id),
  document_type text not null check (document_type in (
    'ID_PROOF', 'ADDRESS_PROOF', 'TAX_ID', 'INCORPORATION_CERTIFICATE', 'AUTHORISATION_LETTER'
  )),
  primary key (submission_id, file_id)
);

-- KYC consent is recorded like the 18+ confirmation: type, version, time, IP and app version.
alter table app.consents drop constraint consents_type_check;
alter table app.consents add constraint consents_type_check check (type in ('AGE_18_PLUS', 'KYC'));

alter table app.files enable row level security;
alter table app.follows enable row level security;
alter table app.kyc_submissions enable row level security;
alter table app.kyc_documents enable row level security;

-- Storage buckets: the size cap and type allow-list are enforced by Supabase too.
-- Avatars are public; KYC documents and review evidence are private.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars', 'avatars', true, 10485760, array['image/jpeg', 'image/png']),
  ('kyc-documents', 'kyc-documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png']),
  ('review-evidence', 'review-evidence', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;
