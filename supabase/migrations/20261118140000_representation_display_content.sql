-- Everything the Representation screens show, exactly as the app showed it, from the database.
--
-- The app's cards, header figures, signer list and form titles are content: they are stored here
-- as shown ("60% of 19,000", "closes in 6days", "Open for signature", 14 active petitions,
-- 38.2k signatures, 16 "Investor. verified" signers and "+9,240 Signers"), and served by the API
-- unchanged. New signatures add to the counts; the stored figures are never replaced by derived
-- ones.

-- ---------------------------------------------------------------------------------------------
-- 1. Display fields on each petition
-- ---------------------------------------------------------------------------------------------

alter table app.representations
  -- Place in the app's list (its default order, and what its colour follows).
  add column display_order integer not null default 0,
  -- The card's status pill, e.g. "Open for signature".
  add column status_label text not null default 'Open for signature' check (char_length(status_label) <= 60),
  -- The card's "closes in …" value, e.g. "6days".
  add column close_in_label text not null default '' check (char_length(close_in_label) <= 30),
  -- The card's progress bar and "X% of N" line.
  add column progress_done numeric(8, 2) not null default 0,
  add column progress_total integer not null default 0 check (progress_total >= 0),
  -- Title of the two Sign Petition steps and of the signature receipt.
  add column sign_title text not null default '' check (char_length(sign_title) <= 200),
  add column receipt_title text not null default '' check (char_length(receipt_title) <= 200),
  -- "+N Signers" under the signer list.
  add column signers_more integer not null default 0 check (signers_more >= 0),
  -- The Overview tab's note.
  add column disclaimer text not null default '' check (char_length(disclaimer) <= 1000);

-- Signers shown on the SIGNED BY USERS tab before any real signer ("Investor." verified, R).
create table app.representation_featured_signers (
  id bigint generated always as identity primary key,
  representation_id bigint not null references app.representations (id) on delete cascade,
  position integer not null,
  display_name text not null check (char_length(display_name) <= 120),
  status_label text not null default '' check (char_length(status_label) <= 40),
  avatar_letter text not null default '' check (char_length(avatar_letter) <= 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (representation_id, position)
);
create trigger representation_featured_signers_updated_at
  before update on app.representation_featured_signers
  for each row execute function app.set_updated_at();
alter table app.representation_featured_signers enable row level security;

-- The Representation tab's two figures. Real signatures add to the stored total.
create table app.representation_page_stats (
  id boolean primary key default true check (id),
  active_petitions integer not null check (active_petitions >= 0),
  total_signatures integer not null check (total_signatures >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger representation_page_stats_updated_at
  before update on app.representation_page_stats
  for each row execute function app.set_updated_at();
alter table app.representation_page_stats enable row level security;

-- ---------------------------------------------------------------------------------------------
-- 2. Read model
-- ---------------------------------------------------------------------------------------------

-- Search matches the title and tags, as the app's search did.
create or replace view app.representation_cards as
select r.id as internal_id,
       r.public_id as id,
       r.slug,
       r.title,
       lower(r.title || ' ' || array_to_string(r.tags, ' ')) as search_text,
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
       (now() < r.closes_at) as is_open_for_signing,
       r.created_at,
       r.display_order,
       r.status_label,
       r.close_in_label,
       r.progress_done,
       r.progress_total,
       r.sign_title,
       r.receipt_title,
       r.signers_more,
       r.disclaimer
from app.representations r
where r.deleted_at is null and r.opens_at <= now();

create or replace function app.representation_json(c app.representation_cards)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'internalId', c.internal_id::text, 'id', c.id, 'slug', c.slug, 'title', c.title,
    'description', c.description, 'asks', to_jsonb(c.asks), 'whyItMatters', c.why_it_matters,
    'category', c.category, 'country', c.country, 'tags', to_jsonb(c.tags),
    'regulators', to_jsonb(c.regulators), 'goal', c.goal, 'signatureCount', c.signature_count,
    'voteCount', c.vote_count, 'progressPercent', c.progress_pct, 'opensAt', c.opens_at,
    'closesAt', c.closes_at, 'daysLeft', c.days_left, 'trackStatus', c.track_status,
    'isOpenForSigning', c.is_open_for_signing, 'createdAt', c.created_at,
    'displayOrder', c.display_order, 'statusLabel', c.status_label,
    'closeInLabel', c.close_in_label, 'progressDone', c.progress_done::float8,
    'progressTotal', c.progress_total, 'signTitle', c.sign_title,
    'receiptTitle', c.receipt_title, 'signersMore', c.signers_more,
    'disclaimer', c.disclaimer);
$$;

-- The app's orders: its list order ("display"), opening date either way, and progress. Ties keep
-- the list order, as the app's stable sort did.
create or replace function public.app_find_representations(
  p_q_pattern text, p_statuses text[], p_countries text[], p_open boolean, p_years integer[],
  p_years_before integer, p_sort text, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select app.representation_json(c) as item,
           row_number() over (order by
             case when p_sort = 'closing_soon' then c.is_open_for_signing end desc,
             case when p_sort = 'closing_soon' then c.closes_at end asc,
             case when p_sort in ('recent', 'opened_desc') then c.opens_at end desc,
             case when p_sort = 'opened_asc' then c.opens_at end asc,
             case when p_sort = 'most_signed' then c.signature_count end desc,
             case when p_sort = 'progress' then c.progress_done end desc,
             c.display_order, c.id) as rn
    from app.representation_cards c
    where (p_q_pattern is null or c.search_text like p_q_pattern)
      and (coalesce(cardinality(p_statuses), 0) = 0 or c.track_status = any (p_statuses))
      and (coalesce(cardinality(p_countries), 0) = 0 or c.country = any (p_countries))
      and (p_open is null or c.is_open_for_signing = p_open)
      and ((coalesce(cardinality(p_years), 0) = 0 and p_years_before is null)
           or extract(year from c.opens_at)::integer = any (coalesce(p_years, '{}'))
           or extract(year from c.opens_at)::integer < p_years_before)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

create or replace function public.app_representation_featured_signers(p_representation_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'displayName', s.display_name, 'statusLabel', s.status_label, 'avatarLetter', s.avatar_letter)
    order by s.position), '[]'::jsonb)
  from app.representation_featured_signers s
  where s.representation_id = p_representation_id;
$$;

-- The stored figures; every valid signature made in the app adds to the total.
create or replace function public.app_representation_stats()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'activePetitions', coalesce((select active_petitions from app.representation_page_stats), 0),
    'totalSignatures', coalesce((select total_signatures from app.representation_page_stats), 0)
      + (select count(*) from app.representation_signatures s
         join app.representations r on r.id = s.representation_id
         where s.status = 'VALID' and s.deleted_at is null and r.deleted_at is null));
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Content, as the app showed it
-- ---------------------------------------------------------------------------------------------

update app.representations r
set display_order = p.display_order,
    status_label = 'Open for signature',
    close_in_label = p.close_in,
    progress_done = p.done,
    progress_total = p.total,
    sign_title = 'Mandatory T+1 Settlement Disclosure for Retail Investors',
    receipt_title = E'Mandatory T+1 Settlement\nDisclosure for Retail Investor',
    signers_more = 9240,
    disclaimer = 'This petition is created and supported by participating investors. GIG facilitates collection and submission.',
    -- The card shows its stored "closes in" value; the signing window stays open behind it.
    closes_at = now() + interval '365 days'
from (values
  ('mandatory-t1-settlement-disclosure', 1, '6days', 60, 19000),
  ('financial-disclosures-first-time-investors', 2, '9days', 145, 25000),
  ('hidden-fee-transparency', 3, '12days', 280, 32000),
  ('retail-platform-security-standards', 4, '5days', 520, 40000),
  ('mandatory-t1-settlement-disclosure-2', 5, '5days', 520, 40000),
  ('hidden-fee-transparency-2', 6, '5days', 520, 40000)
) as p (slug, display_order, close_in, done, total)
where r.slug = p.slug;

insert into app.representation_featured_signers (representation_id, position, display_name, status_label, avatar_letter)
select r.id, n, 'Investor.', 'verified', 'R'
from app.representations r
cross join generate_series(1, 16) as n
where r.slug in (
  'mandatory-t1-settlement-disclosure', 'financial-disclosures-first-time-investors',
  'hidden-fee-transparency', 'retail-platform-security-standards',
  'mandatory-t1-settlement-disclosure-2', 'hidden-fee-transparency-2')
on conflict (representation_id, position) do nothing;

insert into app.representation_page_stats (id, active_petitions, total_signatures)
values (true, 14, 38200)
on conflict (id) do update set active_petitions = excluded.active_petitions,
                               total_signatures = excluded.total_signatures;

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
