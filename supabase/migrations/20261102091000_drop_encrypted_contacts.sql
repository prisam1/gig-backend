-- Second step of 20261102090000: email and phone are now required, and the encrypted copies and
-- the lookup hashes are dropped.
--
-- Refuses to run while any account still lacks its plain values: on a database that already had
-- accounts, scripts/backfill-contacts.mjs must have been run between the two migrations.
do $$
begin
  if exists (select 1 from app.users where email is null or phone is null) then
    raise exception 'Some accounts have no plain email/phone yet. In gig-backend run "node scripts/backfill-contacts.mjs", then run the migrations again.';
  end if;
end $$;

-- Sign-ups and codes started before the change have no plain values and cannot be completed; they
-- would have expired within the hour anyway.
delete from app.signup_requests where email is null or phone is null;
delete from app.otp_challenges where destination is null;

alter table app.users
  alter column email set not null,
  alter column phone set not null,
  drop column email_enc,
  drop column email_hash,
  drop column phone_enc,
  drop column phone_hash;

alter table app.signup_requests
  alter column email set not null,
  alter column phone set not null,
  drop column email_enc,
  drop column email_hash,
  drop column phone_enc,
  drop column phone_hash;

alter table app.otp_challenges
  alter column destination set not null,
  drop column destination_hash;
