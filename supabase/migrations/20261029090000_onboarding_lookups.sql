-- Every choice in the sign-up flow comes from the backend: GET /lookups/{type}.
-- Already stored: job profiles (step 2) and investment focus, risk level, style and sector (step 3).
-- Added here, from the app's screens:
--   TIER          the "Choose investor type" screen (src/screens/Investor/Investor.tsx)
--   COUNTRY_CODE  the phone country code in step 1 (the markets POST /auth/register accepts)
-- The API validates both against fixed lists in the code (TIERS in src/lib/membership.ts,
-- COUNTRY_CODES in src/modules/auth/auth.schemas.ts); test/db/app_functions.db.test.ts keeps
-- these rows identical to them.

alter table app.lookup_options drop constraint lookup_options_type_check;
alter table app.lookup_options add constraint lookup_options_type_check check (type in (
  'JOB_PROFILE', 'INVESTMENT_FOCUS', 'RISK_LEVEL', 'INVESTMENT_STYLE', 'INVESTMENT_SECTOR',
  'RATING_FACTOR', 'RISK_FACTOR', 'INVESTOR_TYPE', 'TIER', 'COUNTRY_CODE'
));

-- Codes stay UPPER_SNAKE_CASE, except dialling codes, which are sent as they are (+91).
alter table app.lookup_options drop constraint lookup_options_code_check;
alter table app.lookup_options add constraint lookup_options_code_check check (
  case when type = 'COUNTRY_CODE' then code ~ '^\+[1-9][0-9]{0,3}$' else code ~ '^[A-Z0-9_]{1,64}$' end
);

insert into app.lookup_options (type, code, label, sort_order) values
  ('TIER',         'OBSERVER',      'Observer',      1),
  ('TIER',         'PRIVE',         'Prive',         2),
  ('TIER',         'INSTITUTIONAL', 'Institutional', 3),
  ('COUNTRY_CODE', '+91',           'India',         1),
  ('COUNTRY_CODE', '+971',          'UAE',           2)
on conflict (type, code) do nothing;
