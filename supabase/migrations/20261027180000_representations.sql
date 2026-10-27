-- Representations (Phase 1). The 4 tables of the plan's Representations domain:
--   representations, representation_signatures, representation_status_history,
--   representation_documents
-- Investors sign petitions that GIG submits to regulators. A petition moves through 9 track
-- statuses: the first three (OPEN, CLOSING_SOON, CLOSED) follow its signing window; the rest are
-- set by GIG staff. Signing consents are stored in app.consents.
-- Same rules as the auth migration: private "app" schema, no Data API access, RLS on.

-- The status the app shows: signing-window statuses follow the dates, later ones are as stored.
-- An open petition shows as "Closing Soon" in its last 7 days.
create or replace function app.representation_effective_status(p_status text, p_closes_at timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_status not in ('OPEN', 'CLOSING_SOON', 'CLOSED') then p_status
    when now() >= p_closes_at then 'CLOSED'
    when p_closes_at - now() <= interval '7 days' then 'CLOSING_SOON'
    else 'OPEN'
  end;
$$;

create table app.representations (
  id bigint generated always as identity primary key,
  public_id uuid not null unique default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (char_length(title) between 5 and 200),
  description text not null default '' check (char_length(description) <= 500),
  -- Overview tab: what investors ask for and why it matters.
  asks text[] not null default '{}' check (cardinality(asks) <= 10),
  why_it_matters text not null default '' check (char_length(why_it_matters) <= 4000),
  category text check (char_length(category) <= 60),
  country text not null check (country in ('IN', 'AE', 'OTHER')),
  tags text[] not null default '{}' check (cardinality(tags) <= 10),
  regulators text[] not null default '{}' check (cardinality(regulators) <= 10),
  goal integer not null check (goal > 0),
  opens_at timestamptz not null default now(),
  closes_at timestamptz not null,
  track_status text not null default 'OPEN' check (track_status in (
    'OPEN', 'CLOSING_SOON', 'CLOSED', 'UNDER_REVIEW', 'SUBMITTED_TO_REGULATOR',
    'MEETING_REQUESTED', 'MEETING_SCHEDULED', 'REGULATOR_RESPONDED', 'RESOLVED'
  )),
  -- Maintained by a trigger on representation_signatures.
  signature_count integer not null default 0,
  -- Only Prive signatures count as votes.
  vote_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (closes_at > opens_at)
);
create trigger representations_updated_at before update on app.representations
  for each row execute function app.set_updated_at();
create index representations_closes_at_idx on app.representations (closes_at);

create table app.representation_signatures (
  id bigint generated always as identity primary key,
  public_id uuid not null unique default gen_random_uuid(),
  -- Shown on the receipt: GIG- followed by 9 random uppercase letters or digits.
  signature_code text not null
    constraint representation_signatures_code_key unique
    check (signature_code ~ '^GIG-[A-Z0-9]{9}$'),
  representation_id bigint not null references app.representations (id) on delete cascade,
  user_id bigint not null references app.users (id) on delete cascade,
  display_mode text not null check (display_mode in ('FULL_NAME', 'INITIALS', 'ANONYMOUS')),
  -- Signer's name when signing; shown per display_mode, never for ANONYMOUS.
  signer_name text not null default '' check (char_length(signer_name) <= 120),
  investor_type_kind text not null default 'INVESTOR_TYPE' check (investor_type_kind = 'INVESTOR_TYPE'),
  investor_type text,
  signature_file_id bigint not null references app.files (id),
  signer_tier text not null check (signer_tier in ('OBSERVER', 'PRIVE', 'INSTITUTIONAL')),
  -- 1 for Prive signatures (they count as votes), 0 otherwise.
  weight smallint not null check (weight in (0, 1)),
  consent_version text not null,
  -- VALID signatures count; GIG staff can REMOVE one (e.g. a fraudulent signature).
  status text not null default 'VALID' check (status in ('VALID', 'REMOVED')),
  idempotency_key text check (char_length(idempotency_key) between 8 and 128),
  request_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (investor_type_kind, investor_type) references app.lookup_options (type, code)
);
create trigger representation_signatures_updated_at before update on app.representation_signatures
  for each row execute function app.set_updated_at();

-- One signature per investor and petition (a removed or deleted one does not block re-signing).
create unique index representation_signatures_one_per_user
  on app.representation_signatures (representation_id, user_id)
  where deleted_at is null and status = 'VALID';
create unique index representation_signatures_idempotency_key_idx
  on app.representation_signatures (user_id, idempotency_key)
  where idempotency_key is not null;
create index representation_signatures_feed_idx
  on app.representation_signatures (representation_id, created_at desc);

create table app.representation_status_history (
  id bigint generated always as identity primary key,
  representation_id bigint not null references app.representations (id) on delete cascade,
  from_status text,
  to_status text not null,
  note text check (char_length(note) <= 2000),
  actor_id bigint references app.users (id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger representation_status_history_updated_at
  before update on app.representation_status_history
  for each row execute function app.set_updated_at();
create index representation_status_history_idx
  on app.representation_status_history (representation_id, occurred_at);

create table app.representation_documents (
  id bigint generated always as identity primary key,
  public_id uuid not null unique default gen_random_uuid(),
  representation_id bigint not null references app.representations (id) on delete cascade,
  -- Set for documents that belong to a track step (submission pack, regulator response, ...).
  status_history_id bigint references app.representation_status_history (id) on delete set null,
  document_type text not null check (document_type in (
    'EVIDENCE', 'SUBMISSION_PACK', 'REGULATOR_RESPONSE', 'MEETING_MINUTES'
  )),
  title text not null check (char_length(title) between 1 and 200),
  -- Staff uploads; not one of the investor upload purposes, so not in app.files.
  bucket text not null default 'representation-documents',
  object_key text not null unique,
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes integer not null check (size_bytes between 1 and 26214400),
  scan_status text not null default 'PENDING' check (scan_status in ('PENDING', 'CLEAN', 'INFECTED')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger representation_documents_updated_at before update on app.representation_documents
  for each row execute function app.set_updated_at();
create index representation_documents_idx
  on app.representation_documents (representation_id, sort_order);

-- ---------------------------------------------------------------------------------------------
-- Counters and history
-- ---------------------------------------------------------------------------------------------

create or replace function app.representation_signatures_refresh_counts()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_representation_id bigint := coalesce(new.representation_id, old.representation_id);
begin
  update app.representations r
  set signature_count = s.total,
      vote_count = s.votes
  from (
    select count(*)::integer as total, coalesce(sum(weight), 0)::integer as votes
    from app.representation_signatures
    where representation_id = v_representation_id and status = 'VALID' and deleted_at is null
  ) s
  where r.id = v_representation_id;
  return null;
end;
$$;

create trigger representation_signatures_refresh_counts
after insert or delete or update of status, deleted_at on app.representation_signatures
for each row execute function app.representation_signatures_refresh_counts();

-- Every petition starts its timeline when created, and every stored status change is recorded.
create or replace function app.representations_record_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into app.representation_status_history (representation_id, to_status, occurred_at)
    values (new.id, new.track_status, new.opens_at);
  elsif new.track_status is distinct from old.track_status then
    insert into app.representation_status_history (representation_id, from_status, to_status)
    values (new.id, old.track_status, new.track_status);
  end if;
  return null;
end;
$$;

create trigger representations_record_status
after insert or update of track_status on app.representations
for each row execute function app.representations_record_status();

-- ---------------------------------------------------------------------------------------------
-- Read model: published petitions with progress, days left and the effective track status
-- ---------------------------------------------------------------------------------------------

create view app.representation_cards as
select r.id as internal_id,
       r.public_id as id,
       r.slug,
       r.title,
       lower(r.title || ' ' || r.description || ' ' || array_to_string(r.tags, ' ')) as search_text,
       r.description,
       r.asks,
       r.why_it_matters,
       r.category,
       r.country,
       r.tags,
       r.regulators,
       r.goal,
       r.signature_count,
       r.vote_count,
       least(100, round(100.0 * r.signature_count / r.goal, 1))::float8 as progress_pct,
       r.opens_at,
       r.closes_at,
       greatest(0, ceil(extract(epoch from r.closes_at - now()) / 86400))::integer as days_left,
       app.representation_effective_status(r.track_status, r.closes_at) as track_status,
       (now() < r.closes_at and r.track_status in ('OPEN', 'CLOSING_SOON')) as is_open_for_signing,
       r.created_at
from app.representations r
where r.deleted_at is null and r.opens_at <= now();

alter table app.representations enable row level security;
alter table app.representation_signatures enable row level security;
alter table app.representation_status_history enable row level security;
alter table app.representation_documents enable row level security;

-- Evidence, submission packs and regulator responses uploaded by GIG staff.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('representation-documents', 'representation-documents', false, 26214400,
   array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;
