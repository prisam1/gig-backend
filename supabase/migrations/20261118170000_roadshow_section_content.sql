-- Everything the Roadshows screens show, exactly as the app showed it, from the database:
--
-- 1. Roadshows as the app presents them: a company (not a catalog issuer) with its industry,
--    logo letters, "GIG Verified", Avg GIG Review, GIG Ratings, the OPEN/CLOSED badge, the
--    "N days left" label, country, year, tags and the issue terms as shown ("10.25%", "No").
-- 2. The financial summary (Equity Share Capital … WC Ratio) for 3 years in every currency the
--    app offers, as the app lists them.
-- 3. Ask Me Anything: the questions and answers under each tab (TOP ASKED … MUTUAL FUNDS).
-- 4. Power Pool: the starting participants, capital interest and heat-map figures; the app's 8
--    expectations (the enum values are renamed to them, in the app's order); joining without an
--    amount (the app asks for none); and 3 starting credits for every member.
-- 5. The Download DD documents (placeholder PDFs, uploaded by npm run seed:roadshow-documents).

-- ---------------------------------------------------------------------------------------------
-- 1. Roadshow display fields
-- ---------------------------------------------------------------------------------------------

alter table public.roadshows alter column issuer_id drop not null;

alter table public.roadshows
  add column display_order integer not null default 0,
  add column company_name text check (char_length(company_name) <= 120),
  add column logo_text text not null default '' check (char_length(logo_text) <= 4),
  add column verified_label text check (char_length(verified_label) <= 40),
  add column industry text check (char_length(industry) <= 60),
  add column avg_gig_review numeric(3, 1),
  add column gig_rating numeric(3, 1),
  add column avg_score integer,
  -- The card's OPEN / CLOSED badge.
  add column listed boolean not null default true,
  -- The card's "2 days left".
  add column close_label text check (char_length(close_label) <= 40),
  add column country_label text check (char_length(country_label) <= 40),
  add column display_year integer,
  add column tags text[] not null default '{}',
  add column callable_label text check (char_length(callable_label) <= 10),
  add column coupon_rate_label text check (char_length(coupon_rate_label) <= 20),
  -- What the list's search matches: the company name and its tags.
  add column search_text text;

-- Roadshows the app does not show.
update public.roadshows set status = 'ARCHIVED'
where slug in ('meridian-green-bonds-2026', 'quantum-biotech-pre-ipo');

-- ---------------------------------------------------------------------------------------------
-- 2-4. Financial summary, Ask Me Anything, Power Pool figures
-- ---------------------------------------------------------------------------------------------

create table public.roadshow_financial_summary (
  roadshow_id             uuid not null references public.roadshows (id) on delete cascade,
  currency                public.currency_code not null,
  -- 1, 2, 3: the app's YEAR 1, YEAR 2, YEAR 3.
  year_index              smallint not null check (year_index between 1 and 3),
  equity_share_capital    numeric(20, 2),
  networth                numeric(20, 2),
  total_borrowings        numeric(20, 2),
  total_income            numeric(20, 2),
  revenue_from_operations numeric(20, 2),
  profit_or_loss          numeric(20, 2),
  eps                     numeric(12, 4),
  return_on_equity        numeric(8, 2),
  debt_to_equity          numeric(8, 2),
  wc_ratio                numeric(8, 2),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  primary key (roadshow_id, currency, year_index)
);

create table public.roadshow_qa (
  id          uuid primary key default gen_random_uuid(),
  roadshow_id uuid not null references public.roadshows (id) on delete cascade,
  -- The Ask Me Anything tab ('TOP ASKED', 'RECENTLY ADDED', 'EQUITY', ...).
  category    text not null check (char_length(category) between 1 and 40),
  position    integer not null,
  question    text not null check (char_length(question) between 1 and 500),
  answer      text not null check (char_length(answer) <= 4000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (roadshow_id, category, position)
);

-- The Power Pool figures the app starts from; members who join add to them.
create table public.roadshow_pool_content (
  roadshow_id                 uuid primary key references public.roadshows (id) on delete cascade,
  participants                integer check (participants >= 0),
  capital_interest_label      text check (char_length(capital_interest_label) <= 40),
  your_credit                 integer,
  higher_roi_irr              text check (char_length(higher_roi_irr) <= 10),
  lower_lock_in_period        text check (char_length(lower_lock_in_period) <= 10),
  reduced_entry_exit_load     text check (char_length(reduced_entry_exit_load) <= 10),
  better_allotment_preference text check (char_length(better_allotment_preference) <= 10),
  flexible_payment_terms      text check (char_length(flexible_payment_terms) <= 10),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

alter table public.roadshow_financial_summary enable row level security;
alter table public.roadshow_qa enable row level security;
alter table public.roadshow_pool_content enable row level security;
revoke all on public.roadshow_financial_summary, public.roadshow_qa, public.roadshow_pool_content
  from anon, authenticated;

-- The app's 8 expectations, in its order (no pool member has voted yet).
alter type public.pool_expectation rename value 'BETTER_ROI_IRR' to 'HIGHER_ROI_IRR';
alter type public.pool_expectation rename value 'SHORTER_LOCK_IN' to 'LOWER_LOCK_IN';
alter type public.pool_expectation rename value 'LOWER_ENTRY_LOAD' to 'REDUCED_ENTRY_EXIT_LOAD';
alter type public.pool_expectation rename value 'LOWER_EXIT_LOAD' to 'TENURE_PREFERENCE';
alter type public.pool_expectation rename value 'PRIORITY_ALLOTMENT' to 'BETTER_ALLOTMENT';
alter type public.pool_expectation rename value 'DISCOUNTED_OFFER_PRICE' to 'LOWER_MINIMUM_TICKET';
alter type public.pool_expectation rename value 'REGULAR_DISCLOSURES' to 'CASHBACK_ON_REINVESTMENT';

-- The app's join asks for expectations only, no amount.
alter table public.pool_members alter column capital_interest drop not null;

-- Every member starts with 3 credits, as the app shows; existing members get them too.
create or replace function public.grant_starting_credits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.apply_credit_change(new.public_id, 3, 'ADMIN_GRANT', null, null, 'Starting credits');
  return null;
end;
$$;

create trigger users_grant_starting_credits
after insert on app.users
for each row execute function public.grant_starting_credits();

select public.apply_credit_change(u.public_id, 3, 'ADMIN_GRANT', null, null, 'Starting credits')
from app.users u
where u.credit_balance = 0
  and not exists (select 1 from public.credit_ledger l where l.user_id = u.public_id);

-- What the detail screens show for one roadshow: financial summary, Q&A and pool figures.
create or replace function public.app_roadshow_display(p_roadshow_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'financials', coalesce((
      select jsonb_agg(jsonb_build_object(
          'currency', f.currency, 'year', f.year_index,
          'equityShareCapital', f.equity_share_capital::float8, 'networth', f.networth::float8,
          'totalBorrowings', f.total_borrowings::float8, 'totalIncome', f.total_income::float8,
          'revenueFromOperations', f.revenue_from_operations::float8,
          'profitOrLoss', f.profit_or_loss::float8, 'eps', f.eps::float8,
          'returnOnEquity', f.return_on_equity::float8, 'debtToEquity', f.debt_to_equity::float8,
          'wcRatio', f.wc_ratio::float8)
        order by f.currency, f.year_index)
      from public.roadshow_financial_summary f where f.roadshow_id = p_roadshow_id), '[]'::jsonb),
    'qa', coalesce((
      select jsonb_agg(jsonb_build_object('category', x.category, 'question', x.question, 'answer', x.answer)
        order by x.category, x.position)
      from public.roadshow_qa x where x.roadshow_id = p_roadshow_id), '[]'::jsonb),
    'pool', (
      select jsonb_build_object(
        'participants', p.participants, 'capitalInterest', p.capital_interest_label,
        'yourCredit', p.your_credit, 'higherRoiIrr', p.higher_roi_irr,
        'lowerLockInPeriod', p.lower_lock_in_period, 'reducedEntryExitLoad', p.reduced_entry_exit_load,
        'betterAllotmentPreference', p.better_allotment_preference,
        'flexiblePaymentTerms', p.flexible_payment_terms)
      from public.roadshow_pool_content p where p.roadshow_id = p_roadshow_id));
$$;

-- ---------------------------------------------------------------------------------------------
-- Content: the app's 10 roadshows, generated from its ROADSHOWS array (src/data.ts)
-- ---------------------------------------------------------------------------------------------

create temporary table app_roadshows (
  slug text, display_order integer, company_name text, logo_text text, verified_label text,
  industry text, avg_gig_review numeric, type_of_issue text, close_label text, gig_rating numeric,
  listed boolean, instruments text, no_of_instruments bigint, offer_price numeric, lock_in text,
  maturity text, convertibility text, callable_label text, coupon_rate_label text, country_label text,
  avg_score integer, display_year integer, pool_enabled boolean, tags text[], opened_ms bigint,
  document_prefix text
);

insert into app_roadshows values
  ('apex-ledger', 1, 'Apex Ledger', 'AL', 'GIG Verified', 'Fintech', 4.6, 'NCD Public Issue', '2 days left', 4.5, true, 'Secured NCDs', 600000, 1000, 'None', '36 Months', 'Non-Convertible', 'No', '10.25%', 'India', 5, 2026, true, array['fintech', 'payment', 'bonds']::text[], 1714003200000, 'apex'),
  ('baron-energy', 2, 'Baron Energy', 'BE', 'GIG Verified', 'Real Estate', 4.2, 'Subordinated Debt', '4 days left', 4, true, 'Unsecured Bonds', 300000, 2000, '12 Months', '60 Months', 'Non-Convertible', 'Yes', '11.50%', 'UAE', 4, 2025, false, array['digital', 'payments', 'infrastructure']::text[], 1714003200000, 'baron'),
  ('credo-vault', 3, 'Credo Vault', 'CV', 'GIG Verified', 'Applications', 4.8, 'NCD Public Issue', '5 days left', 4.7, true, 'Secured Bonds', 450000, 1000, 'None', '24 Months', 'Non-Convertible', 'No', '9.85%', 'India', 5, 2026, true, array['security', 'vault', 'bonds']::text[], 1713398400000, 'credo'),
  ('delta-prime', 4, 'Delta Prime', 'DP', 'GIG Verified', 'Crypto', 4.1, 'Subordinated Note', '7 days left', 3.9, false, 'Unsecured Debentures', 200000, 5000, '24 Months', '48 Months', 'Non-Convertible', 'Yes', '12.00%', 'Other', 3, 2024, true, array['digital', 'payments', 'tokenization']::text[], 1712793600000, 'delta'),
  ('envoy-capital', 5, 'Envoy Capital', 'EC', 'GIG Verified', 'Mutual Funds', 4.4, 'NCD Public Issue', '1 day left', 4.3, true, 'Secured NCDs', 500000, 1000, 'None', '36 Months', 'Non-Convertible', 'No', '10.10%', 'India', 4, 2026, true, array['bonds', 'capital', 'yield']::text[], 1714608000000, 'envoy'),
  ('future-pay', 6, 'Future Pay', 'FP', 'GIG Verified', 'Fintech', 4.5, 'Perpetual Debt', '9 days left', 4.1, true, 'Unsecured Bonds', 150000, 10000, '36 Months', 'Perpetual', 'Non-Convertible', 'Yes', '12.50%', 'UAE', 4, 2025, false, array['digital', 'payments', 'perpetual']::text[], 1715299200000, 'future'),
  ('growth-matrix', 7, 'Growth Matrix', 'GM', 'GIG Verified', 'Real Estate', 4.7, 'NCD Public Issue', '12 days left', 4.6, true, 'Secured NCDs', 400000, 1000, 'None', '36 Months', 'Non-Convertible', 'No', '10.40%', 'India', 5, 2026, true, array['realestate', 'bonds', 'growth']::text[], 1712793600000, 'growth'),
  ('helix-crypto', 8, 'Helix Crypto', 'HC', 'GIG Verified', 'Crypto', 4.2, 'Subordinated Debt', '15 days left', 3.8, false, 'Unsecured Bonds', 280000, 3000, '12 Months', '48 Months', 'Non-Convertible', 'No', '11.75%', 'UAE', 3, 2025, true, array['digital', 'payments', 'nodes']::text[], 1713398400000, 'helix'),
  ('intellect-bonds', 9, 'Intellect Bonds', 'IB', 'GIG Verified', 'Insurance', 4.5, 'NCD Public Issue', '20 days left', 4.4, true, 'Secured NCDs', 350000, 2000, 'None', '36 Months', 'Non-Convertible', 'No', '10.05%', 'India', 4, 2026, true, array['bonds', 'insurance', 'yield']::text[], 1714003200000, 'intellect'),
  ('janus-trade', 10, 'Janus Trade', 'JT', 'GIG Verified', 'Equity', 4.4, 'Subordinated Note', '25 days left', 4, false, 'Unsecured Debentures', 190000, 5000, '18 Months', '36 Months', 'Non-Convertible', 'Yes', '11.90%', 'Other', 4, 2024, true, array['digital', 'payments', 'equity']::text[], 1714608000000, 'janus');

insert into public.roadshows (
  slug, issuer_id, title, summary, type_of_issue, instruments, no_of_instruments, offer_price,
  currency, lock_in, maturity, convertibility, callable, coupon_rate, risk_factors, opens_at,
  closes_at, pool_enabled, status, published_at, display_order, company_name, logo_text,
  verified_label, industry, avg_gig_review, gig_rating, avg_score, listed, close_label,
  country_label, display_year, tags, callable_label, coupon_rate_label
)
select a.slug, null, a.company_name, null, a.type_of_issue, a.instruments, a.no_of_instruments,
       a.offer_price, 'INR', a.lock_in, a.maturity, a.convertibility, a.callable_label = 'Yes',
       nullif(replace(a.coupon_rate_label, '%', ''), '')::numeric, '{}',
       to_timestamp(a.opened_ms / 1000.0), now() + interval '365 days', a.pool_enabled, 'PUBLISHED',
       to_timestamp(a.opened_ms / 1000.0), a.display_order, a.company_name, a.logo_text,
       a.verified_label, a.industry, a.avg_gig_review, a.gig_rating, a.avg_score, a.listed,
       a.close_label, a.country_label, a.display_year, a.tags, a.callable_label, a.coupon_rate_label
from app_roadshows a
on conflict (slug) do update set
  title = excluded.title, type_of_issue = excluded.type_of_issue, instruments = excluded.instruments,
  no_of_instruments = excluded.no_of_instruments, offer_price = excluded.offer_price,
  lock_in = excluded.lock_in, maturity = excluded.maturity, convertibility = excluded.convertibility,
  callable = excluded.callable, coupon_rate = excluded.coupon_rate, opens_at = excluded.opens_at,
  closes_at = excluded.closes_at, pool_enabled = excluded.pool_enabled, status = excluded.status,
  published_at = excluded.published_at, display_order = excluded.display_order,
  company_name = excluded.company_name, logo_text = excluded.logo_text,
  verified_label = excluded.verified_label, industry = excluded.industry,
  avg_gig_review = excluded.avg_gig_review, gig_rating = excluded.gig_rating,
  avg_score = excluded.avg_score, listed = excluded.listed, close_label = excluded.close_label,
  country_label = excluded.country_label, display_year = excluded.display_year, tags = excluded.tags,
  callable_label = excluded.callable_label, coupon_rate_label = excluded.coupon_rate_label;

-- The Download DD rows: Offer Letter and Financial Year 1-3 (placeholder PDFs, uploaded by
-- npm run seed:roadshow-documents).
insert into public.roadshow_documents (roadshow_id, title, doc_type, storage_path, size_bytes, sort_order)
select r.id, d.title, d.doc_type, a.document_prefix || '/' || a.document_prefix || d.suffix, null, d.sort_order
from app_roadshows a
join public.roadshows r on r.slug = a.slug
cross join (values
  (1, 'Offer Letter', 'PROSPECTUS', '_offer_letter.pdf'),
  (2, 'Financial Year 1', 'FINANCIAL_STATEMENT', '_fy1.pdf'),
  (3, 'Financial Year 2', 'FINANCIAL_STATEMENT', '_fy2.pdf'),
  (4, 'Financial Year 3', 'FINANCIAL_STATEMENT', '_fy3.pdf')
) as d (sort_order, title, doc_type, suffix)
on conflict (storage_path) do nothing;

insert into public.roadshow_financial_summary (
  roadshow_id, currency, year_index, equity_share_capital, networth, total_borrowings, total_income,
  revenue_from_operations, profit_or_loss, eps, return_on_equity, debt_to_equity, wc_ratio
)
select r.id, f.currency::public.currency_code, f.year_index, f.a, f.b, f.c, f.d, f.e, f.f, f.g, f.h, f.i, f.j
from (values
  ('apex-ledger', 'INR', 1, 12000000, 48000000, 18000000, 36000000, 34000000, 5200000, 4.33, 10.8, 0.38, 1.6),
  ('apex-ledger', 'INR', 2, 10000000, 42800000, 22000000, 31000000, 29000000, 4100000, 4.1, 9.5, 0.51, 1.4),
  ('apex-ledger', 'INR', 3, 10000000, 38700000, 25000000, 27000000, 25000000, 3400000, 3.4, 8.7, 0.64, 1.3),
  ('apex-ledger', 'USD', 1, 144000, 576000, 216000, 432000, 408000, 62400, 0.05, 10.8, 0.38, 1.6),
  ('apex-ledger', 'USD', 2, 120000, 513600, 264000, 372000, 348000, 49200, 0.04, 9.5, 0.51, 1.4),
  ('apex-ledger', 'USD', 3, 120000, 464400, 300000, 324000, 300000, 40800, 0.03, 8.7, 0.64, 1.3),
  ('apex-ledger', 'EUR', 1, 133000, 533000, 200000, 400000, 377000, 57700, 0.05, 10.8, 0.38, 1.6),
  ('apex-ledger', 'EUR', 2, 111000, 475000, 244000, 344000, 322000, 45500, 0.04, 9.5, 0.51, 1.4),
  ('apex-ledger', 'EUR', 3, 111000, 429000, 277000, 300000, 277000, 37700, 0.03, 8.7, 0.64, 1.3),
  ('apex-ledger', 'GBP', 1, 114000, 457000, 171000, 342000, 323000, 49400, 0.04, 10.8, 0.38, 1.6),
  ('apex-ledger', 'GBP', 2, 95000, 406000, 209000, 294000, 275000, 38900, 0.04, 9.5, 0.51, 1.4),
  ('apex-ledger', 'GBP', 3, 95000, 367000, 237000, 256000, 237000, 32300, 0.03, 8.7, 0.64, 1.3),
  ('apex-ledger', 'AED', 1, 528000, 2112000, 792000, 1584000, 1496000, 228800, 0.19, 10.8, 0.38, 1.6),
  ('apex-ledger', 'AED', 2, 440000, 1883200, 968000, 1364000, 1276000, 180400, 0.16, 9.5, 0.51, 1.4),
  ('apex-ledger', 'AED', 3, 440000, 1702800, 1100000, 1188000, 1100000, 149600, 0.14, 8.7, 0.64, 1.3),
  ('baron-energy', 'INR', 1, 15000000, 52000000, 30000000, 41000000, 39000000, 4800000, 3.2, 9.2, 0.57, 1.4),
  ('baron-energy', 'INR', 2, 15000000, 47200000, 32000000, 36000000, 34000000, 4200000, 2.8, 8.8, 0.67, 1.3),
  ('baron-energy', 'INR', 3, 12000000, 43000000, 35000000, 32000000, 30000000, 3900000, 3.25, 9, 0.81, 1.2),
  ('baron-energy', 'USD', 1, 180000, 624000, 360000, 492000, 468000, 57600, 0.04, 9.2, 0.57, 1.4),
  ('baron-energy', 'USD', 2, 180000, 566400, 384000, 432000, 408000, 50400, 0.03, 8.8, 0.67, 1.3),
  ('baron-energy', 'USD', 3, 144000, 516000, 420000, 384000, 360000, 46800, 0.04, 9, 0.81, 1.2),
  ('baron-energy', 'EUR', 1, 166000, 577000, 333000, 455000, 433000, 53300, 0.04, 9.2, 0.57, 1.4),
  ('baron-energy', 'EUR', 2, 166000, 524000, 355000, 400000, 377000, 46600, 0.03, 8.8, 0.67, 1.3),
  ('baron-energy', 'EUR', 3, 133000, 477000, 388000, 355000, 333000, 43300, 0.04, 9, 0.81, 1.2),
  ('baron-energy', 'GBP', 1, 142000, 494000, 285000, 389000, 370000, 45600, 0.03, 9.2, 0.57, 1.4),
  ('baron-energy', 'GBP', 2, 142000, 448000, 304000, 342000, 323000, 39900, 0.03, 8.8, 0.67, 1.3),
  ('baron-energy', 'GBP', 3, 114000, 408000, 332000, 304000, 285000, 37000, 0.03, 9, 0.81, 1.2),
  ('baron-energy', 'AED', 1, 660000, 2288000, 1320000, 1804000, 1716000, 211200, 0.14, 9.2, 0.57, 1.4),
  ('baron-energy', 'AED', 2, 660000, 2076800, 1408000, 1584000, 1496000, 184800, 0.12, 8.8, 0.67, 1.3),
  ('baron-energy', 'AED', 3, 528000, 1892000, 1540000, 1408000, 1320000, 171600, 0.14, 9, 0.81, 1.2),
  ('credo-vault', 'INR', 1, 8000000, 39000000, 12000000, 29000000, 28000000, 4900000, 6.12, 12.5, 0.3, 1.8),
  ('credo-vault', 'INR', 2, 8000000, 34100000, 14000000, 24000000, 23000000, 3800000, 4.75, 11.1, 0.41, 1.5),
  ('credo-vault', 'INR', 3, 8000000, 30300000, 15000000, 20000000, 19000000, 3100000, 3.87, 10.2, 0.49, 1.4),
  ('credo-vault', 'USD', 1, 96000, 468000, 144000, 348000, 336000, 58800, 0.07, 12.5, 0.3, 1.8),
  ('credo-vault', 'USD', 2, 96000, 409200, 168000, 288000, 276000, 45600, 0.05, 11.1, 0.41, 1.5),
  ('credo-vault', 'USD', 3, 96000, 363600, 180000, 240000, 228000, 37200, 0.04, 10.2, 0.49, 1.4),
  ('credo-vault', 'EUR', 1, 88000, 433000, 133000, 322000, 311000, 54400, 0.06, 12.5, 0.3, 1.8),
  ('credo-vault', 'EUR', 2, 88000, 378000, 155000, 266000, 255000, 42200, 0.05, 11.1, 0.41, 1.5),
  ('credo-vault', 'EUR', 3, 88000, 336000, 166000, 222000, 211000, 34400, 0.04, 10.2, 0.49, 1.4),
  ('credo-vault', 'GBP', 1, 76000, 370000, 114000, 275000, 266000, 46500, 0.05, 12.5, 0.3, 1.8),
  ('credo-vault', 'GBP', 2, 76000, 323000, 133000, 228000, 218000, 36100, 0.04, 11.1, 0.41, 1.5),
  ('credo-vault', 'GBP', 3, 76000, 287000, 142000, 190000, 180000, 29400, 0.03, 10.2, 0.49, 1.4),
  ('credo-vault', 'AED', 1, 352000, 1716000, 528000, 1276000, 1232000, 215600, 0.27, 12.5, 0.3, 1.8),
  ('credo-vault', 'AED', 2, 352000, 1500400, 616000, 1056000, 1012000, 167200, 0.21, 11.1, 0.41, 1.5),
  ('credo-vault', 'AED', 3, 352000, 1333200, 660000, 880000, 836000, 136400, 0.17, 10.2, 0.49, 1.4),
  ('delta-prime', 'INR', 1, 20000000, 65000000, 45000000, 55000000, 52000000, 5800000, 2.9, 8.9, 0.69, 1.3),
  ('delta-prime', 'INR', 2, 20000000, 59200000, 40000000, 48000000, 44000000, 4900000, 2.45, 8.2, 0.67, 1.2),
  ('delta-prime', 'INR', 3, 15000000, 54300000, 35000000, 42000000, 39000000, 4100000, 2.73, 7.5, 0.64, 1.1),
  ('delta-prime', 'USD', 1, 240000, 780000, 540000, 660000, 624000, 69600, 0.03, 8.9, 0.69, 1.3),
  ('delta-prime', 'USD', 2, 240000, 710400, 480000, 576000, 528000, 58800, 0.02, 8.2, 0.67, 1.2),
  ('delta-prime', 'USD', 3, 180000, 651600, 420000, 504000, 468000, 49200, 0.03, 7.5, 0.64, 1.1),
  ('delta-prime', 'EUR', 1, 222000, 722000, 500000, 611000, 577000, 64400, 0.03, 8.9, 0.69, 1.3),
  ('delta-prime', 'EUR', 2, 222000, 657000, 444000, 533000, 488000, 54400, 0.02, 8.2, 0.67, 1.2),
  ('delta-prime', 'EUR', 3, 166000, 603000, 388000, 466000, 433000, 45500, 0.03, 7.5, 0.64, 1.1),
  ('delta-prime', 'GBP', 1, 190000, 617000, 427000, 522000, 494000, 55100, 0.02, 8.9, 0.69, 1.3),
  ('delta-prime', 'GBP', 2, 190000, 562000, 380000, 456000, 418000, 46500, 0.02, 8.2, 0.67, 1.2),
  ('delta-prime', 'GBP', 3, 142000, 515000, 332000, 399000, 370000, 38900, 0.02, 7.5, 0.64, 1.1),
  ('delta-prime', 'AED', 1, 880000, 2860000, 1980000, 2420000, 2288000, 255200, 0.13, 8.9, 0.69, 1.3),
  ('delta-prime', 'AED', 2, 880000, 2604800, 1760000, 2112000, 1936000, 215600, 0.11, 8.2, 0.67, 1.2),
  ('delta-prime', 'AED', 3, 660000, 2389200, 1540000, 1848000, 1716000, 180400, 0.12, 7.5, 0.64, 1.1),
  ('envoy-capital', 'INR', 1, 11000000, 46000000, 16000000, 33000000, 31000000, 4300000, 3.91, 9.3, 0.34, 1.7),
  ('envoy-capital', 'INR', 2, 11000000, 41700000, 19000000, 29000000, 27000000, 3700000, 3.36, 8.8, 0.45, 1.5),
  ('envoy-capital', 'INR', 3, 10000000, 38000000, 21000000, 25000000, 23000000, 3100000, 3.1, 8.1, 0.55, 1.3),
  ('envoy-capital', 'USD', 1, 132000, 552000, 192000, 396000, 372000, 51600, 0.05, 9.3, 0.34, 1.7),
  ('envoy-capital', 'USD', 2, 132000, 500400, 228000, 348000, 324000, 44400, 0.04, 8.8, 0.45, 1.5),
  ('envoy-capital', 'USD', 3, 120000, 456000, 252000, 300000, 276000, 37200, 0.04, 8.1, 0.55, 1.3),
  ('envoy-capital', 'EUR', 1, 122000, 511000, 177000, 366000, 344000, 47700, 0.04, 9.3, 0.34, 1.7),
  ('envoy-capital', 'EUR', 2, 122000, 463000, 211000, 322000, 300000, 41100, 0.04, 8.8, 0.45, 1.5),
  ('envoy-capital', 'EUR', 3, 111000, 422000, 233000, 277000, 255000, 34400, 0.03, 8.1, 0.55, 1.3),
  ('envoy-capital', 'GBP', 1, 104000, 437000, 152000, 313000, 294000, 40800, 0.04, 9.3, 0.34, 1.7),
  ('envoy-capital', 'GBP', 2, 104000, 396000, 180000, 275000, 256000, 35100, 0.03, 8.8, 0.45, 1.5),
  ('envoy-capital', 'GBP', 3, 95000, 361000, 199000, 237000, 218000, 29400, 0.03, 8.1, 0.55, 1.3),
  ('envoy-capital', 'AED', 1, 504000, 2112000, 733200, 1513200, 1421200, 197200, 0.18, 9.3, 0.34, 1.7),
  ('envoy-capital', 'AED', 2, 504000, 1915200, 869400, 1330200, 1238400, 169740, 0.15, 8.8, 0.45, 1.5),
  ('envoy-capital', 'AED', 3, 458400, 1745400, 962400, 1146000, 1054400, 142100, 0.14, 8.1, 0.55, 1.3),
  ('future-pay', 'INR', 1, 22000000, 71000000, 50000000, 62000000, 59000000, 6900000, 3.14, 9.7, 0.7, 1.4),
  ('future-pay', 'INR', 2, 22000000, 64100000, 46000000, 54000000, 50000000, 5800000, 2.63, 9, 0.71, 1.3),
  ('future-pay', 'INR', 3, 18000000, 58300000, 41000000, 47000000, 44000000, 4900000, 2.72, 8.4, 0.7, 1.2),
  ('future-pay', 'USD', 1, 264000, 852000, 600000, 744000, 708000, 82800, 0.04, 9.7, 0.7, 1.4),
  ('future-pay', 'USD', 2, 264000, 769200, 552000, 648000, 600000, 69600, 0.03, 9, 0.71, 1.3),
  ('future-pay', 'USD', 3, 216000, 699600, 492000, 564000, 528000, 58800, 0.03, 8.4, 0.7, 1.2),
  ('future-pay', 'EUR', 1, 244000, 788000, 555000, 688000, 655000, 76600, 0.03, 9.7, 0.7, 1.4),
  ('future-pay', 'EUR', 2, 244000, 712000, 511000, 600000, 555000, 64400, 0.02, 9, 0.71, 1.3),
  ('future-pay', 'EUR', 3, 200000, 647000, 455000, 522000, 488000, 54400, 0.03, 8.4, 0.7, 1.2),
  ('future-pay', 'GBP', 1, 209000, 674000, 475000, 589000, 560000, 65500, 0.02, 9.7, 0.7, 1.4),
  ('future-pay', 'GBP', 2, 209000, 608000, 437000, 513000, 475000, 55100, 0.02, 9, 0.71, 1.3),
  ('future-pay', 'GBP', 3, 171000, 553000, 389000, 446000, 418000, 46500, 0.02, 8.4, 0.7, 1.2),
  ('future-pay', 'AED', 1, 968000, 3124000, 2200000, 2728000, 2596000, 303600, 0.14, 9.7, 0.7, 1.4),
  ('future-pay', 'AED', 2, 968000, 2820400, 2024000, 2376000, 2200000, 255200, 0.12, 9, 0.71, 1.3),
  ('future-pay', 'AED', 3, 792000, 2565200, 1804000, 2068000, 1936000, 215600, 0.12, 8.4, 0.7, 1.2),
  ('growth-matrix', 'INR', 1, 13000000, 50000000, 17000000, 38000000, 35000000, 5400000, 4.15, 10.8, 0.34, 1.7),
  ('growth-matrix', 'INR', 2, 13000000, 44600000, 20000000, 32000000, 29000000, 4600000, 3.53, 10.3, 0.44, 1.5),
  ('growth-matrix', 'INR', 3, 11000000, 40000000, 23000000, 28000000, 25000000, 3900000, 3.54, 9.7, 0.57, 1.4),
  ('growth-matrix', 'USD', 1, 156000, 600000, 204000, 456000, 420000, 64800, 0.05, 10.8, 0.34, 1.7),
  ('growth-matrix', 'USD', 2, 156000, 535200, 240000, 384000, 348000, 55200, 0.04, 10.3, 0.44, 1.5),
  ('growth-matrix', 'USD', 3, 132000, 480000, 276000, 336000, 300000, 46800, 0.04, 9.7, 0.57, 1.4),
  ('growth-matrix', 'EUR', 1, 144000, 555000, 188000, 422000, 388000, 60000, 0.05, 10.8, 0.34, 1.7),
  ('growth-matrix', 'EUR', 2, 144000, 495000, 222000, 355000, 322000, 51100, 0.04, 10.3, 0.44, 1.5),
  ('growth-matrix', 'EUR', 3, 122000, 444000, 255000, 311000, 277000, 43300, 0.04, 9.7, 0.57, 1.4),
  ('growth-matrix', 'GBP', 1, 123000, 475000, 161000, 361000, 332000, 51300, 0.04, 10.8, 0.34, 1.7),
  ('growth-matrix', 'GBP', 2, 123000, 423000, 190000, 304000, 275000, 43700, 0.03, 10.3, 0.44, 1.5),
  ('growth-matrix', 'GBP', 3, 104000, 380000, 218000, 266000, 237000, 37000, 0.03, 9.7, 0.57, 1.4),
  ('growth-matrix', 'AED', 1, 572000, 2200000, 748000, 1672000, 1540000, 237600, 0.18, 10.8, 0.34, 1.7),
  ('growth-matrix', 'AED', 2, 572000, 1962400, 880000, 1408000, 1276000, 202400, 0.16, 10.3, 0.44, 1.5),
  ('growth-matrix', 'AED', 3, 484000, 1760000, 1012000, 1232000, 1100000, 171600, 0.16, 9.7, 0.57, 1.4),
  ('helix-crypto', 'INR', 1, 17000000, 56000000, 32000000, 43000000, 41000000, 5100000, 3, 9.1, 0.57, 1.4),
  ('helix-crypto', 'INR', 2, 17000000, 50900000, 29000000, 37000000, 35000000, 4400000, 2.58, 8.6, 0.57, 1.3),
  ('helix-crypto', 'INR', 3, 14000000, 46500000, 26000000, 33000000, 31000000, 3800000, 2.71, 8.1, 0.55, 1.2),
  ('helix-crypto', 'USD', 1, 204000, 672000, 384000, 516000, 492000, 61200, 0.04, 9.1, 0.57, 1.4),
  ('helix-crypto', 'USD', 2, 204000, 610800, 348000, 444000, 420000, 52800, 0.03, 8.6, 0.57, 1.3),
  ('helix-crypto', 'USD', 3, 168000, 558000, 312000, 396000, 372000, 45600, 0.03, 8.1, 0.55, 1.2),
  ('helix-crypto', 'EUR', 1, 188000, 622000, 355000, 477000, 455000, 56600, 0.03, 9.1, 0.57, 1.4),
  ('helix-crypto', 'EUR', 2, 188000, 565000, 322000, 411000, 388000, 48800, 0.02, 8.6, 0.57, 1.3),
  ('helix-crypto', 'EUR', 3, 155000, 516000, 288000, 366000, 344000, 42200, 0.03, 8.1, 0.55, 1.2),
  ('helix-crypto', 'GBP', 1, 161000, 532000, 304000, 408000, 389000, 48400, 0.03, 9.1, 0.57, 1.4),
  ('helix-crypto', 'GBP', 2, 161000, 483000, 275000, 351000, 332000, 41800, 0.02, 8.6, 0.57, 1.3),
  ('helix-crypto', 'GBP', 3, 133000, 441000, 247000, 313000, 294000, 36100, 0.03, 8.1, 0.55, 1.2),
  ('helix-crypto', 'AED', 1, 748000, 2464000, 1408000, 1892000, 1804000, 224400, 0.13, 9.1, 0.57, 1.4),
  ('helix-crypto', 'AED', 2, 748000, 2239600, 1276000, 1628000, 1540000, 193600, 0.11, 8.6, 0.57, 1.3),
  ('helix-crypto', 'AED', 3, 616000, 2046000, 1144000, 1452000, 1364000, 167200, 0.12, 8.1, 0.55, 1.2),
  ('intellect-bonds', 'INR', 1, 10000000, 44000000, 15000000, 31000000, 29000000, 4100000, 4.1, 9.3, 0.34, 1.6),
  ('intellect-bonds', 'INR', 2, 10000000, 39900000, 17000000, 27000000, 25000000, 3500000, 3.5, 8.7, 0.42, 1.4),
  ('intellect-bonds', 'INR', 3, 9000000, 36400000, 19000000, 23000000, 21000000, 2900000, 3.22, 7.9, 0.52, 1.3),
  ('intellect-bonds', 'USD', 1, 120000, 528000, 180000, 372000, 348000, 49200, 0.05, 9.3, 0.34, 1.6),
  ('intellect-bonds', 'USD', 2, 120000, 478800, 204000, 324000, 300000, 42000, 0.04, 8.7, 0.42, 1.4),
  ('intellect-bonds', 'USD', 3, 108000, 436800, 228000, 276000, 252000, 34800, 0.04, 7.9, 0.52, 1.3),
  ('intellect-bonds', 'EUR', 1, 111000, 488000, 166000, 344000, 322000, 45500, 0.04, 9.3, 0.34, 1.6),
  ('intellect-bonds', 'EUR', 2, 111000, 443000, 188000, 300000, 277000, 38800, 0.03, 8.7, 0.42, 1.4),
  ('intellect-bonds', 'EUR', 3, 100000, 404000, 211000, 255000, 233000, 32200, 0.03, 7.9, 0.52, 1.3),
  ('intellect-bonds', 'GBP', 1, 95000, 418000, 142000, 294000, 275000, 38900, 0.04, 9.3, 0.34, 1.6),
  ('intellect-bonds', 'GBP', 2, 95000, 379000, 161000, 256000, 237000, 33200, 0.03, 8.7, 0.42, 1.4),
  ('intellect-bonds', 'GBP', 3, 85000, 345000, 180000, 218000, 199000, 27500, 0.03, 7.9, 0.52, 1.3),
  ('intellect-bonds', 'AED', 1, 440000, 1936000, 660000, 1364000, 1276000, 180400, 0.18, 9.3, 0.34, 1.6),
  ('intellect-bonds', 'AED', 2, 440000, 1755600, 748000, 1188000, 1100000, 154000, 0.15, 8.7, 0.42, 1.4),
  ('intellect-bonds', 'AED', 3, 396000, 1601600, 836000, 1012000, 924000, 127600, 0.14, 7.9, 0.52, 1.3),
  ('janus-trade', 'INR', 1, 19000000, 61000000, 42000000, 51000000, 48000000, 5400000, 2.84, 8.8, 0.68, 1.3),
  ('janus-trade', 'INR', 2, 19000000, 55600000, 38000000, 45000000, 41000000, 4600000, 2.42, 8.2, 0.68, 1.2),
  ('janus-trade', 'INR', 3, 14000000, 51000000, 33000000, 39000000, 36000000, 3900000, 2.78, 7.6, 0.64, 1.1),
  ('janus-trade', 'USD', 1, 228000, 732000, 504000, 612000, 576000, 64800, 0.03, 8.8, 0.68, 1.3),
  ('janus-trade', 'USD', 2, 228000, 667200, 456000, 540000, 492000, 55200, 0.02, 8.2, 0.68, 1.2),
  ('janus-trade', 'USD', 3, 168000, 612000, 396000, 468000, 432000, 46800, 0.03, 7.6, 0.64, 1.1),
  ('janus-trade', 'EUR', 1, 211000, 677000, 466000, 566000, 533000, 60000, 0.03, 8.8, 0.68, 1.3),
  ('janus-trade', 'EUR', 2, 211000, 617000, 422000, 500000, 455000, 51100, 0.02, 8.2, 0.68, 1.2),
  ('janus-trade', 'EUR', 3, 155000, 566000, 366000, 433000, 400000, 43300, 0.03, 7.6, 0.64, 1.1),
  ('janus-trade', 'GBP', 1, 180000, 579000, 399000, 484000, 456000, 51300, 0.02, 8.8, 0.68, 1.3),
  ('janus-trade', 'GBP', 2, 180000, 528000, 361000, 427000, 389000, 43700, 0.02, 8.2, 0.68, 1.2),
  ('janus-trade', 'GBP', 3, 133000, 484000, 313000, 370000, 342000, 37000, 0.02, 7.6, 0.64, 1.1),
  ('janus-trade', 'AED', 1, 836000, 2684000, 1848000, 2244000, 2112000, 237600, 0.12, 8.8, 0.68, 1.3),
  ('janus-trade', 'AED', 2, 836000, 2446400, 1672000, 1980000, 1804000, 202400, 0.1, 8.2, 0.68, 1.2),
  ('janus-trade', 'AED', 3, 616000, 2244000, 1452000, 1716000, 1584000, 171600, 0.12, 7.6, 0.64, 1.1)
) as f (slug, currency, year_index, a, b, c, d, e, f, g, h, i, j)
join public.roadshows r on r.slug = f.slug
on conflict (roadshow_id, currency, year_index) do nothing;

insert into public.roadshow_qa (roadshow_id, category, position, question, answer)
select r.id, x.category, x.position, x.question, x.answer
from (values
  ('apex-ledger', 'TOP ASKED', 1, 'What is the minimum investment?', 'The minimum investment amount varies by asset class but typically starts at $1,000.'),
  ('apex-ledger', 'TOP ASKED', 2, 'How often are returns credited?', 'Returns are usually credited on a quarterly basis.'),
  ('apex-ledger', 'TOP ASKED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('apex-ledger', 'RECENTLY ADDED', 1, 'Can I withdraw before maturity?', 'Premature withdrawal is subject to a 2% penalty.'),
  ('apex-ledger', 'RECENTLY ADDED', 2, 'Is this investment tax-exempt?', 'Tax implications depend on your jurisdiction. Please consult a tax advisor.'),
  ('apex-ledger', 'RECENTLY ADDED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('apex-ledger', 'EQUITY', 1, 'What is the expected ROI?', 'Historically, equity investments here target 12-15% annualized returns.'),
  ('apex-ledger', 'EQUITY', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('apex-ledger', 'EQUITY', 3, 'Do I get voting rights?', 'Yes, equity shares come with standard voting rights.'),
  ('apex-ledger', 'DEBT', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('apex-ledger', 'DEBT', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('apex-ledger', 'DEBT', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('apex-ledger', 'INSURANCE', 1, 'What risks are covered?', 'Coverage includes capital protection against default events.'),
  ('apex-ledger', 'INSURANCE', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('apex-ledger', 'INSURANCE', 3, 'How long is the claim process?', 'Claims are typically processed within 14-21 business days.'),
  ('apex-ledger', 'CRYPTO', 1, 'Which tokens are supported?', 'We support major tokens like BTC, ETH, and stablecoins.'),
  ('apex-ledger', 'CRYPTO', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('apex-ledger', 'CRYPTO', 3, 'Is the wallet non-custodial?', 'No, we use a secure institutional custodial solution.'),
  ('apex-ledger', 'MUTUAL FUNDS', 1, 'What is the expense ratio?', 'The expense ratio is capped at 0.75% per annum.'),
  ('apex-ledger', 'MUTUAL FUNDS', 2, 'Is there a lock-in period?', 'Only for ELSS funds, which have a 3-year lock-in.'),
  ('apex-ledger', 'MUTUAL FUNDS', 3, 'Are there exit loads?', 'Exit load of 1% applies if redeemed within 1 year.'),
  ('apex-ledger', 'LAST_THREE', 1, 'What asset class does a Gold ETF belong to?', '1.25x backed by tangible enterprise assets.'),
  ('apex-ledger', 'LAST_THREE', 2, 'An investor wants to track the performance of the Sensex rather than beat it. Which type of fund should they consider?', 'Yes, fully managed by standard security trustees.'),
  ('apex-ledger', 'LAST_THREE', 3, 'An investor wants professional portfolio management without selecting individual stocks. Which product can help?', 'Monthly on the first calendar week of each block.'),
  ('baron-energy', 'TOP ASKED', 1, 'What is the minimum investment?', 'The minimum investment amount varies by asset class but typically starts at $1,000.'),
  ('baron-energy', 'TOP ASKED', 2, 'How often are returns credited?', 'Returns are usually credited on a quarterly basis.'),
  ('baron-energy', 'TOP ASKED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('baron-energy', 'RECENTLY ADDED', 1, 'Can I withdraw before maturity?', 'Premature withdrawal is subject to a 2% penalty.'),
  ('baron-energy', 'RECENTLY ADDED', 2, 'Is this investment tax-exempt?', 'Tax implications depend on your jurisdiction. Please consult a tax advisor.'),
  ('baron-energy', 'RECENTLY ADDED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('baron-energy', 'EQUITY', 1, 'What is the expected ROI?', 'Historically, equity investments here target 12-15% annualized returns.'),
  ('baron-energy', 'EQUITY', 2, 'Do I get voting rights?', 'Yes, equity shares come with standard voting rights.'),
  ('baron-energy', 'EQUITY', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('baron-energy', 'DEBT', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('baron-energy', 'DEBT', 2, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('baron-energy', 'DEBT', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('baron-energy', 'INSURANCE', 1, 'What risks are covered?', 'Coverage includes capital protection against default events.'),
  ('baron-energy', 'INSURANCE', 2, 'How long is the claim process?', 'Claims are typically processed within 14-21 business days.'),
  ('baron-energy', 'INSURANCE', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('baron-energy', 'CRYPTO', 1, 'Which tokens are supported?', 'We support major tokens like BTC, ETH, and stablecoins.'),
  ('baron-energy', 'CRYPTO', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('baron-energy', 'CRYPTO', 3, 'Is the wallet non-custodial?', 'No, we use a secure institutional custodial solution.'),
  ('baron-energy', 'MUTUAL FUNDS', 1, 'What is the expense ratio?', 'The expense ratio is capped at 0.75% per annum.'),
  ('baron-energy', 'MUTUAL FUNDS', 2, 'Is there a lock-in period?', 'Only for ELSS funds, which have a 3-year lock-in.'),
  ('baron-energy', 'MUTUAL FUNDS', 3, 'Are there exit loads?', 'Exit load of 1% applies if redeemed within 1 year.'),
  ('baron-energy', 'LAST_THREE', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('baron-energy', 'LAST_THREE', 2, 'Are funds kept in an escrow account?', 'Yes, fully managed by standard security trustees.'),
  ('baron-energy', 'LAST_THREE', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('credo-vault', 'TOP ASKED', 1, 'What is the minimum investment?', 'The minimum investment amount varies by asset class but typically starts at $1,000.'),
  ('credo-vault', 'TOP ASKED', 2, 'How often are returns credited?', 'Returns are usually credited on a quarterly basis.'),
  ('credo-vault', 'TOP ASKED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('credo-vault', 'RECENTLY ADDED', 1, 'Can I withdraw before maturity?', 'Premature withdrawal is subject to a 2% penalty.'),
  ('credo-vault', 'RECENTLY ADDED', 2, 'Is this investment tax-exempt?', 'Tax implications depend on your jurisdiction. Please consult a tax advisor.'),
  ('credo-vault', 'RECENTLY ADDED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('credo-vault', 'EQUITY', 1, 'What is the expected ROI?', 'Historically, equity investments here target 12-15% annualized returns.'),
  ('credo-vault', 'EQUITY', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('credo-vault', 'EQUITY', 3, 'Do I get voting rights?', 'Yes, equity shares come with standard voting rights.'),
  ('credo-vault', 'DEBT', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('credo-vault', 'DEBT', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('credo-vault', 'DEBT', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('credo-vault', 'INSURANCE', 1, 'What risks are covered?', 'Coverage includes capital protection against default events.'),
  ('credo-vault', 'INSURANCE', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('credo-vault', 'INSURANCE', 3, 'How long is the claim process?', 'Claims are typically processed within 14-21 business days.'),
  ('credo-vault', 'CRYPTO', 1, 'Which tokens are supported?', 'We support major tokens like BTC, ETH, and stablecoins.'),
  ('credo-vault', 'CRYPTO', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('credo-vault', 'CRYPTO', 3, 'Is the wallet non-custodial?', 'No, we use a secure institutional custodial solution.'),
  ('credo-vault', 'MUTUAL FUNDS', 1, 'What is the expense ratio?', 'The expense ratio is capped at 0.75% per annum.'),
  ('credo-vault', 'MUTUAL FUNDS', 2, 'Is there a lock-in period?', 'Only for ELSS funds, which have a 3-year lock-in.'),
  ('credo-vault', 'MUTUAL FUNDS', 3, 'Are there exit loads?', 'Exit load of 1% applies if redeemed within 1 year.'),
  ('credo-vault', 'LAST_THREE', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('credo-vault', 'LAST_THREE', 2, 'Are funds kept in an escrow account?', 'Yes, fully managed by standard security trustees.'),
  ('credo-vault', 'LAST_THREE', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('delta-prime', 'TOP ASKED', 1, 'What is the minimum investment?', 'The minimum investment amount varies by asset class but typically starts at $1,000.'),
  ('delta-prime', 'TOP ASKED', 2, 'How often are returns credited?', 'Returns are usually credited on a quarterly basis.'),
  ('delta-prime', 'TOP ASKED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('delta-prime', 'RECENTLY ADDED', 1, 'Can I withdraw before maturity?', 'Premature withdrawal is subject to a 2% penalty.'),
  ('delta-prime', 'RECENTLY ADDED', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('delta-prime', 'RECENTLY ADDED', 3, 'Is this investment tax-exempt?', 'Tax implications depend on your jurisdiction. Please consult a tax advisor.'),
  ('delta-prime', 'EQUITY', 1, 'What is the expected ROI?', 'Historically, equity investments here target 12-15% annualized returns.'),
  ('delta-prime', 'EQUITY', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('delta-prime', 'EQUITY', 3, 'Do I get voting rights?', 'Yes, equity shares come with standard voting rights.'),
  ('delta-prime', 'DEBT', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('delta-prime', 'DEBT', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('delta-prime', 'DEBT', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('delta-prime', 'INSURANCE', 1, 'What risks are covered?', 'Coverage includes capital protection against default events.'),
  ('delta-prime', 'INSURANCE', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('delta-prime', 'INSURANCE', 3, 'How long is the claim process?', 'Claims are typically processed within 14-21 business days.'),
  ('delta-prime', 'CRYPTO', 1, 'Which tokens are supported?', 'We support major tokens like BTC, ETH, and stablecoins.'),
  ('delta-prime', 'CRYPTO', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('delta-prime', 'CRYPTO', 3, 'Is the wallet non-custodial?', 'No, we use a secure institutional custodial solution.'),
  ('delta-prime', 'MUTUAL FUNDS', 1, 'What is the expense ratio?', 'The expense ratio is capped at 0.75% per annum.'),
  ('delta-prime', 'MUTUAL FUNDS', 2, 'Is there a lock-in period?', 'Only for ELSS funds, which have a 3-year lock-in.'),
  ('delta-prime', 'MUTUAL FUNDS', 3, 'Are there exit loads?', 'Exit load of 1% applies if redeemed within 1 year.'),
  ('delta-prime', 'LAST_THREE', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('delta-prime', 'LAST_THREE', 2, 'Are funds kept in an escrow account?', 'Yes, fully managed by standard security trustees.'),
  ('delta-prime', 'LAST_THREE', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('envoy-capital', 'TOP ASKED', 1, 'What is the minimum investment?', 'The minimum investment amount varies by asset class but typically starts at $1,000.'),
  ('envoy-capital', 'TOP ASKED', 2, 'How often are returns credited?', 'Returns are usually credited on a quarterly basis.'),
  ('envoy-capital', 'TOP ASKED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('envoy-capital', 'RECENTLY ADDED', 1, 'Can I withdraw before maturity?', 'Premature withdrawal is subject to a 2% penalty.'),
  ('envoy-capital', 'RECENTLY ADDED', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('envoy-capital', 'RECENTLY ADDED', 3, 'Is this investment tax-exempt?', 'Tax implications depend on your jurisdiction. Please consult a tax advisor.'),
  ('envoy-capital', 'EQUITY', 1, 'What is the expected ROI?', 'Historically, equity investments here target 12-15% annualized returns.'),
  ('envoy-capital', 'EQUITY', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('envoy-capital', 'EQUITY', 3, 'Do I get voting rights?', 'Yes, equity shares come with standard voting rights.'),
  ('envoy-capital', 'DEBT', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('envoy-capital', 'DEBT', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('envoy-capital', 'DEBT', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('envoy-capital', 'INSURANCE', 1, 'What risks are covered?', 'Coverage includes capital protection against default events.'),
  ('envoy-capital', 'INSURANCE', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('envoy-capital', 'INSURANCE', 3, 'How long is the claim process?', 'Claims are typically processed within 14-21 business days.'),
  ('envoy-capital', 'CRYPTO', 1, 'Which tokens are supported?', 'We support major tokens like BTC, ETH, and stablecoins.'),
  ('envoy-capital', 'CRYPTO', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('envoy-capital', 'CRYPTO', 3, 'Is the wallet non-custodial?', 'No, we use a secure institutional custodial solution.'),
  ('envoy-capital', 'MUTUAL FUNDS', 1, 'What is the expense ratio?', 'The expense ratio is capped at 0.75% per annum.'),
  ('envoy-capital', 'MUTUAL FUNDS', 2, 'Is there a lock-in period?', 'Only for ELSS funds, which have a 3-year lock-in.'),
  ('envoy-capital', 'MUTUAL FUNDS', 3, 'Are there exit loads?', 'Exit load of 1% applies if redeemed within 1 year.'),
  ('envoy-capital', 'LAST_THREE', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('envoy-capital', 'LAST_THREE', 2, 'Are funds kept in an escrow account?', 'Yes, fully managed by standard security trustees.'),
  ('envoy-capital', 'LAST_THREE', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('future-pay', 'TOP ASKED', 1, 'What is the minimum investment?', 'The minimum investment amount varies by asset class but typically starts at $1,000.'),
  ('future-pay', 'TOP ASKED', 2, 'How often are returns credited?', 'Returns are usually credited on a quarterly basis.'),
  ('future-pay', 'TOP ASKED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('future-pay', 'RECENTLY ADDED', 1, 'Can I withdraw before maturity?', 'Premature withdrawal is subject to a 2% penalty.'),
  ('future-pay', 'RECENTLY ADDED', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('future-pay', 'RECENTLY ADDED', 3, 'Is this investment tax-exempt?', 'Tax implications depend on your jurisdiction. Please consult a tax advisor.'),
  ('future-pay', 'EQUITY', 1, 'What is the expected ROI?', 'Historically, equity investments here target 12-15% annualized returns.'),
  ('future-pay', 'EQUITY', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('future-pay', 'EQUITY', 3, 'Do I get voting rights?', 'Yes, equity shares come with standard voting rights.'),
  ('future-pay', 'DEBT', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('future-pay', 'DEBT', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('future-pay', 'DEBT', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('future-pay', 'INSURANCE', 1, 'What risks are covered?', 'Coverage includes capital protection against default events.'),
  ('future-pay', 'INSURANCE', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('future-pay', 'INSURANCE', 3, 'How long is the claim process?', 'Claims are typically processed within 14-21 business days.'),
  ('future-pay', 'CRYPTO', 1, 'Which tokens are supported?', 'We support major tokens like BTC, ETH, and stablecoins.'),
  ('future-pay', 'CRYPTO', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('future-pay', 'CRYPTO', 3, 'Is the wallet non-custodial?', 'No, we use a secure institutional custodial solution.'),
  ('future-pay', 'MUTUAL FUNDS', 1, 'What is the expense ratio?', 'The expense ratio is capped at 0.75% per annum.'),
  ('future-pay', 'MUTUAL FUNDS', 2, 'Is there a lock-in period?', 'Only for ELSS funds, which have a 3-year lock-in.'),
  ('future-pay', 'MUTUAL FUNDS', 3, 'Are there exit loads?', 'Exit load of 1% applies if redeemed within 1 year.'),
  ('future-pay', 'LAST_THREE', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('future-pay', 'LAST_THREE', 2, 'Are funds kept in an escrow account?', 'Yes, fully managed by standard security trustees.'),
  ('future-pay', 'LAST_THREE', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('growth-matrix', 'TOP ASKED', 1, 'What is the minimum investment?', 'The minimum investment amount varies by asset class but typically starts at $1,000.'),
  ('growth-matrix', 'TOP ASKED', 2, 'How often are returns credited?', 'Returns are usually credited on a quarterly basis.'),
  ('growth-matrix', 'TOP ASKED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('growth-matrix', 'RECENTLY ADDED', 1, 'Can I withdraw before maturity?', 'Premature withdrawal is subject to a 2% penalty.'),
  ('growth-matrix', 'RECENTLY ADDED', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('growth-matrix', 'RECENTLY ADDED', 3, 'Is this investment tax-exempt?', 'Tax implications depend on your jurisdiction. Please consult a tax advisor.'),
  ('growth-matrix', 'EQUITY', 1, 'What is the expected ROI?', 'Historically, equity investments here target 12-15% annualized returns.'),
  ('growth-matrix', 'EQUITY', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('growth-matrix', 'EQUITY', 3, 'Do I get voting rights?', 'Yes, equity shares come with standard voting rights.'),
  ('growth-matrix', 'DEBT', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('growth-matrix', 'DEBT', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('growth-matrix', 'DEBT', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('growth-matrix', 'INSURANCE', 1, 'What risks are covered?', 'Coverage includes capital protection against default events.'),
  ('growth-matrix', 'INSURANCE', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('growth-matrix', 'INSURANCE', 3, 'How long is the claim process?', 'Claims are typically processed within 14-21 business days.'),
  ('growth-matrix', 'CRYPTO', 1, 'Which tokens are supported?', 'We support major tokens like BTC, ETH, and stablecoins.'),
  ('growth-matrix', 'CRYPTO', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('growth-matrix', 'CRYPTO', 3, 'Is the wallet non-custodial?', 'No, we use a secure institutional custodial solution.'),
  ('growth-matrix', 'MUTUAL FUNDS', 1, 'What is the expense ratio?', 'The expense ratio is capped at 0.75% per annum.'),
  ('growth-matrix', 'MUTUAL FUNDS', 2, 'Is there a lock-in period?', 'Only for ELSS funds, which have a 3-year lock-in.'),
  ('growth-matrix', 'MUTUAL FUNDS', 3, 'Are there exit loads?', 'Exit load of 1% applies if redeemed within 1 year.'),
  ('growth-matrix', 'LAST_THREE', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('growth-matrix', 'LAST_THREE', 2, 'Are funds kept in an escrow account?', 'Yes, fully managed by standard security trustees.'),
  ('growth-matrix', 'LAST_THREE', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('helix-crypto', 'TOP ASKED', 1, 'What is the minimum investment?', 'The minimum investment amount varies by asset class but typically starts at $1,000.'),
  ('helix-crypto', 'TOP ASKED', 2, 'How often are returns credited?', 'Returns are usually credited on a quarterly basis.'),
  ('helix-crypto', 'TOP ASKED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('helix-crypto', 'RECENTLY ADDED', 1, 'Can I withdraw before maturity?', 'Premature withdrawal is subject to a 2% penalty.'),
  ('helix-crypto', 'RECENTLY ADDED', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('helix-crypto', 'RECENTLY ADDED', 3, 'Is this investment tax-exempt?', 'Tax implications depend on your jurisdiction. Please consult a tax advisor.'),
  ('helix-crypto', 'EQUITY', 1, 'What is the expected ROI?', 'Historically, equity investments here target 12-15% annualized returns.'),
  ('helix-crypto', 'EQUITY', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('helix-crypto', 'EQUITY', 3, 'Do I get voting rights?', 'Yes, equity shares come with standard voting rights.'),
  ('helix-crypto', 'DEBT', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('helix-crypto', 'DEBT', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('helix-crypto', 'DEBT', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('helix-crypto', 'INSURANCE', 1, 'What risks are covered?', 'Coverage includes capital protection against default events.'),
  ('helix-crypto', 'INSURANCE', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('helix-crypto', 'INSURANCE', 3, 'How long is the claim process?', 'Claims are typically processed within 14-21 business days.'),
  ('helix-crypto', 'CRYPTO', 1, 'Which tokens are supported?', 'We support major tokens like BTC, ETH, and stablecoins.'),
  ('helix-crypto', 'CRYPTO', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('helix-crypto', 'CRYPTO', 3, 'Is the wallet non-custodial?', 'No, we use a secure institutional custodial solution.'),
  ('helix-crypto', 'MUTUAL FUNDS', 1, 'What is the expense ratio?', 'The expense ratio is capped at 0.75% per annum.'),
  ('helix-crypto', 'MUTUAL FUNDS', 2, 'Is there a lock-in period?', 'Only for ELSS funds, which have a 3-year lock-in.'),
  ('helix-crypto', 'MUTUAL FUNDS', 3, 'Are there exit loads?', 'Exit load of 1% applies if redeemed within 1 year.'),
  ('helix-crypto', 'LAST_THREE', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('helix-crypto', 'LAST_THREE', 2, 'Are funds kept in an escrow account?', 'Yes, fully managed by standard security trustees.'),
  ('helix-crypto', 'LAST_THREE', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('intellect-bonds', 'TOP ASKED', 1, 'What is the minimum investment?', 'The minimum investment amount varies by asset class but typically starts at $1,000.'),
  ('intellect-bonds', 'TOP ASKED', 2, 'How often are returns credited?', 'Returns are usually credited on a quarterly basis.'),
  ('intellect-bonds', 'TOP ASKED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('intellect-bonds', 'RECENTLY ADDED', 1, 'Can I withdraw before maturity?', 'Premature withdrawal is subject to a 2% penalty.'),
  ('intellect-bonds', 'RECENTLY ADDED', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('intellect-bonds', 'RECENTLY ADDED', 3, 'Is this investment tax-exempt?', 'Tax implications depend on your jurisdiction. Please consult a tax advisor.'),
  ('intellect-bonds', 'EQUITY', 1, 'What is the expected ROI?', 'Historically, equity investments here target 12-15% annualized returns.'),
  ('intellect-bonds', 'EQUITY', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('intellect-bonds', 'EQUITY', 3, 'Do I get voting rights?', 'Yes, equity shares come with standard voting rights.'),
  ('intellect-bonds', 'DEBT', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('intellect-bonds', 'DEBT', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('intellect-bonds', 'DEBT', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('intellect-bonds', 'INSURANCE', 1, 'What risks are covered?', 'Coverage includes capital protection against default events.'),
  ('intellect-bonds', 'INSURANCE', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('intellect-bonds', 'INSURANCE', 3, 'How long is the claim process?', 'Claims are typically processed within 14-21 business days.'),
  ('intellect-bonds', 'CRYPTO', 1, 'Which tokens are supported?', 'We support major tokens like BTC, ETH, and stablecoins.'),
  ('intellect-bonds', 'CRYPTO', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('intellect-bonds', 'CRYPTO', 3, 'Is the wallet non-custodial?', 'No, we use a secure institutional custodial solution.'),
  ('intellect-bonds', 'MUTUAL FUNDS', 1, 'What is the expense ratio?', 'The expense ratio is capped at 0.75% per annum.'),
  ('intellect-bonds', 'MUTUAL FUNDS', 2, 'Is there a lock-in period?', 'Only for ELSS funds, which have a 3-year lock-in.'),
  ('intellect-bonds', 'MUTUAL FUNDS', 3, 'Are there exit loads?', 'Exit load of 1% applies if redeemed within 1 year.'),
  ('intellect-bonds', 'LAST_THREE', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('intellect-bonds', 'LAST_THREE', 2, 'Are funds kept in an escrow account?', 'Yes, fully managed by standard security trustees.'),
  ('intellect-bonds', 'LAST_THREE', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('janus-trade', 'TOP ASKED', 1, 'What is the minimum investment?', 'The minimum investment amount varies by asset class but typically starts at $1,000.'),
  ('janus-trade', 'TOP ASKED', 2, 'How often are returns credited?', 'Returns are usually credited on a quarterly basis.'),
  ('janus-trade', 'TOP ASKED', 3, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('janus-trade', 'RECENTLY ADDED', 1, 'Can I withdraw before maturity?', 'Premature withdrawal is subject to a 2% penalty.'),
  ('janus-trade', 'RECENTLY ADDED', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('janus-trade', 'RECENTLY ADDED', 3, 'Is this investment tax-exempt?', 'Tax implications depend on your jurisdiction. Please consult a tax advisor.'),
  ('janus-trade', 'EQUITY', 1, 'What is the expected ROI?', 'Historically, equity investments here target 12-15% annualized returns.'),
  ('janus-trade', 'EQUITY', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('janus-trade', 'EQUITY', 3, 'Do I get voting rights?', 'Yes, equity shares come with standard voting rights.'),
  ('janus-trade', 'DEBT', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('janus-trade', 'DEBT', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('janus-trade', 'DEBT', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.'),
  ('janus-trade', 'INSURANCE', 1, 'What risks are covered?', 'Coverage includes capital protection against default events.'),
  ('janus-trade', 'INSURANCE', 2, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('janus-trade', 'INSURANCE', 3, 'How long is the claim process?', 'Claims are typically processed within 14-21 business days.'),
  ('janus-trade', 'CRYPTO', 1, 'Are there any hidden charges?', 'No, all fees are transparently listed in the term sheet.'),
  ('janus-trade', 'CRYPTO', 2, 'Which tokens are supported?', 'We support major tokens like BTC, ETH, and stablecoins.'),
  ('janus-trade', 'CRYPTO', 3, 'Is the wallet non-custodial?', 'No, we use a secure institutional custodial solution.'),
  ('janus-trade', 'MUTUAL FUNDS', 1, 'What is the expense ratio?', 'The expense ratio is capped at 0.75% per annum.'),
  ('janus-trade', 'MUTUAL FUNDS', 2, 'Is there a lock-in period?', 'Only for ELSS funds, which have a 3-year lock-in.'),
  ('janus-trade', 'MUTUAL FUNDS', 3, 'Are there exit loads?', 'Exit load of 1% applies if redeemed within 1 year.'),
  ('janus-trade', 'LAST_THREE', 1, 'What is the security coverage ratio?', '1.25x backed by tangible enterprise assets.'),
  ('janus-trade', 'LAST_THREE', 2, 'Are funds kept in an escrow account?', 'Yes, fully managed by standard security trustees.'),
  ('janus-trade', 'LAST_THREE', 3, 'When does coupon payouts commence?', 'Monthly on the first calendar week of each block.')
) as x (slug, category, position, question, answer)
join public.roadshows r on r.slug = x.slug
on conflict (roadshow_id, category, position) do nothing;

insert into public.roadshow_pool_content (
  roadshow_id, participants, capital_interest_label, your_credit, higher_roi_irr,
  lower_lock_in_period, reduced_entry_exit_load, better_allotment_preference, flexible_payment_terms
)
select r.id, p.participants, p.capital_interest, p.your_credit, p.a, p.b, p.c, p.d, p.e
from (values
  ('apex-ledger', 152, '₹14Cr', 4, '89%', '87%', '83%', '55%', '14%'),
  ('baron-energy', null, null, null, null, null, null, null, null),
  ('credo-vault', 125, '₹18Cr', 5, '88%', '98%', '92%', '50%', '15%'),
  ('delta-prime', null, null, null, null, null, null, null, null),
  ('envoy-capital', 210, '₹25Cr', 7, '85%', '89%', '82%', '60%', '18%'),
  ('future-pay', null, null, null, null, null, null, null, null),
  ('growth-matrix', 90, '₹10Cr', 3, '90%', '95%', '92%', '45%', '10%'),
  ('helix-crypto', null, null, null, null, null, null, null, null),
  ('intellect-bonds', 300, '₹45Cr', 9, '91%', '85%', '96%', '75%', '25%'),
  ('janus-trade', null, null, null, null, null, null, null, null)
) as p (slug, participants, capital_interest, your_credit, a, b, c, d, e)
join public.roadshows r on r.slug = p.slug
on conflict (roadshow_id) do nothing;

update public.roadshows r
set search_text = lower(coalesce(r.company_name, r.title) || ' ' || array_to_string(r.tags, ' '))
where r.slug in (select slug from app_roadshows);

drop table app_roadshows;

-- The Power Pool's option labels as the app shows them: the 8 expectation pills, the heat map's
-- 5 rows, and the note under each demanded improvement.
insert into public.app_content (key, value) values
('roadshows.pool', $json${
  "expectations": [
    { "code": "HIGHER_ROI_IRR", "label": "Higher ROI/IRR" },
    { "code": "LOWER_LOCK_IN", "label": "Lower lock in-period" },
    { "code": "REDUCED_ENTRY_EXIT_LOAD", "label": "Reduced entry /exit load" },
    { "code": "TENURE_PREFERENCE", "label": "Tenure preference" },
    { "code": "BETTER_ALLOTMENT", "label": "Better allotment preference" },
    { "code": "FLEXIBLE_PAYMENT_TERMS", "label": "Flexible payment terms" },
    { "code": "LOWER_MINIMUM_TICKET", "label": "Lower minimum ticket" },
    { "code": "CASHBACK_ON_REINVESTMENT", "label": "Cashback on reinvestment" }
  ],
  "heatMap": [
    { "code": "HIGHER_ROI_IRR", "label": "HIGHER ROI / IRR", "field": "higherRoiIrr" },
    { "code": "LOWER_LOCK_IN", "label": "LOWER LOCK-IN PERIOD", "field": "lowerLockInPeriod" },
    { "code": "REDUCED_ENTRY_EXIT_LOAD", "label": "REDUCED ENTRY/EXIT LOAD", "field": "reducedEntryExitLoad" },
    { "code": "BETTER_ALLOTMENT", "label": "BETTER ALLOTMENT PREFERENCE", "field": "betterAllotmentPreference" },
    { "code": "FLEXIBLE_PAYMENT_TERMS", "label": "FLEXIBLE PAYMENT TERMS", "field": "flexiblePaymentTerms" }
  ],
  "improvementNote": "According to investor feedback."
}$json$::jsonb)
on conflict (key) do update set value = excluded.value;

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
