-- Everything the Ratings screens show, exactly as the app showed it, from the database:
-- the app's 8 issuers (with "Vanguard Realty", which the catalog did not have), each card value
-- as shown ("45 shares", "₹310- ₹325", "₹1450cr", "30-60days", "25-03-24"), the logo letters,
-- the sentiment the filter uses, the rating figure the sorts use, the list order, and the PDF the
-- Download button saves (uploaded by `npm run seed:issuer-documents`).

-- ---------------------------------------------------------------------------------------------
-- 1. Display fields
-- ---------------------------------------------------------------------------------------------

alter table public.issuers
  add column display_order integer not null default 0,
  add column logo_text text not null default '' check (char_length(logo_text) <= 4),
  add column sentiment text check (sentiment in ('positive', 'neutral', 'negative')),
  add column min_lot_label text check (char_length(min_lot_label) <= 40),
  add column offer_price_label text check (char_length(offer_price_label) <= 60),
  add column offer_size_label text check (char_length(offer_size_label) <= 40),
  add column lock_in_label text check (char_length(lock_in_label) <= 40),
  add column open_date_label text check (char_length(open_date_label) <= 20),
  add column close_date_label text check (char_length(close_date_label) <= 20),
  add column display_rating numeric(3, 1),
  -- The PDF in the issuer-documents bucket that Download saves.
  add column document_path text check (document_path ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('issuer-documents', 'issuer-documents', false, 26214400, array['application/pdf'])
on conflict (id) do nothing;

-- The app's 8 issuers (the catalog had 7; "Vanguard Realty" is the eighth). Amounts in INR.
insert into public.issuers (
  slug, name, instrument, asset_type, exchange, open_date, close_date, is_listed,
  min_lot, lot_unit, price_min, price_max, offer_size, use_of_funds, lock_in, pre_post_ratio
) values
  ('sovereign-alpha-yield', 'Sovereign Alpha Yield', 'Equity', 'Equity', 'BSE/NSE',
   '2024-03-25', '2024-03-29', true, 45, 'shares', 310, 325, 14500000000, 'Debt', '30-60 days', '100%/75%'),
  ('nexus-infrastructure-trust', 'Nexus Infrastructure Trust', 'InvIT Inv', 'InvIT', 'NSE Only',
   '2024-04-02', '2024-04-05', true, 100, 'shares', 101, 105, 8900000000, 'Expansion', 'None', '92%/88%'),
  ('fintech-growth-bonds', 'FinTech Growth Bonds', 'Debt Capital', 'Bonds', 'BSE/NSE',
   '2024-04-11', '2024-04-16', false, 10, 'bonds', 10000, 10000, 3500000000, 'Refinancing', '365 days', '100%/100%'),
  ('zenith-logistics-venture', 'Zenith Logistics Venture', 'Equity Shares', 'Equity', 'BSE/NSE',
   '2024-04-18', '2024-04-22', true, 60, 'shares', 210, 220, 6200000000, 'Working Cap', '90 days', '85%/72%'),
  ('meridian-renewable-energy', 'Meridian Renewable Energy', 'Green Bonds', 'Bonds', 'BSE Only',
   '2024-04-25', '2024-04-30', true, 25, 'shares', 540, 565, 21000000000, 'Green Asset', '45 days', '100%/80%'),
  ('quantum-biotech-limited', 'Quantum Biotech Limited', 'Ordinary Equity', 'Equity', 'BSE/NSE',
   '2024-05-02', '2024-05-06', true, 35, 'shares', 415, 440, 11500000000, 'R&D Debt', '30-90 days', '100%/78%'),
  ('vanguard-realty-housing', 'Vanguard Realty Housing', 'REIT Units', 'REIT', 'NSE Only',
   '2024-05-10', '2024-05-14', true, 150, 'shares', 300, 315, 18000000000, 'Asset Acq', '120 days', '90%/81%'),
  ('vanguard-realty', 'Vanguard Realty', 'REIT Units', 'REIT', 'NSE Only',
   '2024-05-10', '2024-05-14', true, 150, 'shares', 300, 315, 18000000000, 'Asset Acq', '120 days', '90%/81%')
on conflict (slug) do nothing;

update public.issuers i
set display_order = p.display_order,
    logo_text = p.logo_text,
    sentiment = p.sentiment,
    min_lot_label = p.min_lot,
    offer_price_label = p.offer_price,
    offer_size_label = p.offer_size,
    lock_in_label = p.lock_in,
    open_date_label = p.open_date,
    close_date_label = p.close_date,
    display_rating = p.rating,
    document_path = 'issuers/' || i.slug || '/download.pdf'
from (values
  ('sovereign-alpha-yield', 1, 'SA', 'positive', '45 shares', '₹310- ₹325', '₹1450cr', '30-60days', '25-03-24', '29-03-24', 4.8),
  ('nexus-infrastructure-trust', 2, 'NE', 'positive', '100 shares', '₹101- ₹105', '₹890cr', 'None', '02-04-24', '05-04-24', 4.5),
  ('fintech-growth-bonds', 3, 'FT', 'neutral', '10 Bonds', '₹10,000 Fix', '₹350cr', '365days', '11-04-24', '16-04-24', 3.9),
  ('zenith-logistics-venture', 4, 'ZL', 'negative', '60 shares', '₹210- ₹220', '₹620cr', '90days', '18-04-24', '22-04-24', 2.4),
  ('meridian-renewable-energy', 5, 'MR', 'positive', '25 shares', '₹540- ₹565', '₹2100cr', '45days', '25-04-24', '30-04-24', 4.7),
  ('quantum-biotech-limited', 6, 'QB', 'neutral', '35 shares', '₹415- ₹440', '₹1150cr', '30-90days', '02-05-24', '06-05-24', 3.5),
  ('vanguard-realty-housing', 7, 'VR', 'negative', '150 shares', '₹300- ₹315', '₹1800cr', '120days', '10-05-24', '14-05-24', 2.1),
  ('vanguard-realty', 8, 'VR', 'negative', '150 shares', '₹300- ₹315', '₹1800cr', '120days', '10-05-24', '14-05-24', 2.1)
) as p (slug, display_order, logo_text, sentiment, min_lot, offer_price, offer_size, lock_in,
        open_date, close_date, rating)
where i.slug = p.slug;

-- ---------------------------------------------------------------------------------------------
-- 2. Read model
-- ---------------------------------------------------------------------------------------------

create or replace view app.issuer_cards as
select i.id,
       i.slug,
       i.name,
       i.instrument,
       i.asset_type,
       i.exchange,
       i.is_listed,
       i.open_date,
       i.close_date,
       i.min_lot,
       i.lot_unit,
       i.price_min,
       i.price_max,
       i.offer_size,
       i.currency,
       i.use_of_funds,
       i.lock_in,
       i.pre_post_ratio,
       i.created_at,
       lower(i.name || ' ' || i.instrument) as search_text,
       array(
         select t.tag from public.issuer_tags t
         where t.issuer_id = i.id
         order by t.sort_order, t.tag
       ) as tags,
       coalesce(s.rating_count, 0) as rating_count,
       coalesce(s.average_score, 0) as average_score,
       i.display_order,
       i.logo_text,
       i.sentiment,
       i.min_lot_label,
       i.offer_price_label,
       i.offer_size_label,
       i.lock_in_label,
       i.open_date_label,
       i.close_date_label,
       i.display_rating,
       i.document_path
from public.issuers i
left join app.issuer_stats s on s.issuer_id = i.id
where i.deleted_at is null;

create or replace function app.issuer_json(c app.issuer_cards)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'slug', c.slug, 'name', c.name, 'instrument', c.instrument,
    'assetType', c.asset_type, 'exchange', c.exchange, 'isListed', c.is_listed,
    'openDate', c.open_date::text, 'closeDate', c.close_date::text,
    'minLot', c.min_lot, 'lotUnit', c.lot_unit, 'priceMin', c.price_min::float8,
    'priceMax', c.price_max::float8, 'offerSize', c.offer_size::float8, 'currency', c.currency,
    'useOfFunds', c.use_of_funds, 'lockIn', c.lock_in, 'prePostRatio', c.pre_post_ratio,
    'tags', to_jsonb(c.tags), 'ratingCount', c.rating_count,
    'averageScore', c.average_score::float8, 'createdAt', c.created_at,
    'display', jsonb_build_object(
      'order', c.display_order, 'logoText', c.logo_text, 'sentiment', c.sentiment,
      'minLot', c.min_lot_label, 'offerPrice', c.offer_price_label,
      'offerSize', c.offer_size_label, 'lockIn', c.lock_in_label,
      'openDate', c.open_date_label, 'closeDate', c.close_date_label,
      'rating', c.display_rating::float8, 'hasDocument', c.document_path is not null));
$$;

-- The app's orders (its list order, the opening date either way, the lot size), with ties in
-- the list order; and the sentiment filter.
drop function public.app_find_issuers(text, text[], boolean, text, integer, integer);

create function public.app_find_issuers(
  p_q_pattern text, p_asset_types text[], p_listed boolean, p_sentiments text[], p_sort text,
  p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select app.issuer_json(c) as item,
           row_number() over (order by
             case when p_sort = 'recent' then c.open_date end desc nulls last,
             case when p_sort = 'recent' then c.created_at end desc,
             case when p_sort = 'closing_soon' then c.close_date end asc nulls last,
             case when p_sort = 'top_rated' then c.average_score end desc,
             case when p_sort = 'top_rated' then c.rating_count end desc,
             case when p_sort = 'most_rated' then c.rating_count end desc,
             case when p_sort = 'most_rated' then c.average_score end desc,
             case when p_sort = 'opened_asc' then c.open_date end asc nulls last,
             case when p_sort = 'opened_desc' then c.open_date end desc nulls last,
             case when p_sort = 'lot_desc' then c.min_lot end desc nulls last,
             c.display_order, c.id) as rn
    from app.issuer_cards c
    where (p_q_pattern is null or c.search_text like p_q_pattern)
      and (coalesce(cardinality(p_asset_types), 0) = 0 or c.asset_type::text = any (p_asset_types))
      and (p_listed is null or c.is_listed = p_listed)
      and (coalesce(cardinality(p_sentiments), 0) = 0 or c.sentiment = any (p_sentiments))
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

create or replace function public.app_issuer_document(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('path', i.document_path)
  from public.issuers i
  where i.id = p_id and i.deleted_at is null and i.document_path is not null;
$$;

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
