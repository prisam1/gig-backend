-- Functions are never executable by the Data API's public roles.
--
-- Postgres gives EXECUTE on every new function to PUBLIC by default, and a schema-level
-- "alter default privileges ... in schema public" (20261027150000_security_hardening.sql) cannot
-- take that global default away. So functions added later (e.g. the learn and credit-ledger
-- triggers) were executable by anon. Remove the global default for objects postgres creates, then
-- close what already exists. The service role, the API's only key, keeps what it calls.

alter default privileges for role postgres revoke execute on functions from public;

revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
