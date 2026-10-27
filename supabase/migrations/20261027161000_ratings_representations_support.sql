-- Ratings and Representations (Phase 1): what the two domains add to the shared tables.
--   * option lists: the rating wizard's 10 rating factors and 12 risk factors, and the 30
--     investor types of the signing flow
--   * files: petition signatures are uploaded files (purpose SIGNATURE, bucket "signatures")
--   * consents: the two declarations accepted when signing a petition
--   * storage: the signatures bucket and the bucket for generated signature receipts

alter table app.lookup_options drop constraint lookup_options_type_check;
alter table app.lookup_options add constraint lookup_options_type_check check (type in (
  'JOB_PROFILE', 'INVESTMENT_FOCUS', 'RISK_LEVEL', 'INVESTMENT_STYLE', 'INVESTMENT_SECTOR',
  'RATING_FACTOR', 'RISK_FACTOR', 'INVESTOR_TYPE'
));

alter table app.files drop constraint files_purpose_check;
alter table app.files add constraint files_purpose_check
  check (purpose in ('AVATAR', 'KYC_DOCUMENT', 'REVIEW_EVIDENCE', 'SIGNATURE'));
alter table app.files drop constraint files_bucket_check;
alter table app.files add constraint files_bucket_check
  check (bucket in ('avatars', 'kyc-documents', 'review-evidence', 'signatures'));

alter table app.consents drop constraint consents_type_check;
alter table app.consents add constraint consents_type_check check (type in (
  'AGE_18_PLUS', 'KYC', 'PETITION_SUBMISSION_SUPPORT', 'PETITION_DIGITAL_ENDORSEMENT'
));

-- Signatures are private; receipts are PDFs the API generates (one per signature, under 1 MB).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('signatures', 'signatures', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png']),
  ('signature-receipts', 'signature-receipts', false, 1048576, array['application/pdf'])
on conflict (id) do nothing;

-- Option lists from the mobile app's rating wizard and signing flow.
insert into app.lookup_options (type, code, label, sort_order) values
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
  ('RISK_FACTOR', 'ECONOMIC',   'Economic',   12),
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
