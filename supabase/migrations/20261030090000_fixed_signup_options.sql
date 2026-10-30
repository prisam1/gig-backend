-- The sign-up choices are fixed lists in the app (src/constants/Investment.ts there) and the API
-- accepts exactly their codes (src/modules/users/onboarding.options.ts). GET /lookups no longer
-- serves them. app.lookup_options keeps the job profiles and preferences, because users reference
-- them and profiles show their labels; test/db/app_functions.db.test.ts keeps those rows identical
-- to the API's lists.

-- Tiers and phone country codes were only rows for GET /lookups (20261029090000). The API checks
-- both against fixed lists in the code, so the rows go.
delete from app.lookup_options where type in ('TIER', 'COUNTRY_CODE');

alter table app.lookup_options drop constraint lookup_options_type_check;
alter table app.lookup_options add constraint lookup_options_type_check check (type in (
  'JOB_PROFILE', 'INVESTMENT_FOCUS', 'RISK_LEVEL', 'INVESTMENT_STYLE', 'INVESTMENT_SECTOR',
  'RATING_FACTOR', 'RISK_FACTOR', 'INVESTOR_TYPE'
));

alter table app.lookup_options drop constraint lookup_options_code_check;
alter table app.lookup_options add constraint lookup_options_code_check check (code ~ '^[A-Z0-9_]{1,64}$');

-- The app's sector list has "Private Equities" after "Shipping & Maritime" as well as "Private
-- Equity"; the first seed left it out, so choosing it would have been refused.
update app.lookup_options
   set sort_order = sort_order + 1
 where type = 'INVESTMENT_SECTOR'
   and sort_order > (select sort_order from app.lookup_options where type = 'INVESTMENT_SECTOR' and code = 'SHIPPING_AND_MARITIME');

insert into app.lookup_options (type, code, label, sort_order)
select 'INVESTMENT_SECTOR', 'PRIVATE_EQUITIES', 'Private Equities', sort_order + 1
  from app.lookup_options
 where type = 'INVESTMENT_SECTOR' and code = 'SHIPPING_AND_MARITIME'
on conflict (type, code) do nothing;
