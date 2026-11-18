-- The Representation section serves what the app shows. The app's screens are the specification:
--
-- 1. Signing window: a petition can be signed until its closing date, whatever step of the track
--    it is on (the app shows "Open for signature" and "closes in N days" next to tracks such as
--    "Under Review by GIG"). A petition GIG marks "Closing Soon" stays so until it closes.
-- 2. Signature counts: the app's counts are content. They are stored as a baseline, and every
--    valid signature adds to it, so 124 signatures plus one new one shows 125.
-- 3. Evidence: the app lists a spreadsheet next to the PDFs, so .xlsx documents are allowed.
-- 4. Year filter on the list (the app filters petitions by the year they opened).
-- 5. Content: the app's six petitions with their overview, track step, goal, counts, closing
--    dates (relative, so "closes in" counts down from today) and evidence documents. The files
--    themselves are uploaded by `npm run seed:representation-evidence`.

-- ---------------------------------------------------------------------------------------------
-- 1. Signing window
-- ---------------------------------------------------------------------------------------------

-- The status the app shows: signing-window statuses follow the dates, later ones are as stored.
-- An open petition shows as "Closing Soon" in its last 7 days, or earlier when GIG marks it so.
create or replace function app.representation_effective_status(p_status text, p_closes_at timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_status not in ('OPEN', 'CLOSING_SOON', 'CLOSED') then p_status
    when now() >= p_closes_at then 'CLOSED'
    when p_status = 'CLOSING_SOON' or p_closes_at - now() <= interval '7 days' then 'CLOSING_SOON'
    else 'OPEN'
  end;
$$;

create or replace view app.representation_cards as
select r.id as internal_id,
       r.public_id as id,
       r.slug,
       r.title,
       lower(r.title || ' ' || r.description || ' ' || array_to_string(r.tags, ' ')) as search_text,
       r.description,
       r.asks,
       r.why_it_matters,
       r.category,
       r.country,
       r.tags,
       r.regulators,
       r.goal,
       r.signature_count,
       r.vote_count,
       least(100, round(100.0 * r.signature_count / r.goal, 1))::float8 as progress_pct,
       r.opens_at,
       r.closes_at,
       greatest(0, ceil(extract(epoch from r.closes_at - now()) / 86400))::integer as days_left,
       app.representation_effective_status(r.track_status, r.closes_at) as track_status,
       (now() < r.closes_at) as is_open_for_signing,
       r.created_at
from app.representations r
where r.deleted_at is null and r.opens_at <= now();

-- A petition as staff see it: stored and effective track status, schedule and soft delete.
create or replace function app.admin_representation_json(r app.representations)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.public_id, 'slug', r.slug, 'title', r.title, 'description', r.description,
    'asks', to_jsonb(r.asks), 'whyItMatters', r.why_it_matters, 'category', r.category,
    'country', r.country, 'tags', to_jsonb(r.tags), 'regulators', to_jsonb(r.regulators),
    'goal', r.goal, 'signatureCount', r.signature_count, 'voteCount', r.vote_count,
    'progressPercent', least(100, round(100.0 * r.signature_count / r.goal, 1))::float8,
    'opensAt', r.opens_at, 'closesAt', r.closes_at, 'trackStatus', r.track_status,
    'effectiveStatus', app.representation_effective_status(r.track_status, r.closes_at),
    'isOpenForSigning', (now() >= r.opens_at and now() < r.closes_at),
    'createdAt', r.created_at, 'updatedAt', r.updated_at, 'deletedAt', r.deleted_at);
$$;

-- Saves the signature and its consents, and audits it, in one transaction. The petition row is
-- locked and re-checked, so a signature never lands after the window closed.
-- p_signature: { userId, representationId (public), signatureCode, displayMode, signerName,
-- investorType, signatureFileId, signerTier, consentTypes, consentVersion, idempotencyKey, requestHash }
-- Returns { ok } or { error: NOT_FOUND | CLOSED | FILE_INVALID }.
create or replace function public.app_representation_sign(p_signature jsonb, p_ctx jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id bigint := (p_signature ->> 'userId')::bigint;
  v_representation_id bigint;
  v_open boolean;
begin
  select id, (now() < closes_at)
  into v_representation_id, v_open
  from app.representations
  where public_id = (p_signature ->> 'representationId')::uuid and deleted_at is null and opens_at <= now()
  for share;
  if v_representation_id is null then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if not v_open then
    return jsonb_build_object('error', 'CLOSED');
  end if;

  if not exists (
    select 1 from app.files
    where id = (p_signature ->> 'signatureFileId')::bigint and owner_id = v_user_id
      and purpose = 'SIGNATURE' and scan_status <> 'INFECTED'
  ) then
    return jsonb_build_object('error', 'FILE_INVALID');
  end if;

  insert into app.representation_signatures (
    signature_code, representation_id, user_id, display_mode, signer_name, investor_type,
    signature_file_id, signer_tier, weight, consent_version, idempotency_key, request_hash
  ) values (
    p_signature ->> 'signatureCode', v_representation_id, v_user_id, p_signature ->> 'displayMode',
    p_signature ->> 'signerName', p_signature ->> 'investorType',
    (p_signature ->> 'signatureFileId')::bigint, p_signature ->> 'signerTier',
    case when p_signature ->> 'signerTier' = 'PRIVE' then 1 else 0 end,
    p_signature ->> 'consentVersion', p_signature ->> 'idempotencyKey', p_signature ->> 'requestHash'
  );

  insert into app.consents (user_id, type, version, accepted_at, ip, user_agent, app_version)
  select v_user_id, t, p_signature ->> 'consentVersion', now(), (p_ctx ->> 'ip')::inet,
         p_ctx ->> 'userAgent', p_ctx ->> 'appVersion'
  from jsonb_array_elements_text(p_signature -> 'consentTypes') t;

  perform app.write_audit(p_ctx, 'representation.signed', v_user_id, jsonb_build_object(
    'representation', p_signature ->> 'representationId', 'signature', p_signature ->> 'signatureCode'));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Signature counts: baseline plus valid signatures
-- ---------------------------------------------------------------------------------------------

alter table app.representations
  add column baseline_signature_count integer not null default 0
    check (baseline_signature_count >= 0);

comment on column app.representations.baseline_signature_count is
  'Signatures collected before the app (the count the app was launched with); valid signatures add to it.';

create or replace function app.representation_signatures_refresh_counts()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_representation_id bigint := coalesce(new.representation_id, old.representation_id);
begin
  update app.representations r
  set signature_count = r.baseline_signature_count + s.total,
      vote_count = s.votes
  from (
    select count(*)::integer as total, coalesce(sum(weight), 0)::integer as votes
    from app.representation_signatures
    where representation_id = v_representation_id and status = 'VALID' and deleted_at is null
  ) s
  where r.id = v_representation_id;
  return null;
end;
$$;

-- A changed baseline shows in the count straight away.
create or replace function app.representations_apply_baseline()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.signature_count := new.baseline_signature_count + coalesce((
    select count(*)::integer from app.representation_signatures
    where representation_id = new.id and status = 'VALID' and deleted_at is null), 0);
  return new;
end;
$$;

create trigger representations_apply_baseline
before insert or update of baseline_signature_count on app.representations
for each row execute function app.representations_apply_baseline();

-- ---------------------------------------------------------------------------------------------
-- 3. Spreadsheets as evidence
-- ---------------------------------------------------------------------------------------------

alter table app.representation_documents drop constraint representation_documents_mime_type_check;
alter table app.representation_documents add constraint representation_documents_mime_type_check
  check (mime_type in (
    'application/pdf', 'image/jpeg', 'image/png',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));

update storage.buckets
set allowed_mime_types = array[
  'application/pdf', 'image/jpeg', 'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
where id = 'representation-documents';

-- ---------------------------------------------------------------------------------------------
-- 4. Year filter on the list
-- ---------------------------------------------------------------------------------------------

drop function public.app_find_representations(text, text[], text[], boolean, text, integer, integer);

-- p_years: opened in one of these years; p_years_before: opened before this year. Either matches.
create function public.app_find_representations(
  p_q_pattern text, p_statuses text[], p_countries text[], p_open boolean, p_years integer[],
  p_years_before integer, p_sort text, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select app.representation_json(c) as item,
           row_number() over (order by
             -- Open petitions first, soonest deadline first.
             case when p_sort = 'closing_soon' then c.is_open_for_signing end desc,
             case when p_sort = 'closing_soon' then c.closes_at end asc,
             case when p_sort = 'recent' then c.opens_at end desc,
             case when p_sort = 'most_signed' then c.signature_count end desc,
             case when p_sort = 'progress' then c.progress_pct end desc,
             c.id) as rn
    from app.representation_cards c
    where (p_q_pattern is null or c.search_text like p_q_pattern)
      and (coalesce(cardinality(p_statuses), 0) = 0 or c.track_status = any (p_statuses))
      and (coalesce(cardinality(p_countries), 0) = 0 or c.country = any (p_countries))
      and (p_open is null or c.is_open_for_signing = p_open)
      and ((coalesce(cardinality(p_years), 0) = 0 and p_years_before is null)
           or extract(year from c.opens_at)::integer = any (coalesce(p_years, '{}'))
           or extract(year from c.opens_at)::integer < p_years_before)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Content
-- ---------------------------------------------------------------------------------------------

-- The petitions the app shows. Petitions 1 and 5, and 3 and 6, share a title in the app.
insert into app.representations (
  slug, title, description, asks, why_it_matters, category, country, tags, regulators, goal,
  baseline_signature_count, opens_at, closes_at, track_status
)
select p.slug, p.title, p.description,
       array['Mandatory pre-trade settlement cost disclosure',
             'Standardised format across all broker platforms',
             'Quarterly FCA audit of compliance'],
       'Since the 2023 T+1 shift, retail investors have faced inconsistent disclosure practices leading to unplanned cash drag of up to 1.8% annually.',
       p.category, 'IN', array['India'], array['SEBI'], p.goal, p.signatures,
       p.opens_at, now() + p.closes_in, p.track_status
from (values
  ('mandatory-t1-settlement-disclosure', 'Mandatory T+1 Settlement Disclosure',
   'Require brokers to provide plain-language disclosure of T+1 settlement risks before enabling margin trading for first-time retail participants.',
   'Market structure', 1000, 124, timestamptz '2024-05-10 00:00:00+00', interval '6 days', 'UNDER_REVIEW'),
  ('financial-disclosures-first-time-investors', 'Improve Financial Disclosures for First-Time Investors',
   'Require investment platforms to provide interactive educational',
   'Investor education', 1500, 218, timestamptz '2024-05-02 00:00:00+00', interval '9 days', 'CLOSING_SOON'),
  ('hidden-fee-transparency', 'Standardize Hidden Fee Transparency Across',
   'Mandate clear breakdowns of brokerage charges, taxes, and platform fees before every trade.',
   'Fees', 2000, 341, timestamptz '2024-04-11 00:00:00+00', interval '12 days', 'MEETING_REQUESTED'),
  ('retail-platform-security-standards', 'Strengthen Standards for Retail',
   'Require annual third-party security audits and mandatory breach notifications',
   'Cyber security', 2500, 497, timestamptz '2024-04-18 00:00:00+00', interval '5 days', 'SUBMITTED_TO_REGULATOR'),
  ('mandatory-t1-settlement-disclosure-2', 'Mandatory T+1 Settlement Disclosure',
   'Require annual third-party security audits and mandatory breach notifications',
   'Market structure', 2500, 497, timestamptz '2024-04-25 00:00:00+00', interval '5 days', 'MEETING_REQUESTED'),
  ('hidden-fee-transparency-2', 'Standardize Hidden Fee Transparency Across',
   'Require annual third-party security audits and mandatory breach notifications',
   'Fees', 2500, 497, timestamptz '2024-05-02 00:00:00+00', interval '5 days', 'MEETING_SCHEDULED')
) as p (slug, title, description, category, goal, signatures, opens_at, closes_in, track_status)
on conflict (slug) do update set
  title = excluded.title,
  description = excluded.description,
  asks = excluded.asks,
  why_it_matters = excluded.why_it_matters,
  category = excluded.category,
  country = excluded.country,
  tags = excluded.tags,
  regulators = excluded.regulators,
  goal = excluded.goal,
  baseline_signature_count = excluded.baseline_signature_count,
  opens_at = excluded.opens_at,
  closes_at = excluded.closes_at,
  track_status = excluded.track_status,
  deleted_at = null;

-- Earlier sample petitions the app does not show.
update app.representations
set deleted_at = now()
where slug in ('mandatory-breach-notifications', 'platform-fee-breakdown-standard')
  and deleted_at is null;

-- The Evidence tab's three documents, on every petition. Sizes are those of the files the seed
-- script uploads (1.2 MB, 340 KB and 2.8 MB, as the app shows).
insert into app.representation_documents (
  representation_id, document_type, title, object_key, mime_type, size_bytes, scan_status, sort_order
)
select r.id, 'EVIDENCE', d.title, 'evidence/' || r.slug || '/' || d.file_name, d.mime_type,
       d.size_bytes, 'CLEAN', d.sort_order
from app.representations r
cross join (values
  (1, 'Primary Research Brief.Pdf', 'primary-research-brief.pdf', 'application/pdf', 1258291),
  (2, 'Regulatory Comparison Table.Xlsx', 'regulatory-comparison-table.xlsx',
   'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 348160),
  (3, 'Investor Survey Data.Pdf', 'investor-survey-data.pdf', 'application/pdf', 2936013)
) as d (sort_order, title, file_name, mime_type, size_bytes)
where r.slug in (
  'mandatory-t1-settlement-disclosure', 'financial-disclosures-first-time-investors',
  'hidden-fee-transparency', 'retail-platform-security-standards',
  'mandatory-t1-settlement-disclosure-2', 'hidden-fee-transparency-2')
on conflict (object_key) do update set
  title = excluded.title,
  mime_type = excluded.mime_type,
  size_bytes = excluded.size_bytes,
  scan_status = excluded.scan_status,
  sort_order = excluded.sort_order;

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
