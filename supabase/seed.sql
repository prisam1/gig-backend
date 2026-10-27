-- Development seed: the companies and issuers from the mobile app's mock data (src/data.ts).

insert into public.companies (slug, name, asset_class, country, description, verified) values
  ('astra-mutuals', 'Astra Mutuals', 'MF', 'IN', 'Mutual fund house offering equity and index schemes.', true),
  ('zenith-capital', 'Zenith Capital', 'EQ', 'AE', 'Equity and IPO investment platform.', true),
  ('nexa-funds', 'Nexa Funds', 'MF', 'IN', 'Mutual fund and SIP provider.', true),
  ('summit-banking', 'Summit Banking', 'BRK', 'IN', 'Broking and trading platform.', false),
  ('prime-fincorp', 'Prime Fincorp', 'BND', 'AE', 'Corporate bonds and sukuk issuer.', false)
on conflict (slug) do nothing;

insert into public.company_tags (company_id, tag, sort_order)
select c.id, t.tag, t.sort_order
from public.companies c
join (values
  ('astra-mutuals', 'Large CAP Stocks', 1), ('astra-mutuals', 'ETF', 2), ('astra-mutuals', 'IPO', 3),
  ('zenith-capital', 'ETF', 1), ('zenith-capital', 'IPO', 2),
  ('nexa-funds', 'ETF', 1), ('nexa-funds', 'Large CAP Stocks', 2), ('nexa-funds', 'IPO', 3),
  ('summit-banking', 'Safe', 1), ('summit-banking', 'Liquid', 2), ('summit-banking', 'IPO', 3),
  ('prime-fincorp', 'Corporate Bonds', 1), ('prime-fincorp', 'High Yield', 2), ('prime-fincorp', 'IPO', 3)
) as t (slug, tag, sort_order) on t.slug = c.slug
on conflict do nothing;

-- Amounts in INR; offer sizes converted from crore (1 cr = 10,000,000).
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
   '2024-05-10', '2024-05-14', true, 150, 'shares', 300, 315, 18000000000, 'Asset Acq', '120 days', '90%/81%')
on conflict (slug) do nothing;

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
