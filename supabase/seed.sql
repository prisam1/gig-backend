-- Development seed: the issuers and other content from the mobile app's mock data (src/data.ts).
-- The Review section's companies, figures, trends and reviews are not here: they are content the
-- app shows and live in migration 20261118090000_review_section_content.sql.

-- Issuers: the app's 8 issuers are content, added by migration
-- 20261118160000_rating_section_content.sql.

-- Representations: the app's petitions are content, added by the migration
-- 20261118120000_representation_section_content.sql.

-- FX rates (units per 1 USD) until the FX feed runs.
insert into public.fx_rates (currency, per_usd) values
  ('USD', 1), ('INR', 83.2), ('EUR', 0.92), ('GBP', 0.79), ('AED', 3.6725)
on conflict (currency) do nothing;

-- Sample roadshows. Closing dates are relative so the pools stay open on fresh environments.
insert into public.roadshows (
  slug, issuer_id, title, summary, type_of_issue, instruments, no_of_instruments, offer_price,
  currency, lock_in, maturity, convertibility, callable, coupon_rate, risk_factors,
  opens_at, closes_at, pool_enabled, status, published_at
)
select r.slug, i.id, r.title, r.summary, r.type_of_issue, r.instruments, r.no_of_instruments,
       r.offer_price, r.currency::public.currency_code, r.lock_in, r.maturity, r.convertibility,
       r.callable, r.coupon_rate, r.risk_factors, now() - interval '7 days',
       now() + r.open_for, r.pool_enabled, 'PUBLISHED', now() - interval '7 days'
from (values
  ('meridian-green-bonds-2026', 'meridian-renewable-energy', 'Meridian Green Bonds 2026',
   'Secured green bonds funding 400 MW of solar capacity.', 'Public Issue', 'Green Bonds',
   2000000::bigint, 1000.00, 'INR', '12 months', '5 years', 'Non-convertible', true, 8.75,
   array['Project execution delays', 'Tariff renegotiation risk', 'Interest rate risk'],
   interval '30 days', true),
  ('quantum-biotech-pre-ipo', 'quantum-biotech-limited', 'Quantum Biotech Pre-IPO Round',
   'Pre-IPO placement ahead of a mainboard listing.', 'Private Placement', 'Equity Shares',
   500000::bigint, 415.00, 'INR', '6 months', null, null, false, null,
   array['Regulatory approval risk', 'Clinical trial outcomes', 'Listing delay'],
   interval '45 days', true)
) as r (slug, issuer_slug, title, summary, type_of_issue, instruments, no_of_instruments,
        offer_price, currency, lock_in, maturity, convertibility, callable, coupon_rate,
        risk_factors, open_for, pool_enabled)
join public.issuers i on i.slug = r.issuer_slug
on conflict (slug) do nothing;

-- Amounts in INR.
insert into public.roadshow_financials (
  roadshow_id, fiscal_year, revenue, ebitda, net_profit, total_assets, total_liabilities,
  net_worth, total_debt, cash_and_equivalents, operating_cash_flow, eps
)
select r.id, f.fiscal_year, f.revenue, f.ebitda, f.net_profit, f.total_assets,
       f.total_liabilities, f.net_worth, f.total_debt, f.cash, f.ocf, f.eps
from public.roadshows r
join (values
  ('meridian-green-bonds-2026', 2024, 18500000000, 7400000000, 2100000000, 96000000000, 61000000000, 35000000000, 52000000000, 4200000000, 6900000000, 12.4),
  ('meridian-green-bonds-2026', 2025, 21300000000, 8900000000, 2600000000, 104000000000, 66000000000, 38000000000, 55000000000, 4800000000, 8100000000, 15.1),
  ('meridian-green-bonds-2026', 2026, 24800000000, 10500000000, 3300000000, 115000000000, 71000000000, 44000000000, 58000000000, 5600000000, 9400000000, 19.2)
) as f (slug, fiscal_year, revenue, ebitda, net_profit, total_assets, total_liabilities,
        net_worth, total_debt, cash, ocf, eps) on f.slug = r.slug
on conflict do nothing;

insert into public.roadshow_documents (roadshow_id, title, doc_type, storage_path, sort_order)
select r.id, d.title, d.doc_type, r.slug || '/' || d.file_name, d.sort_order
from public.roadshows r
join (values
  ('meridian-green-bonds-2026', 'Offer document', 'PROSPECTUS', 'offer-document.pdf', 1),
  ('meridian-green-bonds-2026', 'Audited financials FY2026', 'FINANCIAL_STATEMENT', 'financials-fy2026.pdf', 2)
) as d (slug, title, doc_type, file_name, sort_order) on d.slug = r.slug
on conflict (storage_path) do nothing;

-- Sample learn content and a webinar.
insert into public.learn_items (
  title, summary, format, category, access, content_url, duration_seconds, download_path,
  status, published_at
)
select v.title, v.summary, v.format::public.learn_format, v.category,
       v.access::public.content_access, v.content_url, v.duration_seconds, v.download_path,
       'PUBLISHED', now() - v.age
from (values
  ('Reading an offer document', 'What to check before you invest in a public issue.', 'VIDEO',
   'Basics', 'FREE', 'https://example.com/learn/offer-document', 540, null::text, interval '20 days'),
  ('Green bonds explained', 'How green bonds work and how to judge their risk.', 'ARTICLE',
   'Debt', 'FREE', 'https://example.com/learn/green-bonds', null::integer, null, interval '10 days'),
  ('Mutual fund house scorecard 2026', 'GIG investor-voice report on fund houses.', 'REPORT',
   'Research', 'PREMIUM', null, null, 'reports/fund-house-scorecard-2026.pdf', interval '3 days')
) as v (title, summary, format, category, access, content_url, duration_seconds, download_path, age)
where not exists (select 1 from public.learn_items);

insert into public.webinars (
  title, description, host_name, starts_at, ends_at, access, join_url, status
)
select 'Investor rights in public issues', 'Live Q&A with the GIG research team.', 'GIG Research',
       now() + interval '14 days', now() + interval '14 days 1 hour', 'FREE',
       'https://example.com/webinars/investor-rights',
       'PUBLISHED'
where not exists (select 1 from public.webinars);
