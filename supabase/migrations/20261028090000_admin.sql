-- Admin (Phase 1, extended in Phase 2): staff roles, user management, KYC decisions, the
-- moderation queue, petition tracking, credit grants, roadshow answers and the audit trail.
--
-- Staff are ordinary app.users accounts holding one or more roles (ADMIN, MODERATOR, ANALYST,
-- SUPPORT). The API decides which role may call what; these functions do the work. Each one is a
-- single transaction that checks the current state, writes the change, notifies the member it
-- concerns and appends its audit entry, so a decision is never half-applied. Expected failures
-- come back as { "error": CODE } like the other app_* functions.
--
-- Staff never act on their own account, content, KYC or credits (SELF_ACTION).

-- Inbox categories for what staff decide. Only used by plpgsql bodies, which resolve the values
-- when they run, so adding them in this migration is safe.
alter type public.notification_type add value if not exists 'KYC';
alter type public.notification_type add value if not exists 'RATING';
alter type public.notification_type add value if not exists 'REPRESENTATION';

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table app.user_roles (
  user_id bigint not null references app.users (id) on delete cascade,
  role text not null check (role in ('ADMIN', 'MODERATOR', 'ANALYST', 'SUPPORT')),
  granted_by bigint references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- Idempotency for staff writes that move value (credit grants): the first result per actor and
-- key is stored and replayed for retries with the same request.
create table app.admin_requests (
  actor_id bigint not null references app.users (id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 128),
  action text not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint admin_requests_pkey primary key (actor_id, idempotency_key)
);

alter table app.user_roles enable row level security;
alter table app.admin_requests enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Internal helpers (app schema, not callable through the API)
-- ---------------------------------------------------------------------------------------------

-- The member as staff screens show them: { id, name, tier, kycStatus, status }; null if unknown.
create or replace function app.user_ref(p_user_id bigint)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', u.public_id, 'name', coalesce(p.name, ''), 'tier', u.tier,
    'kycStatus', u.kyc_status, 'status', u.status)
  from app.users u
  left join app.user_profiles p on p.user_id = u.id
  where u.id = p_user_id;
$$;

create or replace function app.user_ref_public(p_public_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select app.user_ref(u.id) from app.users u where u.public_id = p_public_id;
$$;

create or replace function app.notify(
  p_user_public_id uuid, p_type text, p_title text, p_body text, p_data jsonb
) returns void language plpgsql set search_path = '' as $$
begin
  insert into public.notifications (user_id, type, title, body, data)
  values (p_user_public_id, p_type::public.notification_type, left(p_title, 120), left(p_body, 1000),
    coalesce(p_data, '{}'::jsonb));
end $$;

-- Which moderation decisions apply to an item in its current status.
--   REVIEW, RATING: APPROVE / REJECT a pending item (or one sent back for changes),
--                   REQUEST_CHANGES on a pending one, REMOVE a published one (takedown).
--   QUESTION:       APPROVE / REJECT a pending one, REMOVE a published one.
--   OFFER:          APPROVE / REJECT one waiting for review, REMOVE a published one.
create or replace function app.moderation_allowed(p_type text, p_from text, p_decision text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(case
    when p_type in ('REVIEW', 'RATING') then case p_decision
      when 'APPROVE' then p_from in ('PENDING_MODERATION', 'CHANGES_REQUESTED')
      when 'REJECT' then p_from in ('PENDING_MODERATION', 'CHANGES_REQUESTED')
      when 'REQUEST_CHANGES' then p_from = 'PENDING_MODERATION'
      when 'REMOVE' then p_from = 'PUBLISHED'
    end
    when p_type = 'QUESTION' then case p_decision
      when 'APPROVE' then p_from = 'PENDING_MODERATION'
      when 'REJECT' then p_from = 'PENDING_MODERATION'
      when 'REMOVE' then p_from = 'PUBLISHED'
    end
    when p_type = 'OFFER' then case p_decision
      when 'APPROVE' then p_from = 'PENDING_REVIEW'
      when 'REJECT' then p_from = 'PENDING_REVIEW'
      when 'REMOVE' then p_from = 'PUBLISHED'
    end
  end, false);
$$;

-- One moderation item with everything a moderator needs to decide; null if it does not exist.
create or replace function app.moderation_item(p_type text, p_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
begin
  if p_type = 'REVIEW' then
    return (
      select jsonb_build_object(
        'type', 'REVIEW', 'id', r.id, 'status', r.status, 'note', r.moderation_note,
        'createdAt', r.created_at, 'author', app.user_ref_public(r.user_id),
        'subject', jsonb_build_object('type', 'COMPANY', 'id', c.id, 'name', c.name),
        'content', jsonb_build_object(
          'receiptNo', r.receipt_no, 'country', r.country, 'assetClass', r.asset_class,
          'productScheme', r.product_scheme, 'investmentYear', r.investment_year,
          'investmentStatus', r.investment_status, 'sentiment', r.sentiment,
          'detailedReview', r.detailed_review, 'mixedReview', r.mixed_review,
          'negativeDescription', r.negative_description, 'reinvestStatus', r.reinvest_status,
          'metrics', jsonb_build_object(
            'transparency', r.m_transparency, 'responsiveness', r.m_responsiveness,
            'easeOfProcess', r.m_ease_of_process, 'trustworthiness', r.m_trustworthiness,
            'overallSatisfaction', r.m_overall_satisfaction),
          'resolutionStatus', r.resolution_status, 'followUpNote', r.follow_up_note,
          'displayMode', r.display_mode, 'authorName', r.author_name, 'allowContact', r.allow_contact,
          'tags', (
            select coalesce(jsonb_agg(jsonb_build_object('type', t.tag_type, 'code', t.code)
              order by t.tag_type, t.code), '[]'::jsonb)
            from public.review_tags t where t.review_id = r.id),
          'evidence', (
            select coalesce(jsonb_agg(jsonb_build_object('path', a.storage_path, 'docType', a.doc_type)
              order by a.created_at, a.storage_path), '[]'::jsonb)
            from public.review_attachments a where a.review_id = r.id)))
      from public.reviews r
      join public.companies c on c.id = r.company_id
      where r.id = p_id and r.deleted_at is null);
  elsif p_type = 'RATING' then
    return (
      select jsonb_build_object(
        'type', 'RATING', 'id', r.public_id, 'status', r.status, 'note', r.moderation_note,
        'createdAt', r.created_at, 'author', app.user_ref(r.user_id),
        'subject', jsonb_build_object('type', 'ISSUER', 'id', i.id, 'name', i.name),
        'content', jsonb_build_object(
          'receiptNo', r.receipt_no, 'overallScore', r.overall_score,
          'factors', (
            select coalesce(jsonb_agg(jsonb_build_object('code', f.factor_code, 'flag', f.flag)
              order by f.factor_code), '[]'::jsonb)
            from app.issuer_rating_factors f where f.rating_id = r.id),
          'riskCodes', (
            select coalesce(jsonb_agg(k.risk_code order by k.risk_code), '[]'::jsonb)
            from app.issuer_rating_risks k where k.rating_id = r.id)))
      from app.issuer_ratings r
      join public.issuers i on i.id = r.issuer_id
      where r.public_id = p_id and r.deleted_at is null);
  elsif p_type = 'QUESTION' then
    return (
      select jsonb_build_object(
        'type', 'QUESTION', 'id', q.id, 'status', q.status, 'note', null,
        'createdAt', q.created_at, 'author', app.user_ref_public(q.user_id),
        'subject', jsonb_build_object('type', 'ROADSHOW', 'id', rs.id, 'name', rs.title),
        'content', jsonb_build_object(
          'question', q.question, 'category', q.category, 'featured', q.featured,
          'answer', q.answer, 'answeredAt', q.answered_at))
      from public.roadshow_questions q
      join public.roadshows rs on rs.id = q.roadshow_id
      where q.id = p_id);
  elsif p_type = 'OFFER' then
    return (
      select jsonb_build_object(
        'type', 'OFFER', 'id', o.id, 'status', o.status, 'note', null,
        'createdAt', o.created_at, 'author', app.user_ref_public(o.user_id),
        'subject', jsonb_build_object('type', 'ROADSHOW', 'id', rs.id, 'name', rs.title),
        'content', jsonb_build_object(
          'offerPrice', o.offer_price, 'currency', o.currency, 'expectedRoi', o.expected_roi,
          'expectedIrr', o.expected_irr, 'entryLoad', o.entry_load, 'exitLoad', o.exit_load,
          'lockInMonths', o.lock_in_months, 'minInvestment', o.min_investment,
          'allotmentTerms', o.allotment_terms, 'paymentTerms', o.payment_terms, 'notes', o.notes))
      from public.roadshow_offers o
      join public.roadshows rs on rs.id = o.roadshow_id
      where o.id = p_id);
  end if;
  raise exception 'invalid moderation type %', p_type;
end $$;

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
    'isOpenForSigning', (now() >= r.opens_at and now() < r.closes_at
      and r.track_status in ('OPEN', 'CLOSING_SOON')),
    'createdAt', r.created_at, 'updatedAt', r.updated_at, 'deletedAt', r.deleted_at);
$$;

-- p_documents: [{ documentType, title, objectKey, mimeType, sizeBytes }], uploaded by staff to
-- the representation-documents bucket. Returns the created documents.
create or replace function app.add_representation_documents(
  p_representation_id bigint, p_status_history_id bigint, p_documents jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare
  v_next integer;
  v_created jsonb;
begin
  select coalesce(max(sort_order), 0) into v_next
  from app.representation_documents where representation_id = p_representation_id;

  with inserted as (
    insert into app.representation_documents (representation_id, status_history_id, document_type,
      title, object_key, mime_type, size_bytes, sort_order)
    select p_representation_id, p_status_history_id, d ->> 'documentType', d ->> 'title',
      d ->> 'objectKey', d ->> 'mimeType', (d ->> 'sizeBytes')::integer, v_next + x.ord::integer
    from jsonb_array_elements(coalesce(p_documents, '[]'::jsonb)) with ordinality as x (d, ord)
    returning *
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.public_id, 'title', i.title, 'documentType', i.document_type, 'bucket', i.bucket,
      'objectKey', i.object_key, 'mimeType', i.mime_type, 'sizeBytes', i.size_bytes,
      'scanStatus', i.scan_status, 'statusHistoryId', i.status_history_id, 'createdAt', i.created_at)
    order by i.sort_order), '[]'::jsonb)
  into v_created from inserted i;
  return v_created;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Staff roles
-- ---------------------------------------------------------------------------------------------

-- The roles of an active account; [] for members who are not staff.
create or replace function public.app_staff_roles(p_user_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(r.role order by r.role), '[]'::jsonb)
  from app.user_roles r
  join app.users u on u.id = r.user_id
  where r.user_id = p_user_id and u.status = 'ACTIVE';
$$;

-- Replaces a member's staff roles. Returns { ok, roles } or { error }.
create or replace function public.app_admin_set_roles(
  p_actor_id bigint, p_user_public_id uuid, p_roles text[], p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id bigint;
  v_before jsonb;
  v_after jsonb;
begin
  select id into v_user_id from app.users
  where public_id = p_user_public_id and status <> 'DELETED' for update;
  if v_user_id is null then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if v_user_id = p_actor_id then
    return jsonb_build_object('error', 'SELF_ACTION');
  end if;

  select coalesce(jsonb_agg(role order by role), '[]'::jsonb) into v_before
  from app.user_roles where user_id = v_user_id;

  delete from app.user_roles where user_id = v_user_id and role <> all (p_roles);
  insert into app.user_roles (user_id, role, granted_by)
  select v_user_id, r, p_actor_id from unnest(p_roles) as r
  on conflict do nothing;

  select coalesce(jsonb_agg(role order by role), '[]'::jsonb) into v_after
  from app.user_roles where user_id = v_user_id;

  if v_before is distinct from v_after then
    perform app.write_audit(p_ctx, 'admin.user.roles_changed', p_actor_id,
      jsonb_build_object('user', p_user_public_id, 'from', v_before, 'to', v_after));
  end if;
  return jsonb_build_object('ok', true, 'roles', v_after);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------------------------

-- Member search. Exact email or phone (keyed hashes computed by the API) or a name pattern.
-- Lists carry no contact details; GET /admin/users/:id does, and is audited.
create or replace function public.app_admin_find_users(
  p_q_pattern text, p_email_hash text, p_phone_hash text, p_tiers text[], p_kyc_statuses text[],
  p_statuses text[], p_staff_only boolean, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with matched as (
    select u.id, u.public_id, u.tier, u.requested_tier, u.kyc_status, u.status, u.credit_balance,
           u.created_at, u.last_login_at, coalesce(p.name, '') as name
    from app.users u
    left join app.user_profiles p on p.user_id = u.id
    where (p_q_pattern is null or lower(p.name) like p_q_pattern)
      and (p_email_hash is null or u.email_hash = p_email_hash)
      and (p_phone_hash is null or u.phone_hash = p_phone_hash)
      and (p_tiers is null or u.tier = any (p_tiers))
      and (p_kyc_statuses is null or u.kyc_status = any (p_kyc_statuses))
      and (p_statuses is null or u.status = any (p_statuses))
      and (not p_staff_only or exists (select 1 from app.user_roles r where r.user_id = u.id))
  ),
  page as (
    select m.*, row_number() over (order by m.created_at desc, m.id desc) as rn
    from matched m
    order by m.created_at desc, m.id desc
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pg.public_id, 'name', pg.name, 'tier', pg.tier, 'requestedTier', pg.requested_tier,
        'kycStatus', pg.kyc_status, 'status', pg.status, 'creditBalance', pg.credit_balance,
        'roles', (select coalesce(jsonb_agg(r.role order by r.role), '[]'::jsonb)
                  from app.user_roles r where r.user_id = pg.id),
        'createdAt', pg.created_at, 'lastLoginAt', pg.last_login_at)
        order by pg.rn)
      from page pg), '[]'::jsonb));
$$;

-- Everything a staff member sees about one account, including the encrypted email and phone
-- (decrypted by the API). Viewing it is audited. Null if the account does not exist.
create or replace function public.app_admin_get_user(p_actor_id bigint, p_user_public_id uuid, p_ctx jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id bigint;
  v_result jsonb;
begin
  select id into v_user_id from app.users where public_id = p_user_public_id;
  if v_user_id is null then
    return null;
  end if;

  select jsonb_build_object(
    'id', u.public_id, 'emailEnc', u.email_enc, 'phoneEnc', u.phone_enc,
    'name', coalesce(p.name, ''), 'experienceYears', p.experience_years,
    'jobProfileCode', p.job_profile_code, 'otherJob', p.other_job, 'location', p.location,
    'tier', u.tier, 'requestedTier', u.requested_tier, 'kycStatus', u.kyc_status,
    'status', u.status, 'creditBalance', u.credit_balance,
    'roles', (select coalesce(jsonb_agg(r.role order by r.role), '[]'::jsonb)
              from app.user_roles r where r.user_id = u.id),
    'createdAt', u.created_at, 'lastLoginAt', u.last_login_at, 'tierSelectedAt', u.tier_selected_at,
    'activeSessions', (
      select count(*) from app.user_sessions s
      where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()
        and s.absolute_expires_at > now()),
    'kyc', (
      select jsonb_build_object('id', k.public_id, 'tier', k.tier, 'status', k.status,
        'reason', k.reason, 'submittedAt', k.created_at, 'reviewedAt', k.reviewed_at)
      from app.kyc_submissions k where k.user_id = u.id
      order by k.created_at desc limit 1),
    'activity', jsonb_build_object(
      'reviews', (select count(*) from public.reviews r
                  where r.user_id = u.public_id and r.deleted_at is null),
      'ratings', (select count(*) from app.issuer_ratings r
                  where r.user_id = u.id and r.deleted_at is null),
      'signatures', (select count(*) from app.representation_signatures s
                     where s.user_id = u.id and s.deleted_at is null and s.status = 'VALID'),
      'poolMemberships', (select count(*) from public.pool_members m where m.user_id = u.public_id),
      'followers', (select count(*) from app.follows f where f.followee_id = u.id),
      'following', (select count(*) from app.follows f where f.follower_id = u.id)),
    'tierHistory', (
      select coalesce(jsonb_agg(jsonb_build_object('fromTier', h.from_tier, 'toTier', h.to_tier,
          'requestedTier', h.requested_tier, 'reason', h.reason, 'createdAt', h.created_at)
        order by h.created_at desc, h.id desc), '[]'::jsonb)
      from (select * from app.tier_history t where t.user_id = u.id
            order by t.created_at desc, t.id desc limit 20) h))
  into v_result
  from app.users u
  left join app.user_profiles p on p.user_id = u.id
  where u.id = v_user_id;

  perform app.write_audit(p_ctx, 'admin.user.viewed', p_actor_id,
    jsonb_build_object('user', p_user_public_id));
  return v_result;
end $$;

-- Changes a member's tier and/or account status (ACTIVE or SUSPENDED). Suspending ends every
-- session at once. p_tier / p_status null = unchanged. Returns { ok, user } or { error }.
create or replace function public.app_admin_update_user(
  p_actor_id bigint, p_user_public_id uuid, p_tier text, p_status text, p_reason text, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u app.users%rowtype;
  v_requested text;
begin
  if p_tier is not null and p_tier not in ('OBSERVER', 'PRIVE', 'INSTITUTIONAL') then
    raise exception 'invalid tier %', p_tier;
  end if;
  if p_status is not null and p_status not in ('ACTIVE', 'SUSPENDED') then
    raise exception 'invalid status %', p_status;
  end if;

  select * into v_u from app.users where public_id = p_user_public_id for update;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if v_u.id = p_actor_id then
    return jsonb_build_object('error', 'SELF_ACTION');
  end if;
  if v_u.status = 'DELETED' then
    return jsonb_build_object('error', 'USER_DELETED');
  end if;

  if p_tier is not null and p_tier <> v_u.tier then
    -- A request for the tier being granted is fulfilled.
    v_requested := case when v_u.requested_tier = p_tier then null else v_u.requested_tier end;
    update app.users set tier = p_tier, requested_tier = v_requested,
      tier_selected_at = coalesce(tier_selected_at, now())
    where id = v_u.id;
    insert into app.tier_history (user_id, from_tier, to_tier, requested_tier, reason)
    values (v_u.id, v_u.tier, p_tier, v_requested, 'ADMIN_CHANGED');
    perform app.notify(v_u.public_id, 'SYSTEM', 'Your membership has changed',
      'Your membership tier is now ' || initcap(p_tier) || '.', jsonb_build_object('tier', p_tier));
    perform app.write_audit(p_ctx, 'admin.user.tier_changed', p_actor_id,
      jsonb_build_object('user', p_user_public_id, 'from', v_u.tier, 'to', p_tier, 'reason', p_reason));
  end if;

  if p_status is not null and p_status <> v_u.status then
    update app.users set status = p_status where id = v_u.id;
    if p_status = 'SUSPENDED' then
      perform app.revoke_sessions(v_u.id, 'ADMIN', null);
    end if;
    perform app.write_audit(p_ctx,
      case when p_status = 'SUSPENDED' then 'admin.user.suspended' else 'admin.user.reactivated' end,
      p_actor_id, jsonb_build_object('user', p_user_public_id, 'reason', p_reason));
  end if;

  return jsonb_build_object('ok', true, 'user', app.user_ref(v_u.id));
end $$;

-- ---------------------------------------------------------------------------------------------
-- KYC
-- ---------------------------------------------------------------------------------------------

create or replace function public.app_admin_kyc_queue(
  p_statuses text[], p_tiers text[], p_oldest_first boolean, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with matched as (
    select s.* from app.kyc_submissions s
    where (p_statuses is null or s.status = any (p_statuses))
      and (p_tiers is null or s.tier = any (p_tiers))
  ),
  page as (
    select m.*, row_number() over (
      order by case when p_oldest_first then m.created_at end asc,
               case when not p_oldest_first then m.created_at end desc, m.id) as rn
    from matched m
    order by rn
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pg.public_id, 'tier', pg.tier, 'status', pg.status, 'provider', pg.provider,
        'submittedAt', pg.created_at, 'reviewedAt', pg.reviewed_at,
        'user', app.user_ref(pg.user_id),
        'documentCount', (select count(*) from app.kyc_documents d where d.submission_id = pg.id))
        order by pg.rn)
      from page pg), '[]'::jsonb));
$$;

-- One submission with its documents (storage location and virus-scan status), the member, the
-- reviewer and the KYC consent. Null if it does not exist.
create or replace function public.app_admin_kyc_get(p_submission_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', s.public_id, 'tier', s.tier, 'status', s.status, 'provider', s.provider,
    'reference', s.reference, 'reason', s.reason, 'submittedAt', s.created_at,
    'reviewedAt', s.reviewed_at,
    'user', app.user_ref(s.user_id) || jsonb_build_object('requestedTier', u.requested_tier),
    'reviewer', app.user_ref(s.reviewer_id),
    'consent', (
      select jsonb_build_object('version', c.version, 'acceptedAt', c.accepted_at)
      from app.consents c where c.user_id = s.user_id and c.type = 'KYC'
      order by c.accepted_at desc limit 1),
    'documents', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'fileId', f.public_id, 'documentType', d.document_type, 'bucket', f.bucket,
          'objectKey', f.object_key, 'mimeType', f.mime_type, 'sizeBytes', f.size_bytes,
          'scanStatus', f.scan_status)
        order by f.created_at, f.id), '[]'::jsonb)
      from app.kyc_documents d join app.files f on f.id = d.file_id
      where d.submission_id = s.id))
  from app.kyc_submissions s
  join app.users u on u.id = s.user_id
  where s.public_id = p_submission_id;
$$;

-- Approves or rejects a pending submission. Approval grants the submitted tier; rejection keeps
-- the requested tier so the member can submit again. Returns { ok, status, user } or { error }.
create or replace function public.app_admin_kyc_decide(
  p_actor_id bigint, p_submission_id uuid, p_decision text, p_reason text, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_s app.kyc_submissions%rowtype;
  v_u app.users%rowtype;
  v_status text;
begin
  if p_decision not in ('APPROVE', 'REJECT') then
    raise exception 'invalid decision %', p_decision;
  end if;

  select * into v_s from app.kyc_submissions where public_id = p_submission_id for update;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if v_s.user_id = p_actor_id then
    return jsonb_build_object('error', 'SELF_ACTION');
  end if;
  if v_s.status <> 'PENDING' then
    return jsonb_build_object('error', 'ALREADY_DECIDED', 'status', v_s.status);
  end if;
  select * into v_u from app.users where id = v_s.user_id for update;

  v_status := case when p_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end;
  update app.kyc_submissions
  set status = v_status, reviewer_id = p_actor_id, reviewed_at = now(),
      reason = case when p_decision = 'REJECT' then p_reason end
  where id = v_s.id;

  if p_decision = 'APPROVE' then
    update app.users set tier = v_s.tier, kyc_status = 'APPROVED',
      requested_tier = case when requested_tier = v_s.tier then null else requested_tier end,
      tier_selected_at = coalesce(tier_selected_at, now())
    where id = v_u.id;
    if v_u.tier <> v_s.tier then
      insert into app.tier_history (user_id, from_tier, to_tier, requested_tier, reason)
      values (v_u.id, v_u.tier, v_s.tier, null, 'KYC_APPROVED');
    end if;
    perform app.notify(v_u.public_id, 'KYC', 'Verification approved',
      'Your ' || initcap(v_s.tier) || ' verification was approved. Your membership is now active.',
      jsonb_build_object('kycSubmissionId', v_s.public_id, 'tier', v_s.tier));
  else
    update app.users set kyc_status = 'REJECTED' where id = v_u.id;
    perform app.notify(v_u.public_id, 'KYC', 'Verification not approved',
      'Your ' || initcap(v_s.tier) || ' verification was not approved. Reason: ' || p_reason
        || ' You can submit new documents at any time.',
      jsonb_build_object('kycSubmissionId', v_s.public_id, 'tier', v_s.tier));
  end if;

  perform app.write_audit(p_ctx,
    case when p_decision = 'APPROVE' then 'admin.kyc.approved' else 'admin.kyc.rejected' end,
    p_actor_id, jsonb_build_object('submission', v_s.public_id, 'user', v_u.public_id,
      'tier', v_s.tier, 'reason', p_reason));
  return jsonb_build_object('ok', true, 'status', v_status, 'user', app.user_ref(v_u.id));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Moderation: reviews, ratings, roadshow questions and roadshow offers
-- ---------------------------------------------------------------------------------------------

-- The queue, oldest first. p_statuses are queue statuses: PENDING (waiting for a decision,
-- PENDING_MODERATION or PENDING_REVIEW), PUBLISHED, CHANGES_REQUESTED, REJECTED, REMOVED,
-- WITHDRAWN.
create or replace function public.app_admin_moderation_queue(
  p_types text[], p_statuses text[], p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with items as (
    select 'REVIEW' as type, r.id, r.status::text as status, r.created_at
    from public.reviews r where r.deleted_at is null
    union all
    select 'RATING', r.public_id, r.status, r.created_at
    from app.issuer_ratings r where r.deleted_at is null
    union all
    select 'QUESTION', q.id, q.status::text, q.created_at from public.roadshow_questions q
    union all
    select 'OFFER', o.id, o.status::text, o.created_at from public.roadshow_offers o
  ),
  matched as (
    select i.* from items i
    where (p_types is null or i.type = any (p_types))
      and (p_statuses is null or (case when i.status in ('PENDING_MODERATION', 'PENDING_REVIEW')
                                       then 'PENDING' else i.status end) = any (p_statuses))
  ),
  page as (
    select m.*, row_number() over (order by m.created_at, m.type, m.id) as rn
    from matched m
    order by m.created_at, m.type, m.id
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'items', coalesce((
      select jsonb_agg(app.moderation_item(pg.type, pg.id) order by pg.rn) from page pg),
      '[]'::jsonb));
$$;

create or replace function public.app_admin_moderation_item(p_type text, p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.moderation_item(p_type, p_id);
$$;

-- Applies a decision (APPROVE, REJECT, REQUEST_CHANGES or REMOVE), records it in the item's
-- history where it has one, refreshes public numbers (by the existing stats triggers) and tells
-- the author. Returns { ok, type, id, status, previousStatus } or { error }.
create or replace function public.app_admin_moderate(
  p_actor_id bigint, p_type text, p_id uuid, p_decision text, p_note text, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid;
  v_from text;
  v_to text;
  v_author uuid;
  v_subject text;
  v_label text;
  v_data jsonb;
  v_notification text;
begin
  if p_type not in ('REVIEW', 'RATING', 'QUESTION', 'OFFER') then
    raise exception 'invalid moderation type %', p_type;
  end if;
  v_to := case p_decision
    when 'APPROVE' then 'PUBLISHED'
    when 'REJECT' then 'REJECTED'
    when 'REQUEST_CHANGES' then 'CHANGES_REQUESTED'
    when 'REMOVE' then 'REMOVED'
  end;
  if v_to is null then
    raise exception 'invalid decision %', p_decision;
  end if;
  select public_id into v_actor from app.users where id = p_actor_id;

  if p_type = 'REVIEW' then
    select r.status::text, r.user_id, c.name into v_from, v_author, v_subject
    from public.reviews r join public.companies c on c.id = r.company_id
    where r.id = p_id and r.deleted_at is null
    for update of r;
  elsif p_type = 'RATING' then
    select r.status, u.public_id, i.name into v_from, v_author, v_subject
    from app.issuer_ratings r
    join app.users u on u.id = r.user_id
    join public.issuers i on i.id = r.issuer_id
    where r.public_id = p_id and r.deleted_at is null
    for update of r;
  elsif p_type = 'QUESTION' then
    select q.status::text, q.user_id, rs.title into v_from, v_author, v_subject
    from public.roadshow_questions q join public.roadshows rs on rs.id = q.roadshow_id
    where q.id = p_id
    for update of q;
  else
    select o.status::text, o.user_id, rs.title into v_from, v_author, v_subject
    from public.roadshow_offers o join public.roadshows rs on rs.id = o.roadshow_id
    where o.id = p_id
    for update of o;
  end if;

  if v_from is null then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if v_author = v_actor then
    return jsonb_build_object('error', 'SELF_ACTION');
  end if;
  if not app.moderation_allowed(p_type, v_from, p_decision) then
    return jsonb_build_object('error', 'INVALID_TRANSITION', 'status', v_from);
  end if;

  if p_type = 'REVIEW' then
    update public.reviews
    set status = v_to::public.review_status, moderation_note = p_note,
        published_at = case when v_to = 'PUBLISHED' then coalesce(published_at, now()) else published_at end
    where id = p_id;
    insert into public.review_versions (review_id, change_type, from_value, to_value, note, actor_id)
    values (p_id, v_to::public.review_change_type, v_from, v_to, p_note, v_actor);
    v_label := 'review';
    v_notification := 'REVIEW';
    v_data := jsonb_build_object('reviewId', p_id);
  elsif p_type = 'RATING' then
    update app.issuer_ratings
    set status = v_to, moderation_note = p_note,
        published_at = case when v_to = 'PUBLISHED' then coalesce(published_at, now()) else published_at end
    where public_id = p_id;
    v_label := 'rating';
    v_notification := 'RATING';
    v_data := jsonb_build_object('ratingId', p_id);
  elsif p_type = 'QUESTION' then
    -- Questions have no REMOVED status: a takedown rejects the question.
    v_to := case when v_to = 'REMOVED' then 'REJECTED' else v_to end;
    update public.roadshow_questions set status = v_to::public.question_status
    where id = p_id
    returning jsonb_build_object('roadshowId', roadshow_id, 'questionId', id) into v_data;
    v_label := 'question';
    v_notification := 'ROADSHOW';
  else
    v_to := case when v_to = 'REMOVED' then 'REJECTED' else v_to end;
    update public.roadshow_offers set status = v_to::public.offer_status
    where id = p_id
    returning jsonb_build_object('roadshowId', roadshow_id, 'offerId', id) into v_data;
    v_label := 'offer';
    v_notification := 'ROADSHOW';
  end if;

  perform app.notify(v_author, v_notification,
    case p_decision
      when 'APPROVE' then 'Your ' || v_label || ' is live'
      when 'REQUEST_CHANGES' then 'Changes requested on your ' || v_label
      when 'REMOVE' then 'Your ' || v_label || ' was removed'
      else 'Your ' || v_label || ' was not published'
    end,
    'Your ' || v_label || ' on ' || v_subject || case p_decision
      when 'APPROVE' then ' is now published.'
      when 'REQUEST_CHANGES' then ' needs changes before it can be published.'
      when 'REMOVE' then ' was taken down.'
      else ' was not published.'
    end || coalesce(' Note from GIG: ' || p_note, ''),
    v_data);
  perform app.write_audit(p_ctx, 'admin.moderation.decided', p_actor_id,
    jsonb_build_object('type', p_type, 'id', p_id, 'decision', p_decision, 'from', v_from, 'to', v_to));
  return jsonb_build_object('ok', true, 'type', p_type, 'id', p_id, 'status', v_to,
    'previousStatus', v_from);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Representations (petitions)
-- ---------------------------------------------------------------------------------------------

-- Every petition, including scheduled (opens later) and, on request, deleted ones. Newest first.
-- p_statuses filters on the effective track status.
create or replace function public.app_admin_find_representations(
  p_q_pattern text, p_statuses text[], p_include_deleted boolean, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with matched as (
    select r.* from app.representations r
    where (p_include_deleted or r.deleted_at is null)
      and (p_q_pattern is null or lower(r.title || ' ' || r.slug) like p_q_pattern)
      and (p_statuses is null
           or app.representation_effective_status(r.track_status, r.closes_at) = any (p_statuses))
  ),
  page as (
    select m.id, row_number() over (order by m.created_at desc, m.id desc) as rn
    from matched m
    order by m.created_at desc, m.id desc
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'items', coalesce((
      select jsonb_agg(app.admin_representation_json(r) order by pg.rn)
      from page pg join app.representations r on r.id = pg.id), '[]'::jsonb));
$$;

-- One petition with every document (any scan status) and the full status history.
create or replace function public.app_admin_get_representation(p_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.admin_representation_json(r) || jsonb_build_object(
    'documents', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'id', d.public_id, 'title', d.title, 'documentType', d.document_type, 'bucket', d.bucket,
          'objectKey', d.object_key, 'mimeType', d.mime_type, 'sizeBytes', d.size_bytes,
          'scanStatus', d.scan_status, 'statusHistoryId', d.status_history_id,
          'createdAt', d.created_at)
        order by d.sort_order, d.id), '[]'::jsonb)
      from app.representation_documents d where d.representation_id = r.id),
    'history', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'id', h.id, 'fromStatus', h.from_status, 'toStatus', h.to_status, 'note', h.note,
          'actor', app.user_ref(h.actor_id), 'occurredAt', h.occurred_at)
        order by h.occurred_at, h.id), '[]'::jsonb)
      from app.representation_status_history h where h.representation_id = r.id))
  from app.representations r
  where r.public_id = p_public_id;
$$;

-- Creates (p_public_id null) or updates a petition. p_fields holds only the fields being set:
-- slug, title, description, asks, whyItMatters, category, country, tags, regulators, goal,
-- opensAt, closesAt. A taken slug raises 23505. Returns { ok, id } or { error } or { fields }.
create or replace function public.app_admin_save_representation(
  p_actor_id bigint, p_public_id uuid, p_fields jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_r app.representations%rowtype;
  v_opens timestamptz;
  v_closes timestamptz;
  v_id uuid;
begin
  if p_public_id is null then
    v_opens := coalesce((p_fields ->> 'opensAt')::timestamptz, now());
    v_closes := (p_fields ->> 'closesAt')::timestamptz;
    if v_closes is null or v_closes <= v_opens then
      return jsonb_build_object('fields', jsonb_build_object('closesAt', 'Must be after the opening date'));
    end if;
    insert into app.representations (slug, title, description, asks, why_it_matters, category,
      country, tags, regulators, goal, opens_at, closes_at)
    values (p_fields ->> 'slug', p_fields ->> 'title', coalesce(p_fields ->> 'description', ''),
      array(select jsonb_array_elements_text(coalesce(p_fields -> 'asks', '[]'::jsonb))),
      coalesce(p_fields ->> 'whyItMatters', ''), p_fields ->> 'category', p_fields ->> 'country',
      array(select jsonb_array_elements_text(coalesce(p_fields -> 'tags', '[]'::jsonb))),
      array(select jsonb_array_elements_text(coalesce(p_fields -> 'regulators', '[]'::jsonb))),
      (p_fields ->> 'goal')::integer, v_opens, v_closes)
    returning public_id into v_id;
    perform app.write_audit(p_ctx, 'admin.representation.created', p_actor_id,
      jsonb_build_object('representation', v_id));
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  select * into v_r from app.representations
  where public_id = p_public_id and deleted_at is null for update;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;

  v_opens := case when p_fields ? 'opensAt' then (p_fields ->> 'opensAt')::timestamptz else v_r.opens_at end;
  v_closes := case when p_fields ? 'closesAt' then (p_fields ->> 'closesAt')::timestamptz else v_r.closes_at end;
  if v_closes <= v_opens then
    return jsonb_build_object('fields', jsonb_build_object(
      case when p_fields ? 'closesAt' then 'closesAt' else 'opensAt' end,
      'The closing date must be after the opening date'));
  end if;

  update app.representations set
    slug = case when p_fields ? 'slug' then p_fields ->> 'slug' else slug end,
    title = case when p_fields ? 'title' then p_fields ->> 'title' else title end,
    description = case when p_fields ? 'description' then p_fields ->> 'description' else description end,
    asks = case when p_fields ? 'asks'
                then array(select jsonb_array_elements_text(p_fields -> 'asks')) else asks end,
    why_it_matters = case when p_fields ? 'whyItMatters' then p_fields ->> 'whyItMatters' else why_it_matters end,
    category = case when p_fields ? 'category' then p_fields ->> 'category' else category end,
    country = case when p_fields ? 'country' then p_fields ->> 'country' else country end,
    tags = case when p_fields ? 'tags'
                then array(select jsonb_array_elements_text(p_fields -> 'tags')) else tags end,
    regulators = case when p_fields ? 'regulators'
                      then array(select jsonb_array_elements_text(p_fields -> 'regulators')) else regulators end,
    goal = case when p_fields ? 'goal' then (p_fields ->> 'goal')::integer else goal end,
    opens_at = v_opens,
    closes_at = v_closes
  where id = v_r.id;

  perform app.write_audit(p_ctx, 'admin.representation.updated', p_actor_id,
    jsonb_build_object('representation', p_public_id,
      'fields', (select jsonb_agg(k order by k) from jsonb_object_keys(p_fields) k)));
  return jsonb_build_object('ok', true, 'id', p_public_id);
end $$;

-- Soft-deletes a petition: it leaves every public list; signatures and history are kept.
create or replace function public.app_admin_delete_representation(
  p_actor_id bigint, p_public_id uuid, p_ctx jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update app.representations set deleted_at = now()
  where public_id = p_public_id and deleted_at is null;
  if not found then
    return false;
  end if;
  perform app.write_audit(p_ctx, 'admin.representation.deleted', p_actor_id,
    jsonb_build_object('representation', p_public_id));
  return true;
end $$;

-- Advances the track to a staff-set status (UNDER_REVIEW ... RESOLVED). The track only moves
-- forward; moving past CLOSING_SOON ends signing. The history entry records who and why, the
-- documents are attached to it, and every signer is told. Returns { ok, trackStatus,
-- previousStatus, documents } or { error }.
create or replace function public.app_admin_representation_status(
  p_actor_id bigint, p_public_id uuid, p_status text, p_note text, p_documents jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order constant text[] := array['OPEN', 'CLOSING_SOON', 'CLOSED', 'UNDER_REVIEW',
    'SUBMITTED_TO_REGULATOR', 'MEETING_REQUESTED', 'MEETING_SCHEDULED', 'REGULATOR_RESPONDED',
    'RESOLVED'];
  v_r app.representations%rowtype;
  v_current text;
  v_history_id bigint;
  v_documents jsonb;
begin
  select * into v_r from app.representations
  where public_id = p_public_id and deleted_at is null for update;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;

  v_current := app.representation_effective_status(v_r.track_status, v_r.closes_at);
  if coalesce(array_position(v_order, p_status), 0) <= 3
     or array_position(v_order, p_status) <= array_position(v_order, v_current) then
    return jsonb_build_object('error', 'INVALID_TRANSITION', 'status', v_current);
  end if;

  update app.representations set track_status = p_status where id = v_r.id;

  -- The status trigger has just recorded the change; add who made it and why.
  select id into v_history_id from app.representation_status_history
  where representation_id = v_r.id order by id desc limit 1;
  update app.representation_status_history set note = p_note, actor_id = p_actor_id
  where id = v_history_id;

  v_documents := app.add_representation_documents(v_r.id, v_history_id, p_documents);

  insert into public.notifications (user_id, type, title, body, data)
  select u.public_id, 'REPRESENTATION', 'Petition update',
    left(v_r.title || ': ' || initcap(replace(p_status, '_', ' ')) || '.'
      || coalesce(' ' || p_note, ''), 1000),
    jsonb_build_object('representationId', v_r.public_id, 'trackStatus', p_status)
  from app.representation_signatures s
  join app.users u on u.id = s.user_id
  where s.representation_id = v_r.id and s.status = 'VALID' and s.deleted_at is null;

  perform app.write_audit(p_ctx, 'admin.representation.status_changed', p_actor_id,
    jsonb_build_object('representation', p_public_id, 'from', v_current, 'to', p_status,
      'documents', jsonb_array_length(v_documents)));
  return jsonb_build_object('ok', true, 'trackStatus', p_status, 'previousStatus', v_current,
    'documents', v_documents);
end $$;

-- Attaches documents (evidence and others) without changing the status. Null if not found.
create or replace function public.app_admin_add_representation_documents(
  p_actor_id bigint, p_public_id uuid, p_documents jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
  v_documents jsonb;
begin
  select id into v_id from app.representations
  where public_id = p_public_id and deleted_at is null for update;
  if v_id is null then
    return null;
  end if;
  v_documents := app.add_representation_documents(v_id, null, p_documents);
  perform app.write_audit(p_ctx, 'admin.representation.documents_added', p_actor_id,
    jsonb_build_object('representation', p_public_id, 'documents', jsonb_array_length(v_documents)));
  return v_documents;
end $$;

-- Signatures with the signer's real identity, for checking fraud. Null if the petition is unknown.
create or replace function public.app_admin_representation_signatures(
  p_public_id uuid, p_include_removed boolean, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with rep as (
    select id from app.representations where public_id = p_public_id
  ),
  matched as (
    select s.* from app.representation_signatures s
    where s.representation_id = (select id from rep) and s.deleted_at is null
      and (p_include_removed or s.status = 'VALID')
  ),
  page as (
    select m.*, row_number() over (order by m.created_at desc, m.id desc) as rn
    from matched m
    order by m.created_at desc, m.id desc
    limit p_limit offset p_offset
  )
  select case when exists (select 1 from rep) then jsonb_build_object(
    'total', (select count(*) from matched),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pg.public_id, 'signatureCode', pg.signature_code, 'displayMode', pg.display_mode,
        'signerName', pg.signer_name, 'investorType', pg.investor_type, 'signerTier', pg.signer_tier,
        'weight', pg.weight, 'status', pg.status, 'createdAt', pg.created_at,
        'user', app.user_ref(pg.user_id))
        order by pg.rn)
      from page pg), '[]'::jsonb)) end;
$$;

-- Removes a signature (for example a fraudulent one): it stops counting, the counters refresh
-- through the existing trigger, and the signer may sign again. Returns { ok } or { error }.
create or replace function public.app_admin_remove_signature(
  p_actor_id bigint, p_representation_id uuid, p_signature_id uuid, p_reason text, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_s app.representation_signatures%rowtype;
  v_title text;
  v_signer uuid;
begin
  select s.* into v_s
  from app.representation_signatures s
  join app.representations r on r.id = s.representation_id
  where s.public_id = p_signature_id and r.public_id = p_representation_id and s.deleted_at is null
  for update of s;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if v_s.status = 'REMOVED' then
    return jsonb_build_object('error', 'ALREADY_REMOVED');
  end if;

  update app.representation_signatures set status = 'REMOVED' where id = v_s.id;
  select r.title into v_title from app.representations r where r.id = v_s.representation_id;
  select u.public_id into v_signer from app.users u where u.id = v_s.user_id;
  perform app.notify(v_signer, 'REPRESENTATION', 'Your signature was removed',
    'Your signature on ' || v_title || ' was removed by GIG. Reason: ' || p_reason,
    jsonb_build_object('representationId', p_representation_id, 'signatureId', p_signature_id));
  perform app.write_audit(p_ctx, 'admin.representation.signature_removed', p_actor_id,
    jsonb_build_object('representation', p_representation_id, 'signature', p_signature_id,
      'reason', p_reason));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Roadshow Ask Me Anything
-- ---------------------------------------------------------------------------------------------

-- Publishes (or replaces) the issuer's answer. An answered question is published; a rejected one
-- cannot be answered. Returns { ok, question } or { error }.
create or replace function public.app_admin_answer_question(
  p_actor_id bigint, p_roadshow_id uuid, p_question_id uuid, p_answer text, p_featured boolean,
  p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_q public.roadshow_questions%rowtype;
  v_title text;
  v_first boolean;
begin
  select * into v_q from public.roadshow_questions
  where id = p_question_id and roadshow_id = p_roadshow_id for update;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if v_q.status = 'REJECTED' then
    return jsonb_build_object('error', 'QUESTION_REJECTED');
  end if;
  v_first := v_q.answer is null;

  update public.roadshow_questions
  set answer = p_answer, answered_at = now(), status = 'PUBLISHED',
      featured = coalesce(p_featured, featured)
  where id = v_q.id
  returning * into v_q;

  if v_first then
    select title into v_title from public.roadshows where id = p_roadshow_id;
    perform app.notify(v_q.user_id, 'ROADSHOW', 'Your question was answered',
      'The issuer answered your question on ' || v_title || '.',
      jsonb_build_object('roadshowId', p_roadshow_id, 'questionId', v_q.id));
  end if;
  perform app.write_audit(p_ctx, 'admin.question.answered', p_actor_id,
    jsonb_build_object('roadshow', p_roadshow_id, 'question', v_q.id, 'featured', v_q.featured));
  return jsonb_build_object('ok', true, 'question', jsonb_build_object(
    'id', v_q.id, 'roadshowId', v_q.roadshow_id, 'category', v_q.category, 'question', v_q.question,
    'status', v_q.status, 'featured', v_q.featured, 'answer', v_q.answer,
    'answeredAt', v_q.answered_at, 'createdAt', v_q.created_at));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Credits
-- ---------------------------------------------------------------------------------------------

-- Grants (p_delta > 0) or revokes (p_delta < 0) credits through public.apply_credit_change, tells
-- the member, and stores the result under the staff member's Idempotency-Key. A retry with the
-- same key and request returns the stored result with replayed = true. Two requests racing on
-- one key: the second fails on admin_requests_pkey and is retried by the API (then replays).
-- Returns { ok, entry, replayed } or { error }.
create or replace function public.app_admin_credit_change(
  p_actor_id bigint, p_user_public_id uuid, p_delta integer, p_note text, p_idempotency_key text,
  p_request_hash text, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_prior app.admin_requests%rowtype;
  v_user_id bigint;
  v_entry public.credit_ledger%rowtype;
  v_result jsonb;
begin
  select * into v_prior from app.admin_requests
  where actor_id = p_actor_id and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.action <> 'credits.change' or v_prior.request_hash <> p_request_hash then
      return jsonb_build_object('error', 'IDEMPOTENCY_CONFLICT');
    end if;
    return v_prior.result || jsonb_build_object('replayed', true);
  end if;

  select id into v_user_id from app.users where public_id = p_user_public_id and status <> 'DELETED';
  if v_user_id is null then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if v_user_id = p_actor_id then
    return jsonb_build_object('error', 'SELF_ACTION');
  end if;

  begin
    select * into v_entry from public.apply_credit_change(p_user_public_id, p_delta,
      (case when p_delta > 0 then 'ADMIN_GRANT' else 'ADMIN_REVOKE' end)::public.credit_reason,
      'ADMIN', null, p_note);
  exception when raise_exception then
    if sqlerrm = 'INSUFFICIENT_CREDITS' then
      return jsonb_build_object('error', 'INSUFFICIENT_CREDITS');
    end if;
    raise;
  end;

  v_result := jsonb_build_object('ok', true, 'entry', jsonb_build_object(
    'id', v_entry.id, 'userId', v_entry.user_id, 'delta', v_entry.delta,
    'balanceAfter', v_entry.balance_after, 'reason', v_entry.reason, 'note', v_entry.note,
    'createdAt', v_entry.created_at));
  insert into app.admin_requests (actor_id, idempotency_key, action, request_hash, result)
  values (p_actor_id, p_idempotency_key, 'credits.change', p_request_hash, v_result);

  perform app.notify(p_user_public_id, 'CREDITS',
    case when p_delta > 0 then 'Credits added' else 'Credits removed' end,
    case when p_delta > 0
      then abs(p_delta) || ' credit' || case when abs(p_delta) = 1 then '' else 's' end || ' added by GIG. '
      else abs(p_delta) || ' credit' || case when abs(p_delta) = 1 then '' else 's' end || ' removed by GIG. '
    end || 'Your balance is ' || v_entry.balance_after || '. ' || p_note,
    jsonb_build_object('ledgerEntryId', v_entry.id));
  perform app.write_audit(p_ctx,
    case when p_delta > 0 then 'admin.credits.granted' else 'admin.credits.revoked' end,
    p_actor_id, jsonb_build_object('user', p_user_public_id, 'delta', p_delta,
      'balanceAfter', v_entry.balance_after, 'ledgerEntryId', v_entry.id));
  return v_result || jsonb_build_object('replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------------------------

-- Newest first. p_action_prefix is a LIKE pattern built by the API (e.g. 'admin.kyc.%').
create or replace function public.app_admin_audit_logs(
  p_actions text[], p_action_prefix text, p_actor_public_id uuid, p_from timestamptz,
  p_to timestamptz, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with matched as (
    select a.* from app.audit_logs a
    where (p_actions is null or a.action = any (p_actions))
      and (p_action_prefix is null or a.action like p_action_prefix)
      and (p_actor_public_id is null
           or a.actor_user_id = (select u.id from app.users u where u.public_id = p_actor_public_id))
      and (p_from is null or a.occurred_at >= p_from)
      and (p_to is null or a.occurred_at < p_to)
  ),
  page as (
    select m.*, row_number() over (order by m.occurred_at desc, m.id desc) as rn
    from matched m
    order by m.occurred_at desc, m.id desc
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pg.id::text, 'occurredAt', pg.occurred_at, 'action', pg.action,
        'actor', app.user_ref(pg.actor_user_id), 'ip', host(pg.ip), 'userAgent', pg.user_agent,
        'requestId', pg.request_id, 'metadata', pg.metadata)
        order by pg.rn)
      from page pg), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------------------------

revoke execute on all functions in schema app from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
