-- Sample lookup options for local and staging environments.
-- Replace with the full lists from the mobile app (src/constants/*) before UAT.

insert into lookup_options (type, code, label, sort_order) values
  ('JOB_PROFILE', 'SOFTWARE_ENGINEER',  'Software Engineer',  1),
  ('JOB_PROFILE', 'CHARTERED_ACCOUNTANT', 'Chartered Accountant', 2),
  ('JOB_PROFILE', 'BUSINESS_OWNER',     'Business Owner',     3),
  ('FOCUS',       'WEALTH_CREATION',    'Wealth Creation',    1),
  ('FOCUS',       'RETIREMENT',         'Retirement',         2),
  ('RISK',        'LOW',                'Low',                1),
  ('RISK',        'MODERATE',           'Moderate',           2),
  ('RISK',        'HIGH',               'High',               3),
  ('STYLE',       'VALUE',              'Value',              1),
  ('STYLE',       'GROWTH',             'Growth',             2),
  ('STYLE',       'DIVIDEND',           'Dividend',           3),
  ('STYLE',       'MOMENTUM',           'Momentum',           4),
  ('SECTOR',      'BANKING',            'Banking',            1),
  ('SECTOR',      'TECHNOLOGY',         'Technology',         2),
  ('SECTOR',      'HEALTHCARE',         'Healthcare',         3),
  ('SECTOR',      'ENERGY',             'Energy',             4),
  ('ASSET_CLASS', 'MF',                 'Mutual Funds',       1),
  ('ASSET_CLASS', 'EQUITY',             'Equity',             2)
on conflict (type, code) do nothing;

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
