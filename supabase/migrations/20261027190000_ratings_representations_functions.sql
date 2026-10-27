-- Ratings and Representations through the single supabase-js entry.
--
-- Same rules as 20261027160000_app_functions.sql: their tables stay in the private "app" schema,
-- hidden from the Supabase Data API, and the API reaches them only through these public.app_*
-- functions (security definer, fixed search_path, callable by the service role alone). Each
-- function backs one method of src/modules/ratings/ratings.repository.ts or
-- src/modules/representations/representations.repository.ts and returns the shape it promises.
-- Unique violations are left to raise (SQLSTATE 23505 with the index name in the message), so the
-- services can still tell a duplicate rating or signature from a reused Idempotency-Key.

-- ---------------------------------------------------------------------------------------------
-- JSON shapes
-- ---------------------------------------------------------------------------------------------

create or replace function app.issuer_json(c app.issuer_cards)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'slug', c.slug, 'name', c.name, 'instrument', c.instrument,
    'assetType', c.asset_type, 'exchange', c.exchange, 'isListed', c.is_listed,
    'openDate', c.open_date::text, 'closeDate', c.close_date::text,
    'minLot', c.min_lot, 'lotUnit', c.lot_unit, 'priceMin', c.price_min::float8,
    'priceMax', c.price_max::float8, 'offerSize', c.offer_size::float8, 'currency', c.currency,
    'useOfFunds', c.use_of_funds, 'lockIn', c.lock_in, 'prePostRatio', c.pre_post_ratio,
    'tags', to_jsonb(c.tags), 'ratingCount', c.rating_count,
    'averageScore', c.average_score::float8, 'createdAt', c.created_at);
$$;

create or replace function app.representation_json(c app.representation_cards)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'internalId', c.internal_id::text, 'id', c.id, 'slug', c.slug, 'title', c.title,
    'description', c.description, 'asks', to_jsonb(c.asks), 'whyItMatters', c.why_it_matters,
    'category', c.category, 'country', c.country, 'tags', to_jsonb(c.tags),
    'regulators', to_jsonb(c.regulators), 'goal', c.goal, 'signatureCount', c.signature_count,
    'voteCount', c.vote_count, 'progressPercent', c.progress_pct, 'opensAt', c.opens_at,
    'closesAt', c.closes_at, 'daysLeft', c.days_left, 'trackStatus', c.track_status,
    'isOpenForSigning', c.is_open_for_signing, 'createdAt', c.created_at);
$$;

-- Files the virus scan flagged are filtered out by the callers.
create or replace function app.representation_document_json(d app.representation_documents)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', d.public_id, 'title', d.title, 'documentType', d.document_type,
    'file', jsonb_build_object('bucket', d.bucket, 'objectKey', d.object_key,
                               'mimeType', d.mime_type, 'sizeBytes', d.size_bytes));
$$;

-- ---------------------------------------------------------------------------------------------
-- Ratings
-- ---------------------------------------------------------------------------------------------

-- Issuers list. p_q_pattern is a LIKE pattern built (and escaped) by the API.
create or replace function public.app_find_issuers(
  p_q_pattern text, p_asset_types text[], p_listed boolean, p_sort text, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select app.issuer_json(c) as item,
           row_number() over (order by
             case when p_sort = 'recent' then c.open_date end desc nulls last,
             case when p_sort = 'recent' then c.created_at end desc,
             case when p_sort = 'closing_soon' then c.close_date end asc nulls last,
             case when p_sort = 'top_rated' then c.average_score end desc,
             case when p_sort = 'top_rated' then c.rating_count end desc,
             case when p_sort = 'most_rated' then c.rating_count end desc,
             case when p_sort = 'most_rated' then c.average_score end desc,
             c.id) as rn
    from app.issuer_cards c
    where (p_q_pattern is null or c.search_text like p_q_pattern)
      and (coalesce(cardinality(p_asset_types), 0) = 0 or c.asset_type::text = any (p_asset_types))
      and (p_listed is null or c.is_listed = p_listed)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

create or replace function public.app_find_issuer(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.issuer_json(c) from app.issuer_cards c where c.id = p_id;
$$;

create or replace function public.app_issuer_stats(p_issuer_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ratingCount', rating_count, 'averageScore', average_score::float8,
    'weightedScore', weighted_score::float8, 'scoreDistribution', score_distribution,
    'factorBreakdown', factor_breakdown, 'riskCounts', risk_counts, 'lastRatingAt', last_rating_at)
  from app.issuer_stats where issuer_id = p_issuer_id;
$$;

-- Saves the rating with its factor flags and risks, and audits it, in one transaction.
-- p_rating: { userId, issuerId, overallScore, factors: [{ code, flag }], riskCodes, idempotencyKey, requestHash }
create or replace function public.app_rating_submit(p_rating jsonb, p_ctx jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
  v_public_id uuid;
  v_user_id bigint := (p_rating ->> 'userId')::bigint;
begin
  insert into app.issuer_ratings (issuer_id, user_id, overall_score, idempotency_key, request_hash)
  values ((p_rating ->> 'issuerId')::uuid, v_user_id, (p_rating ->> 'overallScore')::smallint,
          p_rating ->> 'idempotencyKey', p_rating ->> 'requestHash')
  returning id, public_id into v_id, v_public_id;

  insert into app.issuer_rating_factors (rating_id, factor_code, flag)
  select v_id, f ->> 'code', f ->> 'flag' from jsonb_array_elements(p_rating -> 'factors') f;
  insert into app.issuer_rating_risks (rating_id, risk_code)
  select v_id, r from jsonb_array_elements_text(p_rating -> 'riskCodes') r;

  perform app.write_audit(p_ctx, 'rating.submitted', v_user_id,
    jsonb_build_object('rating', v_public_id, 'issuer', p_rating ->> 'issuerId'));
  return v_public_id;
end $$;

create or replace function public.app_rating_by_idempotency_key(p_user_id bigint, p_idempotency_key text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('publicId', public_id, 'requestHash', request_hash)
  from app.issuer_ratings where user_id = p_user_id and idempotency_key = p_idempotency_key;
$$;

-- One of the user's own, not-deleted ratings, with its factors and risks.
create or replace function public.app_rating_own(p_user_id bigint, p_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'publicId', r.public_id, 'receiptNo', r.receipt_no, 'status', r.status,
    'overallScore', r.overall_score, 'moderationNote', r.moderation_note, 'createdAt', r.created_at,
    'issuer', jsonb_build_object('id', i.id, 'name', i.name),
    'factors', (select coalesce(jsonb_agg(jsonb_build_object('code', f.factor_code, 'flag', f.flag)), '[]'::jsonb)
                from app.issuer_rating_factors f where f.rating_id = r.id),
    'riskCodes', to_jsonb(array(select k.risk_code from app.issuer_rating_risks k
                                where k.rating_id = r.id order by k.created_at, k.risk_code)))
  from app.issuer_ratings r
  join public.issuers i on i.id = r.issuer_id
  where r.user_id = p_user_id and r.public_id = p_public_id and r.deleted_at is null;
$$;

create or replace function public.app_ratings_mine(
  p_user_id bigint, p_statuses text[], p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select jsonb_build_object(
             'publicId', r.public_id, 'receiptNo', r.receipt_no, 'status', r.status,
             'overallScore', r.overall_score, 'createdAt', r.created_at,
             'issuer', jsonb_build_object('id', i.id, 'name', i.name)) as item,
           row_number() over (order by r.created_at desc, r.id) as rn
    from app.issuer_ratings r
    join public.issuers i on i.id = r.issuer_id
    where r.user_id = p_user_id and r.deleted_at is null
      and (coalesce(cardinality(p_statuses), 0) = 0 or r.status = any (p_statuses))
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

-- ---------------------------------------------------------------------------------------------
-- Representations
-- ---------------------------------------------------------------------------------------------

create or replace function public.app_find_representations(
  p_q_pattern text, p_statuses text[], p_countries text[], p_open boolean, p_sort text,
  p_limit integer, p_offset integer
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
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

create or replace function public.app_find_representation(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.representation_json(c) from app.representation_cards c where c.id = p_id;
$$;

-- Most recent valid signers first. The API applies each signer's display choice to the name.
create or replace function public.app_representation_signers(p_representation_id bigint, p_limit integer)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.public_id, 'displayMode', s.display_mode, 'signerName', s.signer_name,
      'investorType', s.investor_type, 'investorTypeLabel', o.label, 'signerTier', s.signer_tier,
      'signedAt', s.created_at) order by s.created_at desc, s.id desc), '[]'::jsonb)
  from (
    select * from app.representation_signatures
    where representation_id = p_representation_id and status = 'VALID' and deleted_at is null
    order by created_at desc, id desc
    limit p_limit
  ) s
  left join app.lookup_options o on o.type = s.investor_type_kind and o.code = s.investor_type;
$$;

create or replace function public.app_representation_evidence(p_representation_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(app.representation_document_json(d) order by d.sort_order, d.id), '[]'::jsonb)
  from app.representation_documents d
  where d.representation_id = p_representation_id
    and d.document_type = 'EVIDENCE' and d.scan_status <> 'INFECTED';
$$;

-- Stored status changes, oldest first, with the documents attached to each.
create or replace function public.app_representation_history(p_representation_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'fromStatus', h.from_status, 'toStatus', h.to_status, 'note', h.note, 'occurredAt', h.occurred_at,
      'documents', (
        select coalesce(jsonb_agg(app.representation_document_json(d) order by d.sort_order, d.id), '[]'::jsonb)
        from app.representation_documents d
        where d.status_history_id = h.id and d.scan_status <> 'INFECTED'))
    order by h.occurred_at, h.id), '[]'::jsonb)
  from app.representation_status_history h
  where h.representation_id = p_representation_id;
$$;

create or replace function public.app_representation_submission_pack(p_representation_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.representation_document_json(d)
  from app.representation_documents d
  where d.representation_id = p_representation_id
    and d.document_type = 'SUBMISSION_PACK' and d.scan_status <> 'INFECTED'
  order by d.created_at desc, d.id desc
  limit 1;
$$;

-- The user's valid, not-deleted signature on this petition.
create or replace function public.app_representation_signature(p_user_id bigint, p_representation_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'publicId', public_id, 'signatureCode', signature_code, 'displayMode', display_mode,
    'signerName', signer_name, 'investorType', investor_type, 'signerTier', signer_tier,
    'createdAt', created_at)
  from app.representation_signatures
  where user_id = p_user_id and representation_id = p_representation_id
    and status = 'VALID' and deleted_at is null;
$$;

create or replace function public.app_signature_by_idempotency_key(p_user_id bigint, p_idempotency_key text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('representationId', r.public_id, 'requestHash', s.request_hash)
  from app.representation_signatures s
  join app.representations r on r.id = s.representation_id
  where s.user_id = p_user_id and s.idempotency_key = p_idempotency_key;
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
  select id, (now() < closes_at and track_status in ('OPEN', 'CLOSING_SOON'))
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
-- Who may call what
-- ---------------------------------------------------------------------------------------------

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
