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

-- Ratings: the 10 rating factors and 12 risk factors of the app's rating wizard.
insert into lookup_options (type, code, label, sort_order) values
  ('RATING_FACTOR', 'GENERAL',                 'General',                            1),
  ('RATING_FACTOR', 'BUSINESS_OF_COMPANY',     'Business of the company',            2),
  ('RATING_FACTOR', 'INDUSTRY',                'Industry in which company operates', 3),
  ('RATING_FACTOR', 'PROMOTERS',               'Promoters',                          4),
  ('RATING_FACTOR', 'ISSUE_TERMS',             'The issue terms',                    5),
  ('RATING_FACTOR', 'OBJECTS_OF_ISSUE',        'Objects of the issue',               6),
  ('RATING_FACTOR', 'FINANCIAL_HEALTH',        'Financial health',                   7),
  ('RATING_FACTOR', 'TOP_10_SHAREHOLDERS',     'Top 10 shareholders',                8),
  ('RATING_FACTOR', 'OUTSTANDING_LITIGATIONS', 'Outstanding litigations',            9),
  ('RATING_FACTOR', 'CONTINGENT_LIABILITIES',  'Contingent liabilities',            10),
  ('RISK_FACTOR', 'CREDIT',     'Credit',      1),
  ('RISK_FACTOR', 'MARKET',     'Market',      2),
  ('RISK_FACTOR', 'LIQUIDITY',  'Liquidity',   3),
  ('RISK_FACTOR', 'LEGAL',      'Legal',       4),
  ('RISK_FACTOR', 'FRAUD',      'Fraud',       5),
  ('RISK_FACTOR', 'REGULATORY', 'Regulatory',  6),
  ('RISK_FACTOR', 'INFLATION',  'Inflation',   7),
  ('RISK_FACTOR', 'CURRENCY',   'Currency',    8),
  ('RISK_FACTOR', 'CYBER',      'Cyber',       9),
  ('RISK_FACTOR', 'DEFAULT',    'Default',    10),
  ('RISK_FACTOR', 'STRATEGIC',  'Strategic',  11),
  ('RISK_FACTOR', 'ECONOMIC',   'Economic',   12)
on conflict (type, code) do nothing;

-- Representations: the 30 investor types of the app's signing flow.
insert into lookup_options (type, code, label, sort_order) values
  ('INVESTOR_TYPE', 'RETAIL_BEGINNER',           'Retail Investor (Beginner Investors)',                 1),
  ('INVESTOR_TYPE', 'RETAIL_EXPERIENCED',        'Retail Investor (Experienced Investors)',              2),
  ('INVESTOR_TYPE', 'RETAIL_HNI',                'Retail Investor (High-Net-Worth Individuals) (HNIs)',  3),
  ('INVESTOR_TYPE', 'VC',                        'Venture Capital (VC) Investor',                        4),
  ('INVESTOR_TYPE', 'VC_SEED',                   'VC Investor (Seed Stage)',                             5),
  ('INVESTOR_TYPE', 'VC_SERIES',                 'VC Investor (Series A/B/C Investor)',                  6),
  ('INVESTOR_TYPE', 'VC_GROWTH',                 'VC Investor (Growth Investors)',                       7),
  ('INVESTOR_TYPE', 'INSTITUTIONAL_PENSION',     'Institutional Investor (Pension Funds)',               8),
  ('INVESTOR_TYPE', 'INSTITUTIONAL_INSURANCE',   'Institutional Investor (Insurance Companies)',         9),
  ('INVESTOR_TYPE', 'INSTITUTIONAL_MUTUAL_FUND', 'Institutional Investor (Mutual Funds)',               10),
  ('INVESTOR_TYPE', 'PRIVATE_EQUITY',            'Private Equity Investor',                             11),
  ('INVESTOR_TYPE', 'CORPORATE_STRATEGIC',       'Corporate Investor (Strategic partnerships)',         12),
  ('INVESTOR_TYPE', 'CORPORATE_INNOVATION',      'Corporate Investor (Innovation-focused investments)', 13),
  ('INVESTOR_TYPE', 'IMPACT_ESG',                'Impact Investor (ESG-focused)',                       14),
  ('INVESTOR_TYPE', 'IMPACT_SUSTAINABILITY',     'Impact Investor (Sustainability-focused)',            15),
  ('INVESTOR_TYPE', 'REAL_ESTATE_RESIDENTIAL',   'Real Estate Investor (Residential)',                  16),
  ('INVESTOR_TYPE', 'REAL_ESTATE_COMMERCIAL',    'Real Estate Investor (Commercial)',                   17),
  ('INVESTOR_TYPE', 'REAL_ESTATE_REIT',          'Real Estate Investor (REIT Investors)',               18),
  ('INVESTOR_TYPE', 'DEBT_BONDS',                'Debt Investor (Bond Investors)',                      19),
  ('INVESTOR_TYPE', 'DEBT_PRIVATE_CREDIT',       'Debt Investor (Private Credit Funds)',                20),
  ('INVESTOR_TYPE', 'ACCREDITED',                'Accredited Investor',                                 21),
  ('INVESTOR_TYPE', 'STARTUP',                   'Startup Investor',                                    22),
  ('INVESTOR_TYPE', 'VALUE',                     'Value Investor',                                      23),
  ('INVESTOR_TYPE', 'GROWTH',                    'Growth Investor',                                     24),
  ('INVESTOR_TYPE', 'MOMENTUM',                  'Momentum Investor',                                   25),
  ('INVESTOR_TYPE', 'SECTOR_SPECIALIST',         'Sector Specialist',                                   26),
  ('INVESTOR_TYPE', 'CONSERVATIVE',              'Conservative Investor',                               27),
  ('INVESTOR_TYPE', 'HIGH_RISK',                 'High-Risk Investor',                                  28),
  ('INVESTOR_TYPE', 'GLOBAL',                    'Global Investor',                                     29),
  ('INVESTOR_TYPE', 'DATA_DRIVEN',               'Data-Driven Investor',                                30)
on conflict (type, code) do nothing;

-- Representations from the app's mock data. The first two are open for signing; the others have
-- moved on to later track statuses, so their signing windows are over.
insert into public.representations (
  slug, title, description, asks, why_it_matters, category, country, tags, regulators, goal,
  opens_at, closes_at, track_status
) values
  ('mandatory-t1-settlement-disclosure',
   'Mandatory T+1 Settlement Disclosure',
   'Require brokers to provide plain-language disclosure of T+1 settlement risks before enabling margin trading for first-time retail participants.',
   array['Mandatory pre-trade settlement cost disclosure',
         'Standardised format across all broker platforms',
         'Quarterly audit of compliance'],
   'First-time retail investors are enabled for margin trading without a clear explanation of settlement risk. A standard disclosure protects them before losses happen.',
   'Market structure', 'IN', array['India', 'Brokers'], array['SEBI'], 1000,
   now() - interval '24 days', now() + interval '6 days', 'OPEN'),
  ('financial-disclosures-first-time-investors',
   'Improve Financial Disclosures for First-Time Investors',
   'Require investment platforms to provide interactive educational disclosures before a first investment.',
   array['Interactive risk explainer before the first investment',
         'Plain-language summary of product costs'],
   'First-time investors decide on incomplete information; better disclosures reduce mis-selling.',
   'Investor education', 'IN', array['India', 'Platforms'], array['SEBI'], 1500,
   now() - interval '21 days', now() + interval '9 days', 'OPEN'),
  ('hidden-fee-transparency',
   'Standardize Hidden Fee Transparency Across Platforms',
   'Mandate clear breakdowns of brokerage charges, taxes, and platform fees before every trade.',
   array['Itemised fee breakdown before every trade', 'One fee format across platforms'],
   'Fees hidden in fine print erode returns for retail investors.',
   'Fees', 'IN', array['India', 'Fees'], array['SEBI'], 2000,
   now() - interval '60 days', now() - interval '10 days', 'MEETING_REQUESTED'),
  ('retail-platform-security-standards',
   'Strengthen Security Standards for Retail Platforms',
   'Require annual third-party security audits and mandatory breach notifications.',
   array['Annual third-party security audit', 'Breach notification within 72 hours'],
   'Retail platforms hold sensitive personal and financial data.',
   'Cyber security', 'IN', array['India', 'Security'], array['SEBI', 'CERT-In'], 2500,
   now() - interval '75 days', now() - interval '20 days', 'SUBMITTED_TO_REGULATOR'),
  ('mandatory-breach-notifications',
   'Mandatory Breach Notifications for Investment Apps',
   'Require investment apps to notify affected investors of data breaches promptly.',
   array['Notify affected investors within 72 hours'],
   'Investors cannot protect themselves from breaches they are not told about.',
   'Cyber security', 'AE', array['UAE', 'Security'], array['SCA'], 2500,
   now() - interval '90 days', now() - interval '30 days', 'MEETING_SCHEDULED'),
  ('platform-fee-breakdown-standard',
   'Platform Fee Breakdown Standard',
   'Require annual statements to show every platform fee charged during the year.',
   array['Annual statement listing every fee charged'],
   'An annual view of fees makes the total cost of investing visible.',
   'Fees', 'IN', array['India', 'Fees'], array['SEBI'], 2500,
   now() - interval '120 days', now() - interval '60 days', 'RESOLVED')
on conflict (slug) do nothing;
