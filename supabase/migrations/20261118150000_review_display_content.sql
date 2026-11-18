-- Everything the Review screens show, exactly as the app showed it, from the database:
--
-- 1. Companies: their place in the app's list (its default order, ties and colours follow it),
--    the asset type as the card shows it ("Mutual Fund" for the second Astra Mutuals), and tags
--    as listed (Zenith Capital: "ETF", "IPO", "IPO").
-- 2. Top Reviews: the cards' lines, tags, rating and location as the app showed them.
-- 3. Content blocks served whole (GET /content/:key): the Compare screen and the filter sheet.

-- ---------------------------------------------------------------------------------------------
-- 1. Companies
-- ---------------------------------------------------------------------------------------------

alter table public.companies
  add column display_order integer not null default 0,
  add column asset_type_label text check (char_length(asset_type_label) <= 60);

-- A company may list the same tag twice, as the app does.
alter table public.company_tags drop constraint company_tags_pkey;
alter table public.company_tags add primary key (company_id, sort_order);

update public.companies c
set display_order = p.display_order, asset_type_label = p.asset_type_label
from (values
  ('astra-mutuals', 1, 'Mutual Fund / SIP'),
  ('zenith-capital', 2, 'Equity / IPO'),
  ('zenith-capital-2', 3, 'Equity / IPO'),
  ('nexa-funds', 4, 'Mutual Fund / SIP'),
  ('summit-banking', 5, 'Broker / Platform'),
  ('prime-fincorp', 6, 'Bonds / Sukuk'),
  ('astra-mutuals-2', 7, 'Mutual Fund')
) as p (slug, display_order, asset_type_label)
where c.slug = p.slug;

insert into public.company_tags (company_id, tag, sort_order)
select c.id, 'IPO', 3 from public.companies c
where c.slug in ('zenith-capital', 'zenith-capital-2')
on conflict (company_id, sort_order) do nothing;

create or replace view public.company_cards with (security_invoker = true) as
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
       s.last_review_at,
       c.display_order,
       c.asset_type_label
from public.companies c
left join public.company_stats s on s.company_id = c.id
where c.deleted_at is null;

-- The app's asset-class filter matches the asset type as shown, so the list filter can too.
drop function public.search_companies(
  text, public.sentiment[], public.asset_class[], public.resolution_bucket[], integer[],
  public.market_country[], public.investment_status[], integer[], integer);

create function public.search_companies(
  p_q                   text default null,
  p_sentiments          public.sentiment[] default null,
  p_asset_classes       public.asset_class[] default null,
  p_resolutions         public.resolution_bucket[] default null,
  p_scores              integer[] default null,
  p_countries           public.market_country[] default null,
  p_investment_statuses public.investment_status[] default null,
  p_years               integer[] default null,
  p_years_before        integer default null,
  p_asset_labels        text[] default null
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
    and (p_asset_labels is null or cc.asset_type_label = any (p_asset_labels))
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
-- 2. Top Reviews as the app showed them
-- ---------------------------------------------------------------------------------------------

-- How a review's card reads, when it is shown as stored content rather than built from the review.
create table public.review_display_content (
  review_id      uuid primary key references public.reviews (id) on delete cascade,
  -- The card's four lines, e.g. "PRODUCT NAME: Insurance", "COMPANY: Nexa".
  fields         text[] not null default '{}',
  -- The tags as listed, e.g. "Transparent Communication".
  tags           text[] not null default '{}',
  rating_label   text not null default '' check (char_length(rating_label) <= 10),
  location_label text not null default '' check (char_length(location_label) <= 60),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.review_display_content enable row level security;
revoke all on public.review_display_content from anon, authenticated;

insert into public.review_display_content (review_id, fields, tags, rating_label, location_label)
select r.id,
       case r.sentiment
         when 'Positive' then array['PRODUCT NAME: Insurance', 'COMPANY: Nexa', 'ASSET CLASS:', 'ASSET CLASS:2026']
         when 'Negative' then array['PRODUCT NAME: Insurance', 'COMPANY: Astra', 'ASSET CLASS:', 'YEAR OF INVESTMENT:2026']
         else array['PRODUCT NAME: Insurance', 'COMPANY: Mutual', 'ASSET CLASS:', 'YEAR OF INVESTMENT:2026']
       end,
       case r.sentiment
         when 'Positive' then array['Transparent Communication', 'Digital Experience', 'Ease of boarding', 'Ethical conduct']
         when 'Negative' then array['Contacted but no response', 'Delay in response']
         else array[]::text[]
       end,
       '4.0',
       'INDIA'
from public.reviews r
where r.user_id in (
  select public_id from app.users
  where public_id in ('5e1d0a1e-0000-4000-8000-000000000001',
                      '5e1d0a1e-0000-4000-8000-000000000002',
                      '5e1d0a1e-0000-4000-8000-000000000003'))
on conflict (review_id) do nothing;

create or replace view public.review_feed with (security_invoker = true) as
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
       r.published_at,
       (select jsonb_build_object(
                 'fields', to_jsonb(d.fields), 'tags', to_jsonb(d.tags),
                 'ratingLabel', d.rating_label, 'locationLabel', d.location_label)
        from public.review_display_content d where d.review_id = r.id) as display
from public.reviews r
where r.status = 'PUBLISHED' and r.deleted_at is null;

-- ---------------------------------------------------------------------------------------------
-- 3. Content blocks
-- ---------------------------------------------------------------------------------------------

-- Screen content that is not a record of its own (a comparison, a sheet of options), stored as
-- the app shows it and served by GET /content/:key.
create table public.app_content (
  key        text primary key check (key ~ '^[a-z0-9]+(\.[a-z0-9-]+)+$'),
  value      jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.app_content enable row level security;
revoke all on public.app_content from anon, authenticated;

insert into public.app_content (key, value) values
('review.compare', $json${
  "left": { "name": "NEXA", "product": "INSURANCE", "type": "ASSET" },
  "right": { "name": "ZENITH", "product": "INSURANCE", "type": "ASSET" },
  "scorecard": [
    { "label": "Transparency", "left": 80, "right": 40 },
    { "label": "Responsiveness", "left": 88, "right": 52 },
    { "label": "Ease Of Progress", "left": 50, "right": 52 },
    { "label": "Trustworthiness", "left": 50, "right": 52 },
    { "label": "Overall Satisfaction", "left": 50, "right": 43 }
  ],
  "resolutionLens": [
    { "label": "Positive", "left": 50, "right": 52 },
    { "label": "Neutral", "left": 50, "right": 20 },
    { "label": "Negative", "left": 50, "right": 52 },
    { "label": "Trends", "left": 88, "right": 43 },
    { "label": "Review Volume", "left": 50, "right": 43 }
  ],
  "sentimentSplit": {
    "firstProduct": { "positive": "100%", "negative": "65%", "neutral": "35%" },
    "secondProduct": { "positive": "100%", "negative": "75%", "neutral": "52%" }
  }
}$json$::jsonb),
('filters.sheet', $json$[
  { "category": "Sort By", "options": [
    { "id": "relevant", "label": "Most Relevant", "count": "341" },
    { "id": "recent", "label": "Most Recent", "count": "" },
    { "id": "trending", "label": "Trending", "count": "28" },
    { "id": "top_rated", "label": "Top Rated", "count": "214" },
    { "id": "most_reviewed", "label": "Most Reviewed", "count": "" },
    { "id": "improving", "label": "Improving Trend", "count": "19" } ] },
  { "category": "Sentiment", "options": [
    { "id": "Positive", "label": "Positive", "count": "1,648" },
    { "id": "Neutral", "label": "Neutral", "count": "681" },
    { "id": "Negative", "label": "Negative", "count": "512" } ] },
  { "category": "Asset Class", "options": [
    { "id": "MF", "label": "Mutual Fund / SIP", "count": "964" },
    { "id": "INS", "label": "Insurance", "count": "681" },
    { "id": "EQ", "label": "Equity / IPO", "count": "341" },
    { "id": "BRK", "label": "Broker / Platform", "count": "512" },
    { "id": "BND", "label": "Bonds / Sukuk", "count": "228" },
    { "id": "PMS", "label": "PMS / AIF", "count": "114" },
    { "id": "RE", "label": "Real Estate", "count": "57" },
    { "id": "CRY", "label": "Crypto / VDA", "count": "42" } ] },
  { "category": "Resolution", "options": [
    { "id": "Resolved", "label": "Resolved", "count": "71%" },
    { "id": "In Progress", "label": "In Progress", "count": "13%" },
    { "id": "Unresolved", "label": "Unresolved", "count": "8%" },
    { "id": "Not Contacted", "label": "Not Contacted", "count": "8%" } ] },
  { "category": "Avg Score", "options": [
    { "id": "5", "label": "5 — Excellent", "count": "312" },
    { "id": "4", "label": "4 — Good", "count": "621" },
    { "id": "3", "label": "3 — Average", "count": "498" },
    { "id": "2", "label": "2 — Below Avg", "count": "284" },
    { "id": "1", "label": "1 — Poor", "count": "228" } ] },
  { "category": "Country", "options": [
    { "id": "India", "label": "India", "count": "2,214" },
    { "id": "UAE", "label": "UAE", "count": "484" },
    { "id": "Other", "label": "Other", "count": "143" } ] },
  { "category": "Invested Status", "options": [
    { "id": "invested", "label": "Currently Invested", "count": "" },
    { "id": "exited", "label": "Exited", "count": "" },
    { "id": "never", "label": "No (Never invested)", "count": "" } ] },
  { "category": "Year", "options": [
    { "id": "2025", "label": "2025", "count": "412" },
    { "id": "2024", "label": "2024", "count": "698" },
    { "id": "2023", "label": "2023", "count": "541" },
    { "id": "2022", "label": "2022", "count": "387" },
    { "id": "2021", "label": "2021", "count": "284" },
    { "id": "before_2021", "label": "Before 2021", "count": "519" } ] }
]$json$::jsonb)
on conflict (key) do update set value = excluded.value;

create or replace function public.app_get_content(p_key text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select c.value from public.app_content c where c.key = p_key;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
