-- The Review section serves exactly what the app shows. The app's screens are the specification:
--
-- 1. Negative reviews: the app collects the supporting document types (Email, Statement, Policy,
--    Screenshot) without uploading files, so the types are stored as review tags and files become
--    optional (src/modules/reviews/reviews.schemas.ts).
-- 2. Trend panels: the app shows, per range (12M / 24M / All time), a value, a change label and a
--    curve that are content in their own right (they cannot be derived from monthly review
--    counts). They are stored in company_trend_series and served by GET /companies/:id/trends.
-- 3. Figures: the app's figures per company (review count, rating, sentiment split, scorecard,
--    resolution lens) are content too. They are stored as a baseline (company_baseline_stats) and
--    recompute_company_stats adds the published reviews to it, so 278 reviews plus one published
--    review shows 279, and the percentages and averages move by that one review.
-- 4. Content: the app's companies, baselines and trends, plus the reviews shown under Top
--    Reviews, so that every figure comes out exactly as the app shows it.

-- ---------------------------------------------------------------------------------------------
-- 1. Document types on reviews
-- ---------------------------------------------------------------------------------------------

alter table public.review_tags drop constraint review_tags_tag_type_check;
alter table public.review_tags drop constraint review_tags_code_valid;

alter table public.review_tags
  add constraint review_tags_tag_type_check
    check (tag_type in ('APPRECIATION', 'CONCERN', 'CONTACT_STATUS', 'DOCUMENT_TYPE')),
  add constraint review_tags_code_valid check (
    (tag_type = 'APPRECIATION' and code in (
      'TRANSPARENT_COMMUNICATION', 'TIMELY_PAYOUTS', 'PRODUCT_PERFORMANCE', 'CUSTOMER_SERVICE',
      'EASE_OF_ONBOARDING', 'CLAIM_SETTLEMENT', 'DIGITAL_EXPERIENCE', 'ETHICAL_CONDUCT', 'OTHER'))
    or (tag_type = 'CONCERN' and code in (
      'MIS_SELLING', 'DELAY_IN_RESPONSE', 'NON_FULFILMENT', 'HIDDEN_CHARGES', 'CLAIM_REJECTION',
      'POOR_PERFORMANCE', 'EXIT_DIFFICULTY', 'DOCUMENTATION_ISSUE', 'OTHER'))
    or (tag_type = 'CONTACT_STATUS' and code in (
      'NOT_CONTACTED', 'CONTACTED_NO_RESPONSE', 'IN_DISCUSSION', 'RESOLVED', 'NOT_RESOLVED'))
    or (tag_type = 'DOCUMENT_TYPE' and code in (
      'EMAIL', 'STATEMENT', 'POLICY_DOCUMENT', 'SCREENSHOT'))
  );

-- Same as before, plus p_document_types (stored as DOCUMENT_TYPE tags).
drop function public.submit_review(
  uuid, text, text, text, uuid, public.market_country, public.asset_class, text, integer,
  public.investment_status, public.sentiment, text, text, text, public.reinvest_status,
  text[], text[], text[], text[], text[], integer, integer, integer, integer, integer,
  public.resolution_status, text, public.display_mode, boolean, text
);

create function public.submit_review(
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
  p_declarations_version  text,
  p_document_types        text[] default '{}'
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
  select v_review.id, 'CONTACT_STATUS', code from unnest(p_contact_statuses) code
  union
  select v_review.id, 'DOCUMENT_TYPE', code from unnest(p_document_types) code;

  insert into public.review_attachments (review_id, storage_path, doc_type)
  select v_review.id, e.path, e.doc_type
  from unnest(p_evidence_paths, p_evidence_doc_types) as e (path, doc_type);

  insert into public.review_versions (review_id, change_type, to_value, actor_id)
  values (v_review.id, 'SUBMITTED', v_review.status::text, p_user_id);

  return query select v_review.id, v_review.receipt_no, v_review.status, v_review.created_at;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Stored trend series
-- ---------------------------------------------------------------------------------------------

-- One row per company, range and metric: what the app's trend panel shows. `change` carries the
-- sign (the label does not); `chart` is the curve, as the app's chart points [{x, y}].
create table public.company_trend_series (
  company_id    uuid not null references public.companies (id) on delete cascade,
  range         text not null check (range in ('12M', '24M', 'ALL')),
  metric        text not null check (metric in ('OVERALL_SATISFACTION', 'POSITIVE_SENTIMENT')),
  value         numeric(5, 2) not null,
  change        numeric(5, 2) not null,
  change_label  text not null check (char_length(change_label) between 1 and 40),
  chart         jsonb not null check (jsonb_typeof(chart) = 'array'),
  primary key (company_id, range, metric)
);

alter table public.company_trend_series enable row level security;
revoke all on public.company_trend_series from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Baseline figures
-- ---------------------------------------------------------------------------------------------

-- What a company's figures start from before its published reviews are added: totals, not
-- averages, so adding reviews is a plain sum. `score_sum` is the rating times the review count;
-- the counts may be fractional (they are percentages of the count). The dominant sentiment and
-- resolution and the 12-month change are the app's as given.
create table public.company_baseline_stats (
  company_id           uuid primary key references public.companies (id) on delete cascade,
  review_count         integer not null check (review_count >= 0),
  score_sum            numeric not null,
  transparency_sum     numeric not null,
  responsiveness_sum   numeric not null,
  ease_of_process_sum  numeric not null,
  trustworthiness_sum  numeric not null,
  overall_sum          numeric not null,
  positive_count       numeric not null,
  neutral_count        numeric not null,
  negative_count       numeric not null,
  resolved_count       numeric not null,
  in_progress_count    numeric not null,
  unresolved_count     numeric not null,
  not_contacted_count  numeric not null,
  dominant_sentiment   public.sentiment,
  dominant_resolution  public.resolution_bucket,
  score_change_12m     numeric(4, 2) not null default 0
);

alter table public.company_baseline_stats enable row level security;
revoke all on public.company_baseline_stats from anon, authenticated;

-- Same as before, except that the company's baseline (if any) is added to its published reviews.
-- Without a baseline the result is exactly what it was.
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
  real as (
    select count(*)::integer as n,
           coalesce(sum(weight), 0) as weight_sum,
           coalesce(sum(weight * m_overall_satisfaction), 0) as weighted_overall,
           coalesce(sum(m_transparency), 0) as t,
           coalesce(sum(m_responsiveness), 0) as rs,
           coalesce(sum(m_ease_of_process), 0) as e,
           coalesce(sum(m_trustworthiness), 0) as tw,
           coalesce(sum(m_overall_satisfaction), 0) as o,
           count(*) filter (where sentiment = 'Positive') as pos,
           count(*) filter (where sentiment = 'Neutral') as neu,
           count(*) filter (where sentiment = 'Negative') as neg,
           count(*) filter (where bucket = 'RESOLVED') as res,
           count(*) filter (where bucket = 'IN_PROGRESS') as inp,
           count(*) filter (where bucket = 'UNRESOLVED') as unr,
           count(*) filter (where bucket = 'NOT_CONTACTED') as nc,
           count(*) filter (where created_at > now() - interval '30 days')::integer as recent,
           avg(m_overall_satisfaction) as o_avg,
           avg(m_overall_satisfaction) filter (where created_at <= now() - interval '12 months')
             as o_12m_ago,
           max(created_at) as last_at
    from published
  ),
  agg as (
    select (coalesce(b.review_count, 0) + r.n)::integer as n,
           coalesce((coalesce(b.score_sum, 0) + r.weighted_overall)
                    / nullif(coalesce(b.review_count, 0) + r.weight_sum, 0), 0) as score,
           coalesce(b.transparency_sum, 0) + r.t as t,
           coalesce(b.responsiveness_sum, 0) + r.rs as rs,
           coalesce(b.ease_of_process_sum, 0) + r.e as e,
           coalesce(b.trustworthiness_sum, 0) + r.tw as tw,
           coalesce(b.overall_sum, 0) + r.o as o,
           coalesce(b.positive_count, 0) + r.pos as pos,
           coalesce(b.neutral_count, 0) + r.neu as neu,
           coalesce(b.negative_count, 0) + r.neg as neg,
           coalesce(b.resolved_count, 0) + r.res as res,
           coalesce(b.in_progress_count, 0) + r.inp as inp,
           coalesce(b.unresolved_count, 0) + r.unr as unr,
           coalesce(b.not_contacted_count, 0) + r.nc as nc,
           r.recent,
           r.last_at,
           b.company_id is not null as has_baseline,
           b.dominant_sentiment as baseline_sentiment,
           b.dominant_resolution as baseline_resolution,
           coalesce(b.score_change_12m, round(r.o_avg - r.o_12m_ago, 2), 0) as change_12m
    from real r
    left join public.company_baseline_stats b on b.company_id = p_company_id
  )
  select p_company_id, n, round(score, 2), round(score * ln((1 + n)::numeric), 4),
         coalesce(round(t / nullif(n, 0), 2), 0),
         coalesce(round(rs / nullif(n, 0), 2), 0),
         coalesce(round(e / nullif(n, 0), 2), 0),
         coalesce(round(tw / nullif(n, 0), 2), 0),
         coalesce(round(o / nullif(n, 0), 2), 0),
         coalesce(round(100.0 * pos / nullif(n, 0), 2), 0),
         coalesce(round(100.0 * neu / nullif(n, 0), 2), 0),
         coalesce(round(100.0 * neg / nullif(n, 0), 2), 0),
         case when has_baseline then baseline_sentiment
              when n = 0 then null
              when pos >= neu and pos >= neg then 'Positive'
              when neu >= neg then 'Neutral'
              else 'Negative' end::public.sentiment,
         coalesce(round(100.0 * res / nullif(n, 0), 2), 0),
         coalesce(round(100.0 * inp / nullif(n, 0), 2), 0),
         coalesce(round(100.0 * unr / nullif(n, 0), 2), 0),
         coalesce(round(100.0 * nc / nullif(n, 0), 2), 0),
         case when has_baseline then baseline_resolution
              when n = 0 then null
              when res >= inp and res >= unr and res >= nc then 'RESOLVED'
              when inp >= unr and inp >= nc then 'IN_PROGRESS'
              when unr >= nc then 'UNRESOLVED'
              else 'NOT_CONTACTED' end::public.resolution_bucket,
         recent,
         change_12m,
         last_at
  from agg;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Content (from the app's src/data.ts and src/constants/Review.ts)
-- ---------------------------------------------------------------------------------------------

-- Companies, in the app's order. The app lists two companies twice (Zenith Capital, Astra
-- Mutuals), so the copies get their own slugs.
insert into public.companies (slug, name, asset_class, country, created_at) values
  ('astra-mutuals', 'Astra Mutuals', 'MF', 'IN', '2026-05-01T10:00:00Z'),
  ('zenith-capital', 'Zenith Capital', 'EQ', 'AE', '2026-04-28T09:30:00Z'),
  ('zenith-capital-2', 'Zenith Capital', 'EQ', 'AE', '2026-04-28T09:30:00Z'),
  ('nexa-funds', 'Nexa Funds', 'MF', 'IN', '2026-05-05T12:00:00Z'),
  ('summit-banking', 'Summit Banking', 'BRK', 'IN', '2026-05-09T16:00:00Z'),
  ('prime-fincorp', 'Prime Fincorp', 'BND', 'AE', '2026-01-20T10:00:00Z'),
  ('astra-mutuals-2', 'Astra Mutuals', 'MF', 'IN', '2026-05-01T10:00:00Z')
on conflict (slug) do update set
  name = excluded.name,
  asset_class = excluded.asset_class,
  country = excluded.country,
  created_at = excluded.created_at,
  deleted_at = null;

delete from public.company_tags
where company_id in (
  select id from public.companies
  where slug in ('astra-mutuals', 'zenith-capital', 'zenith-capital-2', 'nexa-funds',
                 'summit-banking', 'prime-fincorp', 'astra-mutuals-2')
);

insert into public.company_tags (company_id, tag, sort_order)
select c.id, t.tag, t.sort_order
from (values
  ('astra-mutuals', 'Large CAP Stocks', 1), ('astra-mutuals', 'ETF', 2), ('astra-mutuals', 'IPO', 3),
  ('zenith-capital', 'ETF', 1), ('zenith-capital', 'IPO', 2),
  ('zenith-capital-2', 'ETF', 1), ('zenith-capital-2', 'IPO', 2),
  ('nexa-funds', 'ETF', 1), ('nexa-funds', 'Large CAP Stocks', 2), ('nexa-funds', 'IPO', 3),
  ('summit-banking', 'Safe', 1), ('summit-banking', 'Liquid', 2), ('summit-banking', 'IPO', 3),
  ('prime-fincorp', 'Corporate Bonds', 1), ('prime-fincorp', 'High Yield', 2), ('prime-fincorp', 'IPO', 3),
  ('astra-mutuals-2', 'Large CAP Stocks', 1), ('astra-mutuals-2', 'ETF', 2), ('astra-mutuals-2', 'IPO', 3)
) as t (slug, tag, sort_order)
join public.companies c on c.slug = t.slug;

-- The reviewers behind the Top Reviews (one account per review kind, so each company can carry
-- one review of each). They cannot sign in: the password hash is not a valid hash.
insert into app.users (public_id, email, phone_country_code, phone, password_hash,
                       email_verified_at, phone_verified_at)
values
  ('5e1d0a1e-0000-4000-8000-000000000001', 'top-reviewer-positive@reviews.gig.invalid', '+91',
   '+910000000001', '!', now(), now()),
  ('5e1d0a1e-0000-4000-8000-000000000002', 'top-reviewer-negative@reviews.gig.invalid', '+91',
   '+910000000002', '!', now(), now()),
  ('5e1d0a1e-0000-4000-8000-000000000003', 'top-reviewer-neutral@reviews.gig.invalid', '+91',
   '+910000000003', '!', now(), now())
on conflict do nothing;

insert into app.user_profiles (user_id, name)
select u.id, 'Shreya Mehta'
from app.users u
where u.public_id in ('5e1d0a1e-0000-4000-8000-000000000001',
                      '5e1d0a1e-0000-4000-8000-000000000002',
                      '5e1d0a1e-0000-4000-8000-000000000003')
on conflict do nothing;

-- The three Top Reviews (positive, negative, neutral) on every company, published. Their text,
-- tags, metrics, "would invest again" and resolution are the app's; the year and investment
-- status are the company's, so the year and invested-status filters keep matching it.
with kinds (user_id, sentiment) as (
  values
    ('5e1d0a1e-0000-4000-8000-000000000001'::uuid, 'Positive'::public.sentiment),
    ('5e1d0a1e-0000-4000-8000-000000000002'::uuid, 'Negative'::public.sentiment),
    ('5e1d0a1e-0000-4000-8000-000000000003'::uuid, 'Neutral'::public.sentiment)
),
per_company (slug, investment_year, investment_status) as (
  values
    ('astra-mutuals', 2025, 'CURRENTLY_INVESTED'),
    ('zenith-capital', 2024, 'CURRENTLY_INVESTED'),
    ('zenith-capital-2', 2024, 'CURRENTLY_INVESTED'),
    ('nexa-funds', 2021, 'CURRENTLY_INVESTED'),
    ('summit-banking', 2025, 'CURRENTLY_INVESTED'),
    ('prime-fincorp', 2022, 'NEVER_INVESTED'),
    ('astra-mutuals-2', 2025, 'CURRENTLY_INVESTED')
)
insert into public.reviews (
  user_id, company_id, author_name, country, asset_class, product_scheme, investment_year,
  investment_status, sentiment, detailed_review, mixed_review, negative_description,
  reinvest_status, m_transparency, m_responsiveness, m_ease_of_process, m_trustworthiness,
  m_overall_satisfaction, resolution_status, display_mode, declarations_version,
  status, published_at
)
select k.user_id, c.id, 'Shreya Mehta', c.country, c.asset_class, 'Insurance', p.investment_year,
       p.investment_status::public.investment_status, k.sentiment,
       'Genuine experience and factual knowledge.',
       case when k.sentiment = 'Neutral' then 'Genuine experience and factual knowledge.' end,
       case when k.sentiment = 'Negative' then 'Genuine experience and factual knowledge.' end,
       'MAYBE', 4, 2, 2, 2, 3, 'CONTACTED', 'FULL_NAME', '2026-10',
       'PUBLISHED', now()
from kinds k
cross join per_company p
join public.companies c on c.slug = p.slug
on conflict do nothing;

insert into public.review_tags (review_id, tag_type, code)
select r.id, t.tag_type, t.code
from public.reviews r
join (values
  ('5e1d0a1e-0000-4000-8000-000000000001'::uuid, 'APPRECIATION', 'TRANSPARENT_COMMUNICATION'),
  ('5e1d0a1e-0000-4000-8000-000000000001'::uuid, 'APPRECIATION', 'DIGITAL_EXPERIENCE'),
  ('5e1d0a1e-0000-4000-8000-000000000001'::uuid, 'APPRECIATION', 'EASE_OF_ONBOARDING'),
  ('5e1d0a1e-0000-4000-8000-000000000001'::uuid, 'APPRECIATION', 'ETHICAL_CONDUCT'),
  ('5e1d0a1e-0000-4000-8000-000000000002'::uuid, 'CONTACT_STATUS', 'CONTACTED_NO_RESPONSE'),
  ('5e1d0a1e-0000-4000-8000-000000000002'::uuid, 'CONCERN', 'DELAY_IN_RESPONSE')
) as t (user_id, tag_type, code) on t.user_id = r.user_id
on conflict do nothing;

-- The companies' figures, as the app shows them, stored as baselines: the app's figure minus what
-- the published Top Reviews above contribute, so that adding them back gives the app's figure.
insert into public.company_baseline_stats (
  company_id, review_count, score_sum,
  transparency_sum, responsiveness_sum, ease_of_process_sum, trustworthiness_sum, overall_sum,
  positive_count, neutral_count, negative_count,
  resolved_count, in_progress_count, unresolved_count, not_contacted_count,
  dominant_sentiment, dominant_resolution, score_change_12m
)
select c.id,
       s.n - r.n,
       s.score * s.n - r.overall,
       s.t * s.n - r.t, s.rs * s.n - r.rs, s.e * s.n - r.e, s.tw * s.n - r.tw, s.o * s.n - r.overall,
       s.pos * s.n / 100.0 - r.pos, s.neu * s.n / 100.0 - r.neu, s.neg * s.n / 100.0 - r.neg,
       s.res * s.n / 100.0 - r.res, s.inp * s.n / 100.0 - r.inp, s.unr * s.n / 100.0 - r.unr,
       0 - r.nc,
       s.sentiment::public.sentiment, s.resolution::public.resolution_bucket, s.change_12m
from (values
  ('astra-mutuals', 278, 4.6, 4.5, 4.2, 4.8, 4.7, 4.6, 72, 18, 10, 'Positive', 85, 10, 5, 'RESOLVED', 0.3),
  ('zenith-capital', 142, 4.9, 4.9, 4.8, 4.9, 4.9, 4.9, 88, 8, 4, 'Negative', 72, 20, 8, 'RESOLVED', 0.2),
  ('zenith-capital-2', 142, 4.9, 4.9, 4.8, 4.9, 4.9, 4.9, 88, 8, 4, 'Positive', 78, 20, 2, 'RESOLVED', 0.2),
  ('nexa-funds', 210, 4.8, 4.7, 4.6, 4.9, 4.8, 4.8, 82, 12, 6, 'Positive', 82, 12, 6, 'RESOLVED', 0.4),
  ('summit-banking', 540, 4.5, 4.8, 4.7, 4.2, 4.9, 4.5, 75, 20, 5, 'Neutral', 80, 16, 4, 'RESOLVED', 0.2),
  ('prime-fincorp', 88, 3.7, 3.2, 3, 3.5, 3.6, 3.7, 25, 35, 40, 'Negative', 35, 40, 25, 'NOT_CONTACTED', -0.8),
  ('astra-mutuals-2', 278, 4.6, 4.5, 4.2, 4.8, 4.7, 4.6, 72, 18, 10, 'Neutral', 85, 10, 5, 'RESOLVED', 0.3)
) as s (slug, n, score, t, rs, e, tw, o, pos, neu, neg, sentiment, res, inp, unr, resolution,
        change_12m)
join public.companies c on c.slug = s.slug
cross join lateral (
  select count(*) as n,
         coalesce(sum(m_overall_satisfaction), 0) as overall,
         coalesce(sum(m_transparency), 0) as t,
         coalesce(sum(m_responsiveness), 0) as rs,
         coalesce(sum(m_ease_of_process), 0) as e,
         coalesce(sum(m_trustworthiness), 0) as tw,
         count(*) filter (where sentiment = 'Positive') as pos,
         count(*) filter (where sentiment = 'Neutral') as neu,
         count(*) filter (where sentiment = 'Negative') as neg,
         count(*) filter (where public.resolution_bucket_of(resolution_status) = 'RESOLVED') as res,
         count(*) filter (where public.resolution_bucket_of(resolution_status) = 'IN_PROGRESS') as inp,
         count(*) filter (where public.resolution_bucket_of(resolution_status) = 'UNRESOLVED') as unr,
         count(*) filter (where public.resolution_bucket_of(resolution_status) = 'NOT_CONTACTED') as nc
  from public.reviews
  where company_id = c.id and status = 'PUBLISHED' and deleted_at is null
) r
on conflict (company_id) do update set
  review_count = excluded.review_count,
  score_sum = excluded.score_sum,
  transparency_sum = excluded.transparency_sum,
  responsiveness_sum = excluded.responsiveness_sum,
  ease_of_process_sum = excluded.ease_of_process_sum,
  trustworthiness_sum = excluded.trustworthiness_sum,
  overall_sum = excluded.overall_sum,
  positive_count = excluded.positive_count,
  neutral_count = excluded.neutral_count,
  negative_count = excluded.negative_count,
  resolved_count = excluded.resolved_count,
  in_progress_count = excluded.in_progress_count,
  unresolved_count = excluded.unresolved_count,
  not_contacted_count = excluded.not_contacted_count,
  dominant_sentiment = excluded.dominant_sentiment,
  dominant_resolution = excluded.dominant_resolution,
  score_change_12m = excluded.score_change_12m;

-- Figures = baseline + published reviews.
select public.recompute_company_stats(company_id) from public.company_baseline_stats;

-- The trend panels, as the app shows them.
insert into public.company_trend_series (company_id, range, metric, value, change, change_label, chart)
select c.id, s.range, s.metric, s.value, s.change, s.change_label, s.chart
from (values
  ('astra-mutuals', '12M', 'OVERALL_SATISFACTION', 4.6, 0.3, '0.3 vs 12M ago', '[{"x":0,"y":95},{"x":40,"y":70},{"x":80,"y":50},{"x":120,"y":40},{"x":156,"y":14}]'::jsonb),
  ('astra-mutuals', '12M', 'POSITIVE_SENTIMENT', 72, 5, '5pp vs 12M ago', '[{"x":0,"y":90},{"x":50,"y":65},{"x":100,"y":45},{"x":156,"y":14}]'::jsonb),
  ('astra-mutuals', '24M', 'OVERALL_SATISFACTION', 4.4, 0.5, '0.5 vs 24M ago', '[{"x":0,"y":95},{"x":30,"y":85},{"x":70,"y":60},{"x":110,"y":55},{"x":156,"y":25}]'::jsonb),
  ('astra-mutuals', '24M', 'POSITIVE_SENTIMENT', 68, 8, '8pp vs 24M ago', '[{"x":0,"y":95},{"x":60,"y":75},{"x":120,"y":45},{"x":156,"y":30}]'::jsonb),
  ('astra-mutuals', 'ALL', 'OVERALL_SATISFACTION', 4.2, 0.8, '0.8 since launch', '[{"x":0,"y":95},{"x":50,"y":90},{"x":100,"y":70},{"x":156,"y":40}]'::jsonb),
  ('astra-mutuals', 'ALL', 'POSITIVE_SENTIMENT', 62, 15, '15pp since launch', '[{"x":0,"y":95},{"x":40,"y":85},{"x":90,"y":75},{"x":156,"y":50}]'::jsonb),
  ('zenith-capital', '12M', 'OVERALL_SATISFACTION', 4.9, 0.2, '0.2 vs 12M ago', '[{"x":0,"y":80},{"x":50,"y":60},{"x":100,"y":40},{"x":156,"y":14}]'::jsonb),
  ('zenith-capital', '12M', 'POSITIVE_SENTIMENT', 88, 10, '10pp vs 12M ago', '[{"x":0,"y":85},{"x":60,"y":50},{"x":110,"y":30},{"x":156,"y":14}]'::jsonb),
  ('zenith-capital', '24M', 'OVERALL_SATISFACTION', 4.7, 0.4, '0.4 vs 24M ago', '[{"x":0,"y":90},{"x":40,"y":75},{"x":90,"y":55},{"x":156,"y":20}]'::jsonb),
  ('zenith-capital', '24M', 'POSITIVE_SENTIMENT', 82, 12, '12pp vs 24M ago', '[{"x":0,"y":95},{"x":50,"y":70},{"x":100,"y":45},{"x":156,"y":25}]'::jsonb),
  ('zenith-capital', 'ALL', 'OVERALL_SATISFACTION', 4.5, 0.6, '0.6 since launch', '[{"x":0,"y":95},{"x":50,"y":80},{"x":100,"y":65},{"x":156,"y":35}]'::jsonb),
  ('zenith-capital', 'ALL', 'POSITIVE_SENTIMENT', 75, 18, '18pp since launch', '[{"x":0,"y":95},{"x":60,"y":85},{"x":120,"y":60},{"x":156,"y":45}]'::jsonb),
  ('zenith-capital-2', '12M', 'OVERALL_SATISFACTION', 4.9, 0.2, '0.2 vs 12M ago', '[{"x":0,"y":80},{"x":50,"y":60},{"x":100,"y":40},{"x":156,"y":14}]'::jsonb),
  ('zenith-capital-2', '12M', 'POSITIVE_SENTIMENT', 88, 10, '10pp vs 12M ago', '[{"x":0,"y":85},{"x":60,"y":50},{"x":110,"y":30},{"x":156,"y":14}]'::jsonb),
  ('zenith-capital-2', '24M', 'OVERALL_SATISFACTION', 4.7, 0.4, '0.4 vs 24M ago', '[{"x":0,"y":90},{"x":40,"y":75},{"x":90,"y":55},{"x":156,"y":20}]'::jsonb),
  ('zenith-capital-2', '24M', 'POSITIVE_SENTIMENT', 82, 12, '12pp vs 24M ago', '[{"x":0,"y":95},{"x":50,"y":70},{"x":100,"y":45},{"x":156,"y":25}]'::jsonb),
  ('zenith-capital-2', 'ALL', 'OVERALL_SATISFACTION', 4.5, 0.6, '0.6 since launch', '[{"x":0,"y":95},{"x":50,"y":80},{"x":100,"y":65},{"x":156,"y":35}]'::jsonb),
  ('zenith-capital-2', 'ALL', 'POSITIVE_SENTIMENT', 75, 18, '18pp since launch', '[{"x":0,"y":95},{"x":60,"y":85},{"x":120,"y":60},{"x":156,"y":45}]'::jsonb),
  ('nexa-funds', '12M', 'OVERALL_SATISFACTION', 4.8, 0.4, '0.4 vs 12M ago', '[{"x":0,"y":90},{"x":40,"y":70},{"x":80,"y":60},{"x":120,"y":45},{"x":156,"y":14}]'::jsonb),
  ('nexa-funds', '12M', 'POSITIVE_SENTIMENT', 82, 6, '6pp vs 12M ago', '[{"x":0,"y":95},{"x":50,"y":70},{"x":100,"y":40},{"x":156,"y":14}]'::jsonb),
  ('nexa-funds', '24M', 'OVERALL_SATISFACTION', 4.5, 0.1, '0.1 vs 24M ago', '[{"x":0,"y":95},{"x":40,"y":80},{"x":90,"y":65},{"x":156,"y":30}]'::jsonb),
  ('nexa-funds', '24M', 'POSITIVE_SENTIMENT', 78, 4, '4pp vs 24M ago', '[{"x":0,"y":95},{"x":60,"y":75},{"x":110,"y":50},{"x":156,"y":35}]'::jsonb),
  ('nexa-funds', 'ALL', 'OVERALL_SATISFACTION', 4.2, 0.5, '0.5 since launch', '[{"x":0,"y":95},{"x":50,"y":85},{"x":100,"y":75},{"x":156,"y":50}]'::jsonb),
  ('nexa-funds', 'ALL', 'POSITIVE_SENTIMENT', 70, 12, '12pp since launch', '[{"x":0,"y":95},{"x":60,"y":80},{"x":120,"y":70},{"x":156,"y":55}]'::jsonb),
  ('summit-banking', '12M', 'OVERALL_SATISFACTION', 4.5, 0.2, '0.2 vs 12M ago', '[{"x":0,"y":95},{"x":35,"y":68},{"x":70,"y":58},{"x":110,"y":35},{"x":156,"y":14}]'::jsonb),
  ('summit-banking', '12M', 'POSITIVE_SENTIMENT', 75, 4, '4pp vs 12M ago', '[{"x":0,"y":90},{"x":45,"y":65},{"x":90,"y":44},{"x":130,"y":25},{"x":156,"y":14}]'::jsonb),
  ('summit-banking', '24M', 'OVERALL_SATISFACTION', 4.3, 0.4, '0.4 vs 24M ago', '[{"x":0,"y":95},{"x":40,"y":80},{"x":90,"y":60},{"x":156,"y":30}]'::jsonb),
  ('summit-banking', '24M', 'POSITIVE_SENTIMENT', 70, 6, '6pp vs 24M ago', '[{"x":0,"y":95},{"x":50,"y":75},{"x":100,"y":55},{"x":156,"y":40}]'::jsonb),
  ('summit-banking', 'ALL', 'OVERALL_SATISFACTION', 4, 0.7, '0.7 since launch', '[{"x":0,"y":95},{"x":50,"y":85},{"x":100,"y":75},{"x":156,"y":55}]'::jsonb),
  ('summit-banking', 'ALL', 'POSITIVE_SENTIMENT', 65, 10, '10pp since launch', '[{"x":0,"y":95},{"x":60,"y":85},{"x":120,"y":75},{"x":156,"y":60}]'::jsonb),
  ('prime-fincorp', '12M', 'OVERALL_SATISFACTION', 3.7, -0.8, '0.8 vs 12M ago', '[{"x":0,"y":30},{"x":40,"y":45},{"x":80,"y":60},{"x":120,"y":75},{"x":156,"y":95}]'::jsonb),
  ('prime-fincorp', '12M', 'POSITIVE_SENTIMENT', 25, -15, '15pp vs 12M ago', '[{"x":0,"y":40},{"x":50,"y":60},{"x":100,"y":75},{"x":156,"y":95}]'::jsonb),
  ('prime-fincorp', '24M', 'OVERALL_SATISFACTION', 3.9, -0.6, '0.6 vs 24M ago', '[{"x":0,"y":25},{"x":50,"y":45},{"x":100,"y":65},{"x":156,"y":85}]'::jsonb),
  ('prime-fincorp', '24M', 'POSITIVE_SENTIMENT', 30, -10, '10pp vs 24M ago', '[{"x":0,"y":30},{"x":60,"y":55},{"x":120,"y":70},{"x":156,"y":80}]'::jsonb),
  ('prime-fincorp', 'ALL', 'OVERALL_SATISFACTION', 4.2, -0.3, '0.3 since launch', '[{"x":0,"y":20},{"x":50,"y":35},{"x":100,"y":55},{"x":156,"y":75}]'::jsonb),
  ('prime-fincorp', 'ALL', 'POSITIVE_SENTIMENT', 40, -5, '5pp since launch', '[{"x":0,"y":20},{"x":60,"y":40},{"x":120,"y":60},{"x":156,"y":70}]'::jsonb),
  ('astra-mutuals-2', '12M', 'OVERALL_SATISFACTION', 4.6, 0.3, '0.3 vs 12M ago', '[{"x":0,"y":95},{"x":40,"y":70},{"x":80,"y":50},{"x":120,"y":40},{"x":156,"y":14}]'::jsonb),
  ('astra-mutuals-2', '12M', 'POSITIVE_SENTIMENT', 72, 5, '5pp vs 12M ago', '[{"x":0,"y":90},{"x":50,"y":65},{"x":100,"y":45},{"x":156,"y":14}]'::jsonb),
  ('astra-mutuals-2', '24M', 'OVERALL_SATISFACTION', 4.4, 0.5, '0.5 vs 24M ago', '[{"x":0,"y":95},{"x":30,"y":85},{"x":70,"y":60},{"x":110,"y":55},{"x":156,"y":25}]'::jsonb),
  ('astra-mutuals-2', '24M', 'POSITIVE_SENTIMENT', 68, 8, '8pp vs 24M ago', '[{"x":0,"y":95},{"x":60,"y":75},{"x":120,"y":45},{"x":156,"y":30}]'::jsonb),
  ('astra-mutuals-2', 'ALL', 'OVERALL_SATISFACTION', 4.2, 0.8, '0.8 since launch', '[{"x":0,"y":95},{"x":50,"y":90},{"x":100,"y":70},{"x":156,"y":40}]'::jsonb),
  ('astra-mutuals-2', 'ALL', 'POSITIVE_SENTIMENT', 62, 15, '15pp since launch', '[{"x":0,"y":95},{"x":40,"y":85},{"x":90,"y":75},{"x":156,"y":50}]'::jsonb)
) as s (slug, range, metric, value, change, change_label, chart)
join public.companies c on c.slug = s.slug
on conflict (company_id, range, metric) do update set
  value = excluded.value,
  change = excluded.change,
  change_label = excluded.change_label,
  chart = excluded.chart;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
