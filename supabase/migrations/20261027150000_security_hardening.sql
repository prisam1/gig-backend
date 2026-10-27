-- Security hardening: least privilege for the Supabase Data API roles.
--
-- The API reaches the public schema only with the service role (catalog and reviews) and the
-- app schema only through its own database connection. The publishable key's roles (anon,
-- authenticated) are never used, so they get no privileges at all. Row Level Security with no
-- policies already blocks them; removing the grants as well means one mistaken policy later
-- cannot expose a table.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- Objects created later by migrations (run as postgres) start with no access for these roles.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

-- The service role keeps what the catalog and reviews module calls.
grant execute on all functions in schema public to service_role;

-- Starting an OTP expires the older open codes for the same address and purpose.
create index otp_challenges_destination_idx
  on app.otp_challenges (destination_hash, purpose) where verified_at is null;
