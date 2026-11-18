-- The Representation tab's two figures: "Active Petitions" (petitions open for signing) and
-- "Total Signatures" (every petition's signature count, baselines included).
create or replace function public.app_representation_stats()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'activePetitions', count(*) filter (where c.is_open_for_signing),
    'totalSignatures', coalesce(sum(c.signature_count), 0))
  from app.representation_cards c;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
