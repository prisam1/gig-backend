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
