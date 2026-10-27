-- Petition signatures are uploaded files (PDF or image), and each signature gets a receipt PDF.
-- The new enum value is added in its own migration because Postgres cannot use an enum value in
-- the same transaction that adds it.

alter type file_purpose add value if not exists 'SIGNATURE';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('signatures',         'signatures',         false, 10485760, array['application/pdf', 'image/jpeg', 'image/png']),
  ('signature-receipts', 'signature-receipts', false, 1048576,  array['application/pdf'])
on conflict (id) do nothing;
