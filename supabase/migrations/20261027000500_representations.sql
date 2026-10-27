-- Representations (Phase 1). The 4 tables of the plan's Representations domain:
--   representations, representation_signatures, representation_status_history,
--   representation_documents
-- Investors sign petitions that GIG submits to regulators. A petition moves through 9 track
-- statuses: the first three (OPEN, CLOSING_SOON, CLOSED) follow its signing window; the rest are
-- set by GIG staff. Signing consents are stored in the shared consents table.

create type public.representation_track_status as enum (
  'OPEN', 'CLOSING_SOON', 'CLOSED', 'UNDER_REVIEW', 'SUBMITTED_TO_REGULATOR',
  'MEETING_REQUESTED', 'MEETING_SCHEDULED', 'REGULATOR_RESPONDED', 'RESOLVED'
);
-- VALID signatures count; GIG staff can REMOVE one (e.g. a fraudulent signature).
create type public.signature_status as enum ('VALID', 'REMOVED');
create type public.representation_document_type as enum (
  'EVIDENCE', 'SUBMISSION_PACK', 'REGULATOR_RESPONSE', 'MEETING_MINUTES'
);

-- Days before closing when an open petition shows as "Closing Soon".
create or replace function public.representation_closing_soon_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '7 days' $$;

-- The status the app shows: signing-window statuses follow the dates, later ones are as stored.
create or replace function public.representation_effective_status(
  p_status public.representation_track_status,
  p_closes_at timestamptz
)
returns public.representation_track_status
language sql
stable
set search_path = ''
as $$
  select case
    when p_status not in ('OPEN', 'CLOSING_SOON', 'CLOSED') then p_status
    when now() >= p_closes_at then 'CLOSED'
    when p_closes_at - now() <= public.representation_closing_soon_window() then 'CLOSING_SOON'
    else 'OPEN'
  end::public.representation_track_status;
$$;

create table public.representations (
  id               bigint generated always as identity primary key,
  public_id        uuid not null unique default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title            text not null check (char_length(title) between 5 and 200),
  description      text not null default '' check (char_length(description) <= 500),
  -- Overview tab: what investors ask for and why it matters.
  asks             text[] not null default '{}' check (cardinality(asks) <= 10),
  why_it_matters   text not null default '' check (char_length(why_it_matters) <= 4000),
  category         text check (char_length(category) <= 60),
  country          public.market_country not null,
  tags             text[] not null default '{}' check (cardinality(tags) <= 10),
  regulators       text[] not null default '{}' check (cardinality(regulators) <= 10),
  goal             integer not null check (goal > 0),
  opens_at         timestamptz not null default now(),
  closes_at        timestamptz not null,
  track_status     public.representation_track_status not null default 'OPEN',
  -- Maintained by a trigger on representation_signatures.
  signature_count  integer not null default 0,
  -- Only Prive signatures count as votes.
  vote_count       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  check (closes_at > opens_at)
);

create trigger representations_updated_at before update on public.representations
  for each row execute function public.set_updated_at();

create index representations_closes_at_idx on public.representations (closes_at);
create index representations_title_trgm_idx
  on public.representations using gin (title extensions.gin_trgm_ops);

create table public.representation_signatures (
  id                  bigint generated always as identity primary key,
  public_id           uuid not null unique default gen_random_uuid(),
  -- Shown on the receipt: GIG- followed by 9 random uppercase letters or digits.
  signature_code      text not null
                      constraint representation_signatures_code_key unique
                      check (signature_code ~ '^GIG-[A-Z0-9]{9}$'),
  representation_id   bigint not null references public.representations (id) on delete cascade,
  user_id             bigint not null references public.users (id) on delete cascade,
  display_mode        public.display_mode not null,
  -- Signer's name when signing; shown per display_mode, never for ANONYMOUS.
  signer_name         text not null default '' check (char_length(signer_name) <= 120),
  investor_type_kind  public.lookup_type not null default 'INVESTOR_TYPE'
                      check (investor_type_kind = 'INVESTOR_TYPE'),
  investor_type       text,
  signature_file_id   bigint not null references public.files (id),
  signer_tier         public.membership_tier not null,
  -- 1 for Prive signatures (they count as votes), 0 otherwise.
  weight              smallint not null check (weight in (0, 1)),
  consent_version     text not null,
  status              public.signature_status not null default 'VALID',
  idempotency_key     text check (char_length(idempotency_key) between 8 and 128),
  request_hash        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  foreign key (investor_type_kind, investor_type) references public.lookup_options (type, code)
);

create trigger representation_signatures_updated_at before update on public.representation_signatures
  for each row execute function public.set_updated_at();

-- One signature per investor and petition (a removed or deleted one does not block re-signing).
create unique index representation_signatures_one_per_user
  on public.representation_signatures (representation_id, user_id)
  where deleted_at is null and status = 'VALID';

create unique index representation_signatures_idempotency_key_idx
  on public.representation_signatures (user_id, idempotency_key)
  where idempotency_key is not null;
create index representation_signatures_feed_idx
  on public.representation_signatures (representation_id, created_at desc);

create table public.representation_status_history (
  id                 bigint generated always as identity primary key,
  representation_id  bigint not null references public.representations (id) on delete cascade,
  from_status        public.representation_track_status,
  to_status          public.representation_track_status not null,
  note               text check (char_length(note) <= 2000),
  actor_id           bigint references public.users (id) on delete set null,
  occurred_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger representation_status_history_updated_at
  before update on public.representation_status_history
  for each row execute function public.set_updated_at();

create index representation_status_history_idx
  on public.representation_status_history (representation_id, occurred_at);

create table public.representation_documents (
  id                 bigint generated always as identity primary key,
  public_id          uuid not null unique default gen_random_uuid(),
  representation_id  bigint not null references public.representations (id) on delete cascade,
  -- Set for documents that belong to a track step (submission pack, regulator response, ...).
  status_history_id  bigint references public.representation_status_history (id) on delete set null,
  document_type      public.representation_document_type not null,
  title              text not null check (char_length(title) between 1 and 200),
  file_id            bigint not null references public.files (id),
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger representation_documents_updated_at before update on public.representation_documents
  for each row execute function public.set_updated_at();

create index representation_documents_idx
  on public.representation_documents (representation_id, sort_order);

-- ---------------------------------------------------------------------------------------------
-- Counters and history
-- ---------------------------------------------------------------------------------------------

create or replace function public.representation_signatures_refresh_counts()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_representation_id bigint := coalesce(new.representation_id, old.representation_id);
begin
  update public.representations r
  set signature_count = s.total,
      vote_count = s.votes
  from (
    select count(*)::integer as total, coalesce(sum(weight), 0)::integer as votes
    from public.representation_signatures
    where representation_id = v_representation_id and status = 'VALID' and deleted_at is null
  ) s
  where r.id = v_representation_id;
  return null;
end;
$$;

create trigger representation_signatures_refresh_counts
after insert or delete or update of status, deleted_at on public.representation_signatures
for each row execute function public.representation_signatures_refresh_counts();

-- Every petition starts its timeline when created, and every stored status change is recorded.
create or replace function public.representations_record_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.representation_status_history (representation_id, to_status, occurred_at)
    values (new.id, new.track_status, new.opens_at);
  elsif new.track_status is distinct from old.track_status then
    insert into public.representation_status_history (representation_id, from_status, to_status)
    values (new.id, old.track_status, new.track_status);
  end if;
  return null;
end;
$$;

create trigger representations_record_status
after insert or update of track_status on public.representations
for each row execute function public.representations_record_status();

-- ---------------------------------------------------------------------------------------------
-- Read models
-- ---------------------------------------------------------------------------------------------

create view public.representation_cards with (security_invoker = true) as
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
       least(100, round(100.0 * r.signature_count / r.goal, 1)) as progress_pct,
       r.opens_at,
       r.closes_at,
       greatest(0, ceil(extract(epoch from r.closes_at - now()) / 86400))::integer as days_left,
       public.representation_effective_status(r.track_status, r.closes_at) as track_status,
       (now() < r.closes_at and r.track_status in ('OPEN', 'CLOSING_SOON')) as is_open_for_signing,
       r.created_at
from public.representations r
where r.deleted_at is null and r.opens_at <= now();

-- Signers as the public sees them: the name follows the signer's display choice and is never
-- returned for anonymous signatures. No user ids.
create view public.representation_signers with (security_invoker = true) as
select s.representation_id,
       s.public_id as id,
       case s.display_mode
         when 'ANONYMOUS' then null
         when 'INITIALS' then public.name_initials(s.signer_name)
         else nullif(btrim(s.signer_name), '')
       end as display_name,
       s.display_mode = 'ANONYMOUS' as is_anonymous,
       s.investor_type,
       o.label as investor_type_label,
       s.signer_tier = 'PRIVE' as is_verified,
       s.created_at as signed_at
from public.representation_signatures s
left join public.lookup_options o
  on o.type = s.investor_type_kind and o.code = s.investor_type
where s.status = 'VALID' and s.deleted_at is null;

-- ---------------------------------------------------------------------------------------------
-- Sign (one transaction)
-- ---------------------------------------------------------------------------------------------

-- Saves a signature and its consents. The API validates input first; these checks are the
-- backstop and raise:
--   REPRESENTATION_NOT_FOUND  unknown or deleted petition
--   REPRESENTATION_CLOSED     the signing window is over, or the petition moved past it
--   SIGNATURE_FILE_INVALID    the file is not the signer's own SIGNATURE upload, or is infected
create or replace function public.sign_representation(
  p_user_id            bigint,
  p_representation_id  uuid,
  p_signature_code     text,
  p_display_mode       public.display_mode,
  p_signer_name        text,
  p_investor_type      text,
  p_signature_file_id  bigint,
  p_signer_tier        public.membership_tier,
  p_consent_types      text[],
  p_consent_version    text,
  p_ip_address         text,
  p_app_version        text,
  p_idempotency_key    text,
  p_request_hash       text
)
returns table (public_id uuid, signature_code text, created_at timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_representation public.representations;
  v_signature public.representation_signatures;
begin
  select * into v_representation
  from public.representations r
  where r.public_id = p_representation_id and r.deleted_at is null and r.opens_at <= now()
  for share;

  if not found then
    raise exception 'REPRESENTATION_NOT_FOUND';
  end if;

  if now() >= v_representation.closes_at
     or v_representation.track_status not in ('OPEN', 'CLOSING_SOON') then
    raise exception 'REPRESENTATION_CLOSED';
  end if;

  if not exists (
    select 1 from public.files f
    where f.id = p_signature_file_id and f.owner_id = p_user_id and f.purpose = 'SIGNATURE'
      and f.scan_status <> 'INFECTED'
  ) then
    raise exception 'SIGNATURE_FILE_INVALID';
  end if;

  insert into public.representation_signatures (
    signature_code, representation_id, user_id, display_mode, signer_name, investor_type,
    signature_file_id, signer_tier, weight, consent_version, idempotency_key, request_hash
  ) values (
    p_signature_code, v_representation.id, p_user_id, p_display_mode,
    coalesce(p_signer_name, ''), p_investor_type, p_signature_file_id, p_signer_tier,
    case when p_signer_tier = 'PRIVE' then 1 else 0 end,
    p_consent_version, p_idempotency_key, p_request_hash
  )
  returning * into v_signature;

  insert into public.consents (user_id, type, version, ip_address, app_version)
  select p_user_id, t, p_consent_version, p_ip_address, p_app_version
  from unnest(p_consent_types) as t;

  return query
  select v_signature.public_id, v_signature.signature_code, v_signature.created_at;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Access: API (service role) only
-- ---------------------------------------------------------------------------------------------

alter table public.representations enable row level security;
alter table public.representation_signatures enable row level security;
alter table public.representation_status_history enable row level security;
alter table public.representation_documents enable row level security;

revoke all on public.representation_cards, public.representation_signers from anon, authenticated;

revoke execute on function
  public.sign_representation(bigint, uuid, text, public.display_mode, text, text, bigint,
                             public.membership_tier, text[], text, text, text, text, text)
from public, anon, authenticated;
