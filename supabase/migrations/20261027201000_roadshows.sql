-- Roadshows (Phase 2). The plan's Roadshows domain plus FX rates:
--   roadshows, roadshow_financials, roadshow_documents, roadshow_questions, pool_members,
--   roadshow_improvement_votes, roadshow_offers, fx_rates
-- Joining the Power Pool spends 1 credit through public.apply_credit_change, in the same
-- transaction as the membership.

-- ---------------------------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------------------------

create type public.currency_code as enum ('INR', 'USD', 'EUR', 'GBP', 'AED');
-- Ask Me Anything categories. "Top Asked" and "Recently Added" are sort orders, not categories.
create type public.question_category as enum (
  'GENERAL', 'EQUITY', 'DEBT', 'INSURANCE', 'CRYPTO', 'MUTUAL_FUNDS'
);
create type public.question_status as enum ('PENDING_MODERATION', 'PUBLISHED', 'REJECTED');
-- The 8 offer expectations a pool member picks from (at least 3).
create type public.pool_expectation as enum (
  'BETTER_ROI_IRR',
  'SHORTER_LOCK_IN',
  'LOWER_ENTRY_LOAD',
  'LOWER_EXIT_LOAD',
  'PRIORITY_ALLOTMENT',
  'FLEXIBLE_PAYMENT_TERMS',
  'DISCOUNTED_OFFER_PRICE',
  'REGULAR_DISCLOSURES'
);
create type public.offer_status as enum ('PENDING_REVIEW', 'PUBLISHED', 'WITHDRAWN', 'REJECTED');

-- ---------------------------------------------------------------------------------------------
-- FX rates
-- ---------------------------------------------------------------------------------------------

-- Latest rate per currency, as units per 1 USD. The FX feed job overwrites these rows.
create table public.fx_rates (
  currency  public.currency_code primary key,
  per_usd   numeric(18, 8) not null check (per_usd > 0),
  as_of     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Roadshows
-- ---------------------------------------------------------------------------------------------

create table public.roadshows (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  issuer_id          uuid not null references public.issuers (id),
  title              text not null check (char_length(title) between 2 and 160),
  summary            text check (char_length(summary) <= 4000),
  -- Issue terms
  type_of_issue      text not null check (char_length(type_of_issue) between 1 and 60),
  instruments        text not null check (char_length(instruments) between 1 and 60),
  no_of_instruments  bigint check (no_of_instruments > 0),
  offer_price        numeric(18, 2) check (offer_price >= 0),
  -- Currency of the offer price, capital interest and reported financials.
  currency           public.currency_code not null default 'INR',
  lock_in            text check (char_length(lock_in) <= 60),
  maturity           text check (char_length(maturity) <= 60),
  convertibility     text check (char_length(convertibility) <= 60),
  callable           boolean not null default false,
  coupon_rate        numeric(5, 2) check (coupon_rate between 0 and 100),
  risk_factors       text[] not null default '{}' check (cardinality(risk_factors) <= 20),
  opens_at           timestamptz,
  closes_at          timestamptz not null,
  pool_enabled       boolean not null default false,
  status             public.content_status not null default 'DRAFT',
  published_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (opens_at is null or closes_at > opens_at),
  check (status <> 'PUBLISHED' or published_at is not null)
);

create trigger roadshows_set_updated_at
before update on public.roadshows
for each row execute function public.catalog_set_updated_at();

create index roadshows_closes_at_idx on public.roadshows (status, closes_at);
create index roadshows_title_trgm_idx on public.roadshows using gin (title extensions.gin_trgm_ops);

-- One row per fiscal year, in the roadshow's currency. Converted with fx_rates on read.
create table public.roadshow_financials (
  roadshow_id           uuid not null references public.roadshows (id) on delete cascade,
  fiscal_year           smallint not null check (fiscal_year between 1990 and 2100),
  revenue               numeric(18, 2),
  ebitda                numeric(18, 2),
  net_profit            numeric(18, 2),
  total_assets          numeric(18, 2),
  total_liabilities     numeric(18, 2),
  net_worth             numeric(18, 2),
  total_debt            numeric(18, 2),
  cash_and_equivalents  numeric(18, 2),
  operating_cash_flow   numeric(18, 2),
  eps                   numeric(18, 4),
  primary key (roadshow_id, fiscal_year)
);

-- Due-diligence PDFs in the private "roadshow-documents" bucket.
create table public.roadshow_documents (
  id            uuid primary key default gen_random_uuid(),
  roadshow_id   uuid not null references public.roadshows (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 160),
  doc_type      text not null check (doc_type in (
                  'PROSPECTUS', 'FINANCIAL_STATEMENT', 'LEGAL_OPINION', 'RATING_REPORT',
                  'DUE_DILIGENCE', 'OTHER')),
  storage_path  text not null unique check (storage_path ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'),
  size_bytes    integer check (size_bytes > 0),
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now()
);

create index roadshow_documents_roadshow_idx on public.roadshow_documents (roadshow_id, sort_order);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('roadshow-documents', 'roadshow-documents', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Ask Me Anything
-- ---------------------------------------------------------------------------------------------

create table public.roadshow_questions (
  id           uuid primary key default gen_random_uuid(),
  roadshow_id  uuid not null references public.roadshows (id) on delete cascade,
  user_id      uuid not null references app.users (public_id) on delete cascade,
  category     public.question_category not null default 'GENERAL',
  question     text not null check (char_length(question) between 10 and 500),
  status       public.question_status not null default 'PENDING_MODERATION',
  -- Picked by GIG staff for the "Top Asked" tab.
  featured     boolean not null default false,
  -- The issuer's answer, published by GIG staff.
  answer       text check (char_length(answer) between 1 and 4000),
  answered_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((answer is null) = (answered_at is null))
);

create trigger roadshow_questions_set_updated_at
before update on public.roadshow_questions
for each row execute function public.catalog_set_updated_at();

create index roadshow_questions_feed_idx
  on public.roadshow_questions (roadshow_id, status, created_at desc);
create index roadshow_questions_text_trgm_idx
  on public.roadshow_questions using gin (question extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------------------------
-- Power Pool and offers
-- ---------------------------------------------------------------------------------------------

create table public.pool_members (
  roadshow_id       uuid not null references public.roadshows (id) on delete cascade,
  user_id           uuid not null references app.users (public_id) on delete cascade,
  -- In the roadshow's currency.
  capital_interest  numeric(18, 2) not null check (capital_interest > 0),
  -- The ledger entry that paid for joining.
  ledger_entry_id   bigint not null references public.credit_ledger (id),
  -- Idempotency-Key of the joining request, so a retry is answered with this membership.
  idempotency_key   text not null check (char_length(idempotency_key) between 8 and 128),
  request_hash      text not null,
  created_at        timestamptz not null default now(),
  primary key (roadshow_id, user_id)
);

-- The improvements each pool member asks for (demanded improvements).
create table public.roadshow_improvement_votes (
  roadshow_id  uuid not null,
  user_id      uuid not null,
  expectation  public.pool_expectation not null,
  primary key (roadshow_id, user_id, expectation),
  foreign key (roadshow_id, user_id)
    references public.pool_members (roadshow_id, user_id) on delete cascade
);

create table public.roadshow_offers (
  id                uuid primary key default gen_random_uuid(),
  roadshow_id       uuid not null references public.roadshows (id) on delete cascade,
  user_id           uuid not null references app.users (public_id) on delete cascade,
  offer_price       numeric(18, 2) check (offer_price >= 0),
  currency          public.currency_code not null,
  -- Percentages
  expected_roi      numeric(6, 2) check (expected_roi between -100 and 1000),
  expected_irr      numeric(6, 2) check (expected_irr between -100 and 1000),
  entry_load        numeric(5, 2) check (entry_load between 0 and 100),
  exit_load         numeric(5, 2) check (exit_load between 0 and 100),
  lock_in_months    smallint check (lock_in_months between 0 and 600),
  min_investment    numeric(18, 2) check (min_investment > 0),
  allotment_terms   text check (char_length(allotment_terms) <= 400),
  payment_terms     text check (char_length(payment_terms) <= 400),
  notes             text check (char_length(notes) <= 2000),
  status            public.offer_status not null default 'PENDING_REVIEW',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger roadshow_offers_set_updated_at
before update on public.roadshow_offers
for each row execute function public.catalog_set_updated_at();

create index roadshow_offers_roadshow_idx on public.roadshow_offers (roadshow_id, created_at desc);

-- Joins the Power Pool: checks the roadshow is published, open and has its pool enabled, spends
-- 1 credit, records the membership and its expectations, and notifies the member. Raises
-- ROADSHOW_NOT_FOUND, POOL_NOT_ENABLED, ROADSHOW_CLOSED, EXPECTATIONS_INVALID, ALREADY_IN_POOL or
-- INSUFFICIENT_CREDITS; any of them rolls the whole join back.
create or replace function public.join_roadshow_pool(
  p_user_id           uuid,
  p_roadshow_id       uuid,
  p_capital_interest  numeric,
  p_expectations      public.pool_expectation[],
  p_idempotency_key   text,
  p_request_hash      text
)
returns table (joined_at timestamptz, credits_remaining integer)
language plpgsql
-- Definer rights: the service role cannot read the private app schema directly.
security definer
set search_path = ''
as $$
declare
  v_roadshow public.roadshows;
  v_expectations public.pool_expectation[];
  v_entry public.credit_ledger;
  v_member public.pool_members;
begin
  -- Serialises concurrent joins (and credit spends) by the same user.
  perform 1 from app.users u where u.public_id = p_user_id for update;

  select r.* into v_roadshow
  from public.roadshows r
  where r.id = p_roadshow_id and r.status = 'PUBLISHED';

  if not found then
    raise exception 'ROADSHOW_NOT_FOUND';
  end if;
  if not v_roadshow.pool_enabled then
    raise exception 'POOL_NOT_ENABLED';
  end if;
  if v_roadshow.closes_at <= now() then
    raise exception 'ROADSHOW_CLOSED';
  end if;

  v_expectations := array(select distinct e from unnest(p_expectations) as e where e is not null);
  if cardinality(v_expectations) < 3 then
    raise exception 'EXPECTATIONS_INVALID';
  end if;

  if exists (
    select 1 from public.pool_members m
    where m.roadshow_id = p_roadshow_id and m.user_id = p_user_id
  ) then
    raise exception 'ALREADY_IN_POOL';
  end if;

  select * into v_entry
  from public.apply_credit_change(p_user_id, -1, 'POOL_JOIN', 'ROADSHOW', p_roadshow_id, null);

  insert into public.pool_members (
    roadshow_id, user_id, capital_interest, ledger_entry_id, idempotency_key, request_hash
  ) values (
    p_roadshow_id, p_user_id, p_capital_interest, v_entry.id, p_idempotency_key, p_request_hash
  )
  returning * into v_member;

  insert into public.roadshow_improvement_votes (roadshow_id, user_id, expectation)
  select p_roadshow_id, p_user_id, e from unnest(v_expectations) as e;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    p_user_id, 'POOL', 'You joined the Power Pool',
    'You joined the Power Pool for ' || v_roadshow.title || '. 1 credit was used.',
    jsonb_build_object('roadshowId', p_roadshow_id)
  );

  return query select v_member.created_at, v_entry.balance_after;
end;
$$;

-- Pool power: one row per (capital-interest quartile band, expectation). Bands are quartiles of
-- the members' capital interest (fewer than 4 when the pool is small). `votes` counts the band's
-- members asking for the expectation.
create or replace function public.roadshow_pool_power(p_roadshow_id uuid)
returns table (
  band          integer,
  band_min      numeric,
  band_max      numeric,
  band_members  integer,
  band_capital  numeric,
  expectation   public.pool_expectation,
  votes         integer
)
language sql
stable
set search_path = ''
as $$
  with members as (
    select m.user_id,
           m.capital_interest,
           ntile(4) over (order by m.capital_interest, m.user_id)::integer as band
    from public.pool_members m
    where m.roadshow_id = p_roadshow_id
  ),
  bands as (
    select mb.band,
           min(mb.capital_interest) as band_min,
           max(mb.capital_interest) as band_max,
           count(*)::integer as band_members,
           sum(mb.capital_interest) as band_capital
    from members mb
    group by mb.band
  ),
  band_votes as (
    select mb.band, v.expectation, count(*)::integer as votes
    from public.roadshow_improvement_votes v
    join members mb on mb.user_id = v.user_id
    where v.roadshow_id = p_roadshow_id
    group by mb.band, v.expectation
  )
  select b.band, b.band_min, b.band_max, b.band_members, b.band_capital, e.expectation,
         coalesce(bv.votes, 0)
  from bands b
  cross join unnest(enum_range(null::public.pool_expectation)) as e (expectation)
  left join band_votes bv on bv.band = b.band and bv.expectation = e.expectation
  order by b.band, e.expectation;
$$;

-- ---------------------------------------------------------------------------------------------
-- Access: the API uses the service role. Block direct access from app clients.
-- ---------------------------------------------------------------------------------------------

alter table public.fx_rates enable row level security;
alter table public.roadshows enable row level security;
alter table public.roadshow_financials enable row level security;
alter table public.roadshow_documents enable row level security;
alter table public.roadshow_questions enable row level security;
alter table public.pool_members enable row level security;
alter table public.roadshow_improvement_votes enable row level security;
alter table public.roadshow_offers enable row level security;

revoke execute on function
  public.join_roadshow_pool(uuid, uuid, numeric, public.pool_expectation[], text, text),
  public.roadshow_pool_power(uuid)
from public, anon, authenticated;
