-- Catalog and reviews (Phase 1). The 10 tables of the plan's Catalog and Reviews domains:
--   Catalog: companies, company_tags, issuers, issuer_tags
--   Reviews: reviews, review_tags, review_attachments, review_versions, company_stats,
--            company_trend_points
-- Public numbers (scores, sentiment %, resolution lens, trends) are read from company_stats and
-- company_trend_points, which a trigger recomputes whenever a published review changes.
--
-- Users: this module only references Supabase Auth (auth.users). It does not depend on the
-- profile/onboarding tables (owned by the auth module). Membership tier and KYC status are
-- resolved by the API in src/lib/membership.ts; the reviewer's name is stored on the review.
-- Evidence files live in the private Storage bucket "review-evidence" under <user_id>/...;
-- uploading them is the Users/KYC module's job (/files/upload-url).

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------------------------

create type public.asset_class as enum ('EQ', 'MF', 'INS', 'BND', 'PMS', 'BRK', 'RE', 'CRY');
create type public.market_country as enum ('IN', 'AE', 'OTHER');
create type public.sentiment as enum ('Positive', 'Neutral', 'Negative');
create type public.investment_status as enum ('CURRENTLY_INVESTED', 'EXITED', 'NEVER_INVESTED');
create type public.reinvest_status as enum ('YES', 'MAYBE', 'NO');
create type public.resolution_status as enum (
  'NOT_CONTACTED', 'CONTACTED', 'IN_PROGRESS', 'RESOLVED', 'PARTIALLY_RESOLVED', 'CLOSED_UNRESOLVED'
);
-- The four buckets the resolution lens and list filters use.
create type public.resolution_bucket as enum ('RESOLVED', 'IN_PROGRESS', 'UNRESOLVED', 'NOT_CONTACTED');
create type public.display_mode as enum ('FULL_NAME', 'INITIALS', 'ANONYMOUS');
create type public.review_status as enum (
  'PENDING_MODERATION', 'PUBLISHED', 'CHANGES_REQUESTED', 'REJECTED', 'REMOVED'
);
create type public.review_change_type as enum (
  'SUBMITTED', 'PUBLISHED', 'CHANGES_REQUESTED', 'REJECTED', 'REMOVED', 'RESOLUTION_UPDATED'
);

create or replace function public.catalog_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.resolution_bucket_of(s public.resolution_status)
returns public.resolution_bucket
language sql
immutable
set search_path = ''
as $$
  select case s
    when 'RESOLVED' then 'RESOLVED'
    when 'CLOSED_UNRESOLVED' then 'UNRESOLVED'
    when 'NOT_CONTACTED' then 'NOT_CONTACTED'
    else 'IN_PROGRESS'
  end::public.resolution_bucket;
$$;

create or replace function public.name_initials(full_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(string_agg(upper(left(part, 1)) || '.', ' '), '')
  from regexp_split_to_table(btrim(full_name), '\s+') as part
  where part <> '';
$$;

-- ---------------------------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------------------------

create table public.companies (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name         text not null check (char_length(name) between 2 and 120),
  asset_class  public.asset_class not null,
  country      public.market_country not null,
  logo_url     text,
  description  text check (char_length(description) <= 2000),
  verified     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create trigger companies_set_updated_at
before update on public.companies
for each row execute function public.catalog_set_updated_at();

create index companies_asset_class_country_idx on public.companies (asset_class, country);
create index companies_name_trgm_idx on public.companies using gin (name extensions.gin_trgm_ops);

create table public.company_tags (
  company_id  uuid not null references public.companies (id) on delete cascade,
  tag         text not null check (char_length(tag) between 1 and 40),
  sort_order  integer not null default 0,
  primary key (company_id, tag)
);

-- Issuers (offers that investors rate). Read and rated through the Ratings module's APIs.
create table public.issuers (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name            text not null check (char_length(name) between 2 and 120),
  instrument      text not null check (char_length(instrument) between 1 and 60),
  asset_type      text not null check (char_length(asset_type) between 1 and 40),
  exchange        text check (char_length(exchange) <= 60),
  open_date       date,
  close_date      date,
  is_listed       boolean not null default false,
  min_lot         integer check (min_lot > 0),
  lot_unit        text not null default 'shares' check (char_length(lot_unit) <= 20),
  price_min       numeric(18, 2) check (price_min >= 0),
  price_max       numeric(18, 2) check (price_max >= price_min),
  offer_size      numeric(18, 2) check (offer_size >= 0),
  currency        char(3) not null default 'INR' check (currency in ('INR', 'USD', 'EUR', 'GBP', 'AED')),
  use_of_funds    text check (char_length(use_of_funds) <= 200),
  lock_in         text check (char_length(lock_in) <= 60),
  pre_post_ratio  text check (char_length(pre_post_ratio) <= 30),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  check (close_date is null or open_date is null or close_date >= open_date)
);

create trigger issuers_set_updated_at
before update on public.issuers
for each row execute function public.catalog_set_updated_at();

create index issuers_asset_type_close_date_idx on public.issuers (asset_type, close_date);
create index issuers_name_trgm_idx on public.issuers using gin (name extensions.gin_trgm_ops);

create table public.issuer_tags (
  issuer_id   uuid not null references public.issuers (id) on delete cascade,
  tag         text not null check (char_length(tag) between 1 and 40),
  sort_order  integer not null default 0,
  primary key (issuer_id, tag)
);

-- Evidence files (PDF/JPG/PNG, max 10 MB) are stored privately under <user_id>/<file>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-evidence', 'review-evidence', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------------------------

create sequence public.review_receipt_seq;

create table public.reviews (
  id                       uuid primary key default gen_random_uuid(),
  receipt_no               text not null unique default (
                             'GIG-RV-' || to_char(now(), 'YYYY') || '-' ||
                             lpad(nextval('public.review_receipt_seq')::text, 6, '0')
                           ),
  user_id                  uuid not null references auth.users (id) on delete cascade,
  company_id               uuid not null references public.companies (id),
  -- Reviewer's name when the review was submitted; shown per display_mode.
  author_name              text not null default '' check (char_length(author_name) <= 120),

  -- Step 1: entity and product
  country                  public.market_country not null,
  asset_class              public.asset_class not null,
  product_scheme           text not null default '' check (char_length(product_scheme) <= 200),
  investment_year          smallint check (investment_year between 1950 and 2100), -- null = older
  investment_status        public.investment_status not null,

  -- Steps 2-3: sentiment and experience
  sentiment                public.sentiment not null,
  detailed_review          text check (char_length(detailed_review) between 10 and 800),
  mixed_review             text check (char_length(mixed_review) between 10 and 800),
  negative_description     text check (char_length(negative_description) between 10 and 800),
  reinvest_status          public.reinvest_status,

  -- Step 4: metrics (1-5)
  m_transparency           smallint not null check (m_transparency between 1 and 5),
  m_responsiveness         smallint not null check (m_responsiveness between 1 and 5),
  m_ease_of_process        smallint not null check (m_ease_of_process between 1 and 5),
  m_trustworthiness        smallint not null check (m_trustworthiness between 1 and 5),
  m_overall_satisfaction   smallint not null check (m_overall_satisfaction between 1 and 5),

  -- Step 5: resolution (reviewer-owned)
  resolution_status        public.resolution_status not null,
  follow_up_note           text check (char_length(follow_up_note) <= 400),

  -- Step 6: declarations and privacy
  display_mode             public.display_mode not null default 'FULL_NAME',
  allow_contact            boolean not null default false,
  declarations_version     text not null,
  declarations_accepted_at timestamptz not null default now(),

  -- Moderation
  status                   public.review_status not null default 'PENDING_MODERATION',
  moderation_note          text,
  published_at             timestamptz,

  -- Idempotency-Key of the submitting request, so a retry returns this review instead of a copy.
  idempotency_key          text check (char_length(idempotency_key) between 8 and 128),
  request_hash             text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,

  constraint reviews_positive_fields check (
    sentiment <> 'Positive' or (detailed_review is not null and reinvest_status is not null)
  ),
  constraint reviews_neutral_fields check (
    sentiment <> 'Neutral' or (mixed_review is not null and detailed_review is not null)
  ),
  constraint reviews_negative_fields check (
    sentiment <> 'Negative' or negative_description is not null
  )
);

create trigger reviews_set_updated_at
before update on public.reviews
for each row execute function public.catalog_set_updated_at();

-- One active review per investor, company and product/scheme.
create unique index reviews_one_active_per_product_idx
  on public.reviews (user_id, company_id, lower(product_scheme))
  where deleted_at is null and status not in ('REJECTED', 'REMOVED');

create unique index reviews_idempotency_key_idx
  on public.reviews (user_id, idempotency_key)
  where idempotency_key is not null;

create index reviews_company_feed_idx on public.reviews (company_id, status, created_at desc);
create index reviews_user_idx on public.reviews (user_id, created_at desc);

-- Appreciations (positive), concerns and contact statuses (negative). Codes match the app's lists.
create table public.review_tags (
  review_id  uuid not null references public.reviews (id) on delete cascade,
  tag_type   text not null check (tag_type in ('APPRECIATION', 'CONCERN', 'CONTACT_STATUS')),
  code       text not null,
  primary key (review_id, tag_type, code),
  constraint review_tags_code_valid check (
    (tag_type = 'APPRECIATION' and code in (
      'TRANSPARENT_COMMUNICATION', 'TIMELY_PAYOUTS', 'PRODUCT_PERFORMANCE', 'CUSTOMER_SERVICE',
      'EASE_OF_ONBOARDING', 'CLAIM_SETTLEMENT', 'DIGITAL_EXPERIENCE', 'ETHICAL_CONDUCT', 'OTHER'))
    or (tag_type = 'CONCERN' and code in (
      'MIS_SELLING', 'DELAY_IN_RESPONSE', 'NON_FULFILMENT', 'HIDDEN_CHARGES', 'CLAIM_REJECTION',
      'POOR_PERFORMANCE', 'EXIT_DIFFICULTY', 'DOCUMENTATION_ISSUE', 'OTHER'))
    or (tag_type = 'CONTACT_STATUS' and code in (
      'NOT_CONTACTED', 'CONTACTED_NO_RESPONSE', 'IN_DISCUSSION', 'RESOLVED', 'NOT_RESOLVED'))
  )
);

-- Supporting documents: objects in the review-evidence bucket, each attached to one review only.
create table public.review_attachments (
  review_id     uuid not null references public.reviews (id) on delete cascade,
  storage_path  text not null unique
                check (storage_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,200}$'),
  doc_type      text not null
                check (doc_type in ('EMAIL', 'STATEMENT', 'POLICY_DOCUMENT', 'SCREENSHOT')),
  created_at    timestamptz not null default now(),
  primary key (review_id, storage_path)
);

-- Status timeline: submission, moderation decisions and resolution updates.
create table public.review_versions (
  id           bigint generated always as identity primary key,
  review_id    uuid not null references public.reviews (id) on delete cascade,
  change_type  public.review_change_type not null,
  from_value   text,
  to_value     text,
  note         text,
  actor_id     uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index review_versions_review_idx on public.review_versions (review_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Aggregates
-- ---------------------------------------------------------------------------------------------

create table public.company_stats (
  company_id                uuid primary key references public.companies (id) on delete cascade,
  review_count              integer not null default 0,
  -- Weighted mean of overall satisfaction: 1.0 for new reviews, decaying linearly to 0.5 at 24 months.
  score                     numeric(3, 2) not null default 0,
  relevance                 numeric(10, 4) not null default 0,
  avg_transparency          numeric(3, 2) not null default 0,
  avg_responsiveness        numeric(3, 2) not null default 0,
  avg_ease_of_process       numeric(3, 2) not null default 0,
  avg_trustworthiness       numeric(3, 2) not null default 0,
  avg_overall_satisfaction  numeric(3, 2) not null default 0,
  positive_pct              numeric(5, 2) not null default 0,
  neutral_pct               numeric(5, 2) not null default 0,
  negative_pct              numeric(5, 2) not null default 0,
  dominant_sentiment        public.sentiment,
  resolved_pct              numeric(5, 2) not null default 0,
  in_progress_pct           numeric(5, 2) not null default 0,
  unresolved_pct            numeric(5, 2) not null default 0,
  not_contacted_pct         numeric(5, 2) not null default 0,
  dominant_resolution       public.resolution_bucket,
  reviews_30d               integer not null default 0,
  score_change_12m          numeric(4, 2) not null default 0,
  last_review_at            timestamptz,
  updated_at                timestamptz not null default now()
);

create index company_stats_score_idx on public.company_stats (score desc);

-- Monthly buckets for the 12-month, 24-month and all-time trend charts.
create table public.company_trend_points (
  company_id      uuid not null references public.companies (id) on delete cascade,
  month           date not null,
  review_count    integer not null,
  overall_sum     integer not null,
  positive_count  integer not null,
  primary key (company_id, month)
);

create or replace function public.recompute_company_stats(p_company_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.company_trend_points where company_id = p_company_id;

  insert into public.company_trend_points (company_id, month, review_count, overall_sum, positive_count)
  select r.company_id,
         date_trunc('month', r.created_at)::date,
         count(*),
         sum(r.m_overall_satisfaction),
         count(*) filter (where r.sentiment = 'Positive')
  from public.reviews r
  where r.company_id = p_company_id and r.status = 'PUBLISHED' and r.deleted_at is null
  group by r.company_id, date_trunc('month', r.created_at);

  delete from public.company_stats where company_id = p_company_id;

  insert into public.company_stats (
    company_id, review_count, score, relevance,
    avg_transparency, avg_responsiveness, avg_ease_of_process, avg_trustworthiness,
    avg_overall_satisfaction,
    positive_pct, neutral_pct, negative_pct, dominant_sentiment,
    resolved_pct, in_progress_pct, unresolved_pct, not_contacted_pct, dominant_resolution,
    reviews_30d, score_change_12m, last_review_at
  )
  with published as (
    select r.*,
           greatest(0.5, 1 - 0.5 * extract(epoch from now() - r.created_at) / (730 * 86400.0)) as weight,
           public.resolution_bucket_of(r.resolution_status) as bucket
    from public.reviews r
    where r.company_id = p_company_id and r.status = 'PUBLISHED' and r.deleted_at is null
  ),
  agg as (
    select count(*)::integer as n,
           coalesce(sum(weight * m_overall_satisfaction) / nullif(sum(weight), 0), 0) as score,
           coalesce(avg(m_transparency), 0) as t,
           coalesce(avg(m_responsiveness), 0) as rs,
           coalesce(avg(m_ease_of_process), 0) as e,
           coalesce(avg(m_trustworthiness), 0) as tw,
           coalesce(avg(m_overall_satisfaction), 0) as o,
           count(*) filter (where sentiment = 'Positive') as pos,
           count(*) filter (where sentiment = 'Neutral') as neu,
           count(*) filter (where sentiment = 'Negative') as neg,
           count(*) filter (where bucket = 'RESOLVED') as res,
           count(*) filter (where bucket = 'IN_PROGRESS') as inp,
           count(*) filter (where bucket = 'UNRESOLVED') as unr,
           count(*) filter (where bucket = 'NOT_CONTACTED') as nc,
           count(*) filter (where created_at > now() - interval '30 days')::integer as recent,
           avg(m_overall_satisfaction) filter (where created_at <= now() - interval '12 months')
             as o_12m_ago,
           max(created_at) as last_at
    from published
  )
  select p_company_id, n, round(score, 2), round(score * ln((1 + n)::numeric), 4),
         round(t, 2), round(rs, 2), round(e, 2), round(tw, 2), round(o, 2),
         coalesce(round(100.0 * pos / nullif(n, 0), 2), 0),
         coalesce(round(100.0 * neu / nullif(n, 0), 2), 0),
         coalesce(round(100.0 * neg / nullif(n, 0), 2), 0),
         case when n = 0 then null
              when pos >= neu and pos >= neg then 'Positive'
              when neu >= neg then 'Neutral'
              else 'Negative' end::public.sentiment,
         coalesce(round(100.0 * res / nullif(n, 0), 2), 0),
         coalesce(round(100.0 * inp / nullif(n, 0), 2), 0),
         coalesce(round(100.0 * unr / nullif(n, 0), 2), 0),
         coalesce(round(100.0 * nc / nullif(n, 0), 2), 0),
         case when n = 0 then null
              when res >= inp and res >= unr and res >= nc then 'RESOLVED'
              when inp >= unr and inp >= nc then 'IN_PROGRESS'
              when unr >= nc then 'UNRESOLVED'
              else 'NOT_CONTACTED' end::public.resolution_bucket,
         recent,
         coalesce(round(o - o_12m_ago, 2), 0),
         last_at
  from agg;
end;
$$;

-- Age-based score decay changes daily, so schedule this nightly (e.g. pg_cron):
--   select cron.schedule('recompute-company-stats', '15 0 * * *', 'select public.recompute_all_company_stats()');
create or replace function public.recompute_all_company_stats()
returns void
language plpgsql
set search_path = ''
as $$
declare
  c record;
begin
  for c in select id from public.companies where deleted_at is null loop
    perform public.recompute_company_stats(c.id);
  end loop;
end;
$$;

create or replace function public.reviews_refresh_stats()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'PUBLISHED' then
      perform public.recompute_company_stats(new.company_id);
    end if;
  elsif tg_op = 'DELETE' then
    if old.status = 'PUBLISHED' then
      perform public.recompute_company_stats(old.company_id);
    end if;
  elsif old.status = 'PUBLISHED' or new.status = 'PUBLISHED' then
    perform public.recompute_company_stats(new.company_id);
    if old.company_id <> new.company_id then
      perform public.recompute_company_stats(old.company_id);
    end if;
  end if;
  return null;
end;
$$;

create trigger reviews_refresh_stats
after insert or update or delete on public.reviews
for each row execute function public.reviews_refresh_stats();

-- ---------------------------------------------------------------------------------------------
-- Read models
-- ---------------------------------------------------------------------------------------------

create view public.company_cards with (security_invoker = true) as
select c.id,
       c.slug,
       c.name,
       c.description,
       c.asset_class,
       c.country,
       c.logo_url,
       c.verified,
       c.created_at,
       array(
         select t.tag from public.company_tags t
         where t.company_id = c.id
         order by t.sort_order, t.tag
       ) as tags,
       coalesce(s.review_count, 0) as review_count,
       coalesce(s.score, 0) as score,
       coalesce(s.relevance, 0) as relevance,
       coalesce(s.avg_transparency, 0) as avg_transparency,
       coalesce(s.avg_responsiveness, 0) as avg_responsiveness,
       coalesce(s.avg_ease_of_process, 0) as avg_ease_of_process,
       coalesce(s.avg_trustworthiness, 0) as avg_trustworthiness,
       coalesce(s.avg_overall_satisfaction, 0) as avg_overall_satisfaction,
       coalesce(s.positive_pct, 0) as positive_pct,
       coalesce(s.neutral_pct, 0) as neutral_pct,
       coalesce(s.negative_pct, 0) as negative_pct,
       s.dominant_sentiment,
       coalesce(s.resolved_pct, 0) as resolved_pct,
       coalesce(s.in_progress_pct, 0) as in_progress_pct,
       coalesce(s.unresolved_pct, 0) as unresolved_pct,
       coalesce(s.not_contacted_pct, 0) as not_contacted_pct,
       s.dominant_resolution,
       coalesce(s.reviews_30d, 0) as reviews_30d,
       coalesce(s.score_change_12m, 0) as score_change_12m,
       s.last_review_at
from public.companies c
left join public.company_stats s on s.company_id = c.id
where c.deleted_at is null;

-- Published reviews with the author's name resolved per display mode. Never exposes user_id.
create view public.review_feed with (security_invoker = true) as
select r.id,
       r.company_id,
       r.country,
       r.asset_class,
       r.product_scheme,
       r.investment_year,
       r.investment_status,
       r.sentiment,
       r.detailed_review,
       r.mixed_review,
       r.negative_description,
       r.reinvest_status,
       r.m_transparency,
       r.m_responsiveness,
       r.m_ease_of_process,
       r.m_trustworthiness,
       r.m_overall_satisfaction,
       round((r.m_transparency + r.m_responsiveness + r.m_ease_of_process + r.m_trustworthiness
              + r.m_overall_satisfaction) / 5.0, 1) as avg_rating,
       r.resolution_status,
       public.resolution_bucket_of(r.resolution_status) as resolution_bucket,
       r.follow_up_note,
       r.display_mode,
       case r.display_mode
         when 'ANONYMOUS' then null
         when 'INITIALS' then public.name_initials(r.author_name)
         else nullif(btrim(r.author_name), '')
       end as author_name,
       array(
         select t.code from public.review_tags t
         where t.review_id = r.id and t.tag_type = 'APPRECIATION' order by t.code
       ) as appreciations,
       array(
         select t.code from public.review_tags t
         where t.review_id = r.id and t.tag_type = 'CONCERN' order by t.code
       ) as concerns,
       array(
         select t.code from public.review_tags t
         where t.review_id = r.id and t.tag_type = 'CONTACT_STATUS' order by t.code
       ) as contact_statuses,
       r.created_at,
       r.published_at
from public.reviews r
where r.status = 'PUBLISHED' and r.deleted_at is null;

-- Company list filters. Sorting, paging and counting are applied by the API on the result.
-- Investment status and year match companies that have a published review with those values.
create or replace function public.search_companies(
  p_q                   text default null,
  p_sentiments          public.sentiment[] default null,
  p_asset_classes       public.asset_class[] default null,
  p_resolutions         public.resolution_bucket[] default null,
  p_scores              integer[] default null,
  p_countries           public.market_country[] default null,
  p_investment_statuses public.investment_status[] default null,
  p_years               integer[] default null,
  p_years_before        integer default null
)
returns setof public.company_cards
language sql
stable
set search_path = ''
as $$
  select cc.*
  from public.company_cards cc
  where (p_q is null
         or cc.name ilike '%' || p_q || '%'
         or exists (select 1 from unnest(cc.tags) tag where tag ilike '%' || p_q || '%'))
    and (p_sentiments is null or cc.dominant_sentiment = any (p_sentiments))
    and (p_asset_classes is null or cc.asset_class = any (p_asset_classes))
    and (p_resolutions is null or cc.dominant_resolution = any (p_resolutions))
    and (p_scores is null or (cc.review_count > 0 and round(cc.score)::integer = any (p_scores)))
    and (p_countries is null or cc.country = any (p_countries))
    and (
      (p_investment_statuses is null and p_years is null and p_years_before is null)
      or exists (
        select 1 from public.reviews r
        where r.company_id = cc.id
          and r.status = 'PUBLISHED'
          and r.deleted_at is null
          and (p_investment_statuses is null or r.investment_status = any (p_investment_statuses))
          and (
            (p_years is null and p_years_before is null)
            or r.investment_year = any (p_years)
            or (p_years_before is not null
                and (r.investment_year is null or r.investment_year < p_years_before))
          )
      )
    );
$$;

-- ---------------------------------------------------------------------------------------------
-- Write operations (one transaction each)
-- ---------------------------------------------------------------------------------------------

-- Inserts a review with its tags and evidence. The API validates input (and checks the evidence
-- objects exist in Storage) first; the constraints here are the backstop. Raises EVIDENCE_INVALID
-- if an evidence path is outside the caller's folder or already attached to a review.
create or replace function public.submit_review(
  p_user_id               uuid,
  p_idempotency_key       text,
  p_request_hash          text,
  p_author_name           text,
  p_company_id            uuid,
  p_country               public.market_country,
  p_asset_class           public.asset_class,
  p_product_scheme        text,
  p_investment_year       integer,
  p_investment_status     public.investment_status,
  p_sentiment             public.sentiment,
  p_detailed_review       text,
  p_mixed_review          text,
  p_negative_description  text,
  p_reinvest_status       public.reinvest_status,
  p_appreciations         text[],
  p_concerns              text[],
  p_contact_statuses      text[],
  p_evidence_paths        text[],
  p_evidence_doc_types    text[],
  p_m_transparency        integer,
  p_m_responsiveness      integer,
  p_m_ease_of_process     integer,
  p_m_trustworthiness     integer,
  p_m_overall_satisfaction integer,
  p_resolution_status     public.resolution_status,
  p_follow_up_note        text,
  p_display_mode          public.display_mode,
  p_allow_contact         boolean,
  p_declarations_version  text
)
returns table (id uuid, receipt_no text, status public.review_status, created_at timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_review public.reviews;
begin
  if coalesce(cardinality(p_evidence_paths), 0) <> coalesce(cardinality(p_evidence_doc_types), 0)
     or exists (
       select 1 from unnest(p_evidence_paths) as p (path)
       where p.path not like p_user_id::text || '/%'
     )
     or exists (
       select 1 from public.review_attachments a where a.storage_path = any (p_evidence_paths)
     ) then
    raise exception 'EVIDENCE_INVALID';
  end if;

  insert into public.reviews (
    user_id, idempotency_key, request_hash, author_name, company_id, country, asset_class,
    product_scheme, investment_year, investment_status,
    sentiment, detailed_review, mixed_review, negative_description, reinvest_status,
    m_transparency, m_responsiveness, m_ease_of_process, m_trustworthiness, m_overall_satisfaction,
    resolution_status, follow_up_note, display_mode, allow_contact, declarations_version
  ) values (
    p_user_id, p_idempotency_key, p_request_hash, coalesce(p_author_name, ''), p_company_id,
    p_country, p_asset_class, coalesce(p_product_scheme, ''),
    p_investment_year, p_investment_status,
    p_sentiment, p_detailed_review, p_mixed_review, p_negative_description, p_reinvest_status,
    p_m_transparency, p_m_responsiveness, p_m_ease_of_process, p_m_trustworthiness,
    p_m_overall_satisfaction,
    p_resolution_status, p_follow_up_note, p_display_mode, p_allow_contact, p_declarations_version
  )
  returning * into v_review;

  insert into public.review_tags (review_id, tag_type, code)
  select v_review.id, 'APPRECIATION', code from unnest(p_appreciations) code
  union
  select v_review.id, 'CONCERN', code from unnest(p_concerns) code
  union
  select v_review.id, 'CONTACT_STATUS', code from unnest(p_contact_statuses) code;

  insert into public.review_attachments (review_id, storage_path, doc_type)
  select v_review.id, e.path, e.doc_type
  from unnest(p_evidence_paths, p_evidence_doc_types) as e (path, doc_type);

  insert into public.review_versions (review_id, change_type, to_value, actor_id)
  values (v_review.id, 'SUBMITTED', v_review.status::text, p_user_id);

  return query select v_review.id, v_review.receipt_no, v_review.status, v_review.created_at;
end;
$$;

-- Reviewer-only update of resolution status and follow-up note (the note is left unchanged when
-- p_update_note is false). Raises REVIEW_NOT_FOUND when the review does not exist, is not the
-- caller's, or is no longer active.
create or replace function public.update_review_resolution(
  p_user_id            uuid,
  p_review_id          uuid,
  p_resolution_status  public.resolution_status,
  p_follow_up_note     text,
  p_update_note        boolean
)
returns table (
  id uuid,
  resolution_status public.resolution_status,
  follow_up_note text,
  updated_at timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  v_previous public.resolution_status;
  v_review public.reviews;
begin
  select r.resolution_status into v_previous
  from public.reviews r
  where r.id = p_review_id
    and r.user_id = p_user_id
    and r.deleted_at is null
    and r.status not in ('REJECTED', 'REMOVED')
  for update;

  if not found then
    raise exception 'REVIEW_NOT_FOUND';
  end if;

  update public.reviews r
  set resolution_status = p_resolution_status,
      follow_up_note = case when p_update_note then p_follow_up_note else r.follow_up_note end
  where r.id = p_review_id
  returning * into v_review;

  insert into public.review_versions (review_id, change_type, from_value, to_value, note, actor_id)
  values (p_review_id, 'RESOLUTION_UPDATED', v_previous::text, p_resolution_status::text,
          v_review.follow_up_note, p_user_id);

  return query
  select v_review.id, v_review.resolution_status, v_review.follow_up_note, v_review.updated_at;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Access: the API uses the service role. Block direct access from app clients.
-- ---------------------------------------------------------------------------------------------

alter table public.companies enable row level security;
alter table public.company_tags enable row level security;
alter table public.issuers enable row level security;
alter table public.issuer_tags enable row level security;
alter table public.reviews enable row level security;
alter table public.review_tags enable row level security;
alter table public.review_attachments enable row level security;
alter table public.review_versions enable row level security;
alter table public.company_stats enable row level security;
alter table public.company_trend_points enable row level security;

revoke all on public.company_cards, public.review_feed from anon, authenticated;

revoke execute on function
  public.search_companies(text, public.sentiment[], public.asset_class[], public.resolution_bucket[],
                          integer[], public.market_country[], public.investment_status[], integer[],
                          integer),
  public.submit_review(uuid, text, text, text, uuid, public.market_country, public.asset_class,
                       text, integer, public.investment_status, public.sentiment, text, text, text,
                       public.reinvest_status, text[], text[], text[], text[], text[], integer,
                       integer, integer, integer, integer, public.resolution_status, text,
                       public.display_mode, boolean, text),
  public.update_review_resolution(uuid, uuid, public.resolution_status, text, boolean),
  public.recompute_company_stats(uuid),
  public.recompute_all_company_stats()
from public, anon, authenticated;
