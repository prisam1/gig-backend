-- Admin (Phase 1, plan weeks 14-15): the APIs behind GIG's admin console.
--   * staff roles (ADMIN, MODERATOR, ANALYST, SUPPORT), separate from the membership tier
--   * users: search, tier changes, suspension and staff roles
--   * KYC decisions: approval grants the submitted tier, rejection records the reason
--   * one moderation queue for reviews and ratings: approve, request changes, reject, remove
--   * content: companies, issuers and representations, and the petition track with documents
--   * credits: an append-only ledger, with the balance cached on app.users
--   * the audit trail
-- Same rules as 20261027160000_app_functions.sql: tables in the private "app" schema, reached only
-- through the public.app_admin_* functions (security definer, fixed search_path, service role
-- only). Every write audits itself in the same transaction. Expected failures are returned as
-- { "error": CODE }; unique and check violations are left to raise (SQLSTATE 23505 / 23514), so
-- the API can name the field.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

-- GIG staff. A user without a row here has no admin access, whatever their membership tier.
create table app.user_roles (
  user_id bigint not null references app.users (id) on delete cascade,
  role text not null check (role in ('ADMIN', 'MODERATOR', 'ANALYST', 'SUPPORT')),
  granted_by bigint references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);
create index user_roles_role_idx on app.user_roles (role);

-- Balance = sum of the ledger, cached here so spending can check it under a row lock.
alter table app.users add column credit_balance integer not null default 0
  constraint users_credit_balance_check check (credit_balance >= 0);

create table app.credit_ledger (
  id bigint generated always as identity primary key,
  public_id uuid not null unique default gen_random_uuid(),
  user_id bigint not null references app.users (id) on delete cascade,
  delta integer not null check (delta <> 0),
  balance_after integer not null check (balance_after >= 0),
  reason text not null check (char_length(reason) between 3 and 500),
  -- What the entry is for: ADMIN_GRANT / ADMIN_REVOKE here; pool joins, questions, ... later.
  ref_type text not null check (ref_type ~ '^[A-Z_]{1,40}$'),
  ref_id text check (char_length(ref_id) <= 100),
  -- The staff member for manual entries.
  actor_id bigint references app.users (id) on delete set null,
  idempotency_key text check (char_length(idempotency_key) between 8 and 128),
  request_hash text,
  created_at timestamptz not null default now()
);
create index credit_ledger_user_idx on app.credit_ledger (user_id, created_at desc);
create unique index credit_ledger_idempotency_key_idx
  on app.credit_ledger (actor_id, idempotency_key)
  where idempotency_key is not null;

-- Entries are never edited; they leave only with the account (on delete cascade).
create or replace function app.credit_ledger_no_update() returns trigger
language plpgsql as $$
begin
  raise exception 'credit_ledger is append-only';
end $$;
create trigger credit_ledger_no_update before update on app.credit_ledger
  for each statement execute function app.credit_ledger_no_update();

alter table app.user_roles enable row level security;
alter table app.credit_ledger enable row level security;

-- ---------------------------------------------------------------------------------------------
-- JSON shapes and helpers (app schema, not callable through the API)
-- ---------------------------------------------------------------------------------------------

create or replace function app.admin_roles_of(p_user_id bigint)
returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(array(select r.role from app.user_roles r where r.user_id = p_user_id order by r.role));
$$;

create or replace function app.admin_company_json(c public.companies)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'slug', c.slug, 'name', c.name, 'assetClass', c.asset_class, 'country', c.country,
    'logoUrl', c.logo_url, 'description', c.description, 'verified', c.verified,
    'tags', to_jsonb(array(select t.tag from public.company_tags t
                           where t.company_id = c.id order by t.sort_order, t.tag)),
    'reviewCount', coalesce((select s.review_count from public.company_stats s where s.company_id = c.id), 0),
    'score', coalesce((select s.score::float8 from public.company_stats s where s.company_id = c.id), 0),
    'pendingReviews', (select count(*) from public.reviews r
                       where r.company_id = c.id and r.status = 'PENDING_MODERATION' and r.deleted_at is null),
    'createdAt', c.created_at, 'updatedAt', c.updated_at, 'deletedAt', c.deleted_at);
$$;

create or replace function app.admin_issuer_json(i public.issuers)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id, 'slug', i.slug, 'name', i.name, 'instrument', i.instrument, 'assetType', i.asset_type,
    'exchange', i.exchange, 'openDate', i.open_date::text, 'closeDate', i.close_date::text,
    'isListed', i.is_listed, 'minLot', i.min_lot, 'lotUnit', i.lot_unit,
    'priceMin', i.price_min::float8, 'priceMax', i.price_max::float8, 'offerSize', i.offer_size::float8,
    'currency', i.currency, 'useOfFunds', i.use_of_funds, 'lockIn', i.lock_in,
    'prePostRatio', i.pre_post_ratio,
    'tags', to_jsonb(array(select t.tag from public.issuer_tags t
                           where t.issuer_id = i.id order by t.sort_order, t.tag)),
    'ratingCount', coalesce((select s.rating_count from app.issuer_stats s where s.issuer_id = i.id), 0),
    'averageScore', coalesce((select s.average_score::float8 from app.issuer_stats s where s.issuer_id = i.id), 0),
    'pendingRatings', (select count(*) from app.issuer_ratings r
                       where r.issuer_id = i.id and r.status = 'PENDING_MODERATION' and r.deleted_at is null),
    'createdAt', i.created_at, 'updatedAt', i.updated_at, 'deletedAt', i.deleted_at);
$$;

-- Staff see the stored status next to the one the app shows, and petitions not yet published.
create or replace function app.admin_representation_json(r app.representations)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.public_id, 'slug', r.slug, 'title', r.title, 'description', r.description,
    'asks', to_jsonb(r.asks), 'whyItMatters', r.why_it_matters, 'category', r.category,
    'country', r.country, 'tags', to_jsonb(r.tags), 'regulators', to_jsonb(r.regulators),
    'goal', r.goal, 'signatureCount', r.signature_count, 'voteCount', r.vote_count,
    'opensAt', r.opens_at, 'closesAt', r.closes_at,
    'storedStatus', r.track_status,
    'trackStatus', app.representation_effective_status(r.track_status, r.closes_at),
    'isPublished', r.opens_at <= now(),
    'isOpenForSigning', (r.opens_at <= now() and now() < r.closes_at
                         and r.track_status in ('OPEN', 'CLOSING_SOON')),
    'documentCount', (select count(*) from app.representation_documents d where d.representation_id = r.id),
    'createdAt', r.created_at, 'updatedAt', r.updated_at, 'deletedAt', r.deleted_at);
$$;

-- Staff upload a petition's documents into its own folder (<public_id>/...) of the
-- representation-documents bucket; a key anywhere else is refused.
create or replace function app.admin_documents_in_folder(p_public_id uuid, p_documents jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select not exists (
    select 1 from jsonb_array_elements(coalesce(p_documents, '[]'::jsonb)) d
    where d ->> 'objectKey' not like p_public_id::text || '/%'
  );
$$;

-- p_documents: [{ objectKey, title, documentType, mimeType, sizeBytes }], appended after the
-- petition's existing documents. Callers check app.admin_documents_in_folder first.
create or replace function app.admin_add_representation_documents(
  p_representation_id bigint, p_history_id bigint, p_documents jsonb
) returns void language sql set search_path = '' as $$
  insert into app.representation_documents (
    representation_id, status_history_id, document_type, title, object_key, mime_type, size_bytes, sort_order)
  select p_representation_id, p_history_id, d.value ->> 'documentType', d.value ->> 'title',
         d.value ->> 'objectKey', d.value ->> 'mimeType', (d.value ->> 'sizeBytes')::integer,
         coalesce((select max(x.sort_order) from app.representation_documents x
                   where x.representation_id = p_representation_id), 0) + d.ordinality::integer
  from jsonb_array_elements(coalesce(p_documents, '[]'::jsonb)) with ordinality as d (value, ordinality);
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff access
-- ---------------------------------------------------------------------------------------------

-- The roles of an active user; [] for everyone who is not staff.
create or replace function public.app_admin_staff_roles(p_user_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select app.admin_roles_of(u.id) from app.users u
                   where u.id = p_user_id and u.status = 'ACTIVE'), '[]'::jsonb);
$$;

-- ---------------------------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------------------------

-- Search by exact email or phone (keyed hashes, computed by the API), public id, or part of the
-- name (a LIKE pattern built and escaped by the API).
create or replace function public.app_admin_find_users(
  p_search jsonb, p_tiers text[], p_kyc_statuses text[], p_statuses text[], p_roles text[],
  p_sort text, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select jsonb_build_object(
             'id', u.public_id, 'name', p.name, 'tier', u.tier, 'requestedTier', u.requested_tier,
             'kycStatus', u.kyc_status, 'status', u.status, 'creditBalance', u.credit_balance,
             'roles', app.admin_roles_of(u.id), 'createdAt', u.created_at, 'lastLoginAt', u.last_login_at) as item,
           row_number() over (order by
             case when p_sort = '-createdAt' then u.created_at end desc,
             case when p_sort = 'createdAt' then u.created_at end asc,
             case when p_sort = 'name' then lower(p.name) end asc,
             case when p_sort = '-lastLoginAt' then u.last_login_at end desc nulls last,
             u.id desc) as rn
    from app.users u
    left join app.user_profiles p on p.user_id = u.id
    where (p_search ->> 'emailHash' is null or u.email_hash = p_search ->> 'emailHash')
      and (p_search ->> 'phoneHash' is null or u.phone_hash = p_search ->> 'phoneHash')
      and (p_search ->> 'publicId' is null or u.public_id = (p_search ->> 'publicId')::uuid)
      and (p_search ->> 'namePattern' is null or lower(p.name) like p_search ->> 'namePattern')
      and (coalesce(cardinality(p_tiers), 0) = 0 or u.tier = any (p_tiers))
      and (coalesce(cardinality(p_kyc_statuses), 0) = 0 or u.kyc_status = any (p_kyc_statuses))
      and (coalesce(cardinality(p_statuses), 0) = 0 or u.status = any (p_statuses))
      and (coalesce(cardinality(p_roles), 0) = 0
           or exists (select 1 from app.user_roles r where r.user_id = u.id and r.role = any (p_roles)))
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

-- Everything the console shows about one user. Email and phone stay encrypted; the API decrypts
-- them only for roles that may see contact details.
create or replace function public.app_admin_get_user(p_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', u.id::text, 'publicId', u.public_id, 'emailEnc', u.email_enc, 'phoneEnc', u.phone_enc,
    'name', p.name, 'experienceYears', p.experience_years, 'jobProfile', p.job_profile_code,
    'otherJob', p.other_job, 'location', p.location,
    'tier', u.tier, 'requestedTier', u.requested_tier, 'kycStatus', u.kyc_status, 'status', u.status,
    'creditBalance', u.credit_balance, 'roles', app.admin_roles_of(u.id),
    'emailVerifiedAt', u.email_verified_at, 'phoneVerifiedAt', u.phone_verified_at,
    'createdAt', u.created_at, 'lastLoginAt', u.last_login_at, 'deletedAt', u.deleted_at,
    'activeSessions', (select count(*) from app.user_sessions s
                       where s.user_id = u.id and s.revoked_at is null
                         and s.expires_at > now() and s.absolute_expires_at > now()),
    'activity', jsonb_build_object(
      'reviews', (select count(*) from public.reviews r where r.user_id = u.public_id and r.deleted_at is null),
      'ratings', (select count(*) from app.issuer_ratings r where r.user_id = u.id and r.deleted_at is null),
      'signatures', (select count(*) from app.representation_signatures s
                     where s.user_id = u.id and s.status = 'VALID' and s.deleted_at is null),
      'followers', (select count(*) from app.follows f where f.followee_id = u.id),
      'following', (select count(*) from app.follows f where f.follower_id = u.id)),
    'kycSubmissions', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'id', k.public_id, 'tier', k.tier, 'status', k.status, 'reason', k.reason,
          'submittedAt', k.created_at, 'reviewedAt', k.reviewed_at) order by k.created_at desc), '[]'::jsonb)
      from app.kyc_submissions k where k.user_id = u.id),
    'tierHistory', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'fromTier', h.from_tier, 'toTier', h.to_tier, 'requestedTier', h.requested_tier,
          'reason', h.reason, 'at', h.created_at) order by h.created_at desc, h.id desc), '[]'::jsonb)
      from (select * from app.tier_history t where t.user_id = u.id
            order by t.created_at desc, t.id desc limit 20) h))
  from app.users u
  left join app.user_profiles p on p.user_id = u.id
  where u.public_id = p_public_id;
$$;

-- p_changes: { tier?, status? (ACTIVE | SUSPENDED) }. A verified tier needs approved KYC.
-- Suspension signs the user out everywhere. Staff cannot change their own status.
-- Returns { ok } or { error: NOT_FOUND | SELF_CHANGE | KYC_NOT_APPROVED }.
create or replace function public.app_admin_update_user(
  p_actor_id bigint, p_public_id uuid, p_changes jsonb, p_reason text, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u app.users%rowtype;
  v_tier text := coalesce(p_changes ->> 'tier', '');
  v_status text := coalesce(p_changes ->> 'status', '');
  v_changes jsonb := '{}'::jsonb;
begin
  select * into v_u from app.users where public_id = p_public_id for update;
  if not found or v_u.status = 'DELETED' then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if v_status not in ('', 'ACTIVE', 'SUSPENDED') or v_tier not in ('', 'OBSERVER', 'PRIVE', 'INSTITUTIONAL') then
    raise exception 'invalid change %', p_changes;
  end if;
  if v_u.id = p_actor_id and v_status not in ('', v_u.status) then
    return jsonb_build_object('error', 'SELF_CHANGE');
  end if;
  if v_tier not in ('', 'OBSERVER') and v_u.kyc_status <> 'APPROVED' then
    return jsonb_build_object('error', 'KYC_NOT_APPROVED');
  end if;

  if v_tier not in ('', v_u.tier) then
    update app.users set
      tier = v_tier,
      requested_tier = case when requested_tier = v_tier then null else requested_tier end,
      tier_selected_at = coalesce(tier_selected_at, now())
    where id = v_u.id;
    insert into app.tier_history (user_id, from_tier, to_tier, requested_tier, reason)
    values (v_u.id, v_u.tier, v_tier, v_u.requested_tier, 'ADMIN_CHANGED');
    v_changes := v_changes || jsonb_build_object('tier', jsonb_build_object('from', v_u.tier, 'to', v_tier));
  end if;

  if v_status not in ('', v_u.status) then
    update app.users set status = v_status where id = v_u.id;
    if v_status = 'SUSPENDED' then
      perform app.revoke_sessions(v_u.id, 'ADMIN', null);
    end if;
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_object('from', v_u.status, 'to', v_status));
  end if;

  if v_changes <> '{}'::jsonb then
    perform app.write_audit(p_ctx, 'admin.user.updated', p_actor_id,
      jsonb_build_object('user', v_u.public_id, 'changes', v_changes, 'reason', p_reason));
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Replaces a user's staff roles. Staff cannot drop their own ADMIN role, and the last ADMIN
-- cannot be removed. Returns { roles } or { error: NOT_FOUND | SELF_CHANGE | LAST_ADMIN }.
create or replace function public.app_admin_set_roles(
  p_actor_id bigint, p_public_id uuid, p_roles text[], p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id bigint;
  v_before jsonb;
begin
  -- Serialises role changes, so two admins cannot remove each other at the same time.
  lock table app.user_roles in share row exclusive mode;

  select id into v_user_id from app.users where public_id = p_public_id and status <> 'DELETED' for update;
  if v_user_id is null then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  v_before := app.admin_roles_of(v_user_id);

  if v_user_id = p_actor_id and v_before ? 'ADMIN' and not ('ADMIN' = any (p_roles)) then
    return jsonb_build_object('error', 'SELF_CHANGE');
  end if;
  if v_before ? 'ADMIN' and not ('ADMIN' = any (p_roles)) and not exists (
    select 1 from app.user_roles r join app.users u on u.id = r.user_id
    where r.role = 'ADMIN' and r.user_id <> v_user_id and u.status = 'ACTIVE'
  ) then
    return jsonb_build_object('error', 'LAST_ADMIN');
  end if;

  delete from app.user_roles where user_id = v_user_id and not (role = any (p_roles));
  insert into app.user_roles (user_id, role, granted_by)
  select v_user_id, r, p_actor_id from unnest(p_roles) r
  on conflict do nothing;

  if v_before <> app.admin_roles_of(v_user_id) then
    perform app.write_audit(p_ctx, 'admin.user.roles_updated', p_actor_id,
      jsonb_build_object('user', p_public_id, 'from', v_before, 'to', app.admin_roles_of(v_user_id)));
  end if;
  return jsonb_build_object('roles', app.admin_roles_of(v_user_id));
end $$;

-- ---------------------------------------------------------------------------------------------
-- KYC
-- ---------------------------------------------------------------------------------------------

-- Open submissions first, oldest first (a FIFO queue); decided ones after, newest decision first.
create or replace function public.app_admin_find_kyc(
  p_statuses text[], p_tiers text[], p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select jsonb_build_object(
             'id', s.public_id, 'tier', s.tier, 'status', s.status, 'provider', s.provider,
             'reason', s.reason, 'submittedAt', s.created_at, 'reviewedAt', s.reviewed_at,
             'documentCount', (select count(*) from app.kyc_documents d where d.submission_id = s.id),
             'user', jsonb_build_object('id', u.public_id, 'name', p.name, 'tier', u.tier,
                                        'kycStatus', u.kyc_status, 'status', u.status)) as item,
           row_number() over (order by
             (s.status = 'PENDING') desc,
             case when s.status = 'PENDING' then s.created_at end asc,
             s.reviewed_at desc nulls last,
             s.id) as rn
    from app.kyc_submissions s
    join app.users u on u.id = s.user_id
    left join app.user_profiles p on p.user_id = u.id
    where (coalesce(cardinality(p_statuses), 0) = 0 or s.status = any (p_statuses))
      and (coalesce(cardinality(p_tiers), 0) = 0 or s.tier = any (p_tiers))
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

create or replace function public.app_admin_get_kyc(p_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', s.public_id, 'tier', s.tier, 'status', s.status, 'provider', s.provider,
    'reference', s.reference, 'reason', s.reason, 'submittedAt', s.created_at, 'reviewedAt', s.reviewed_at,
    'reviewer', case when rv.id is null then null
                     else jsonb_build_object('id', rv.public_id, 'name', rp.name) end,
    'user', jsonb_build_object('id', u.public_id, 'name', p.name, 'tier', u.tier,
                               'requestedTier', u.requested_tier, 'kycStatus', u.kyc_status,
                               'status', u.status, 'createdAt', u.created_at),
    'consent', (select jsonb_build_object('version', c.version, 'acceptedAt', c.accepted_at)
                from app.consents c where c.user_id = u.id and c.type = 'KYC'
                order by c.accepted_at desc limit 1),
    'documents', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'fileId', f.public_id, 'documentType', d.document_type, 'bucket', f.bucket,
          'objectKey', f.object_key, 'mimeType', f.mime_type, 'sizeBytes', f.size_bytes,
          'scanStatus', f.scan_status) order by d.document_type, f.id), '[]'::jsonb)
      from app.kyc_documents d join app.files f on f.id = d.file_id
      where d.submission_id = s.id))
  from app.kyc_submissions s
  join app.users u on u.id = s.user_id
  left join app.user_profiles p on p.user_id = u.id
  left join app.users rv on rv.id = s.reviewer_id
  left join app.user_profiles rp on rp.user_id = rv.id
  where s.public_id = p_public_id;
$$;

-- APPROVE grants the submission's tier; REJECT records the reason the user sees. Staff cannot
-- decide their own submission, and a submission with an infected document cannot be approved.
-- Returns { status, tier, kycStatus } or { error: NOT_FOUND | ALREADY_DECIDED | OWN_SUBMISSION |
-- USER_INACTIVE | DOCUMENT_INFECTED }.
create or replace function public.app_admin_decide_kyc(
  p_actor_id bigint, p_public_id uuid, p_decision text, p_reason text, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_s app.kyc_submissions%rowtype;
  v_u app.users%rowtype;
begin
  if p_decision not in ('APPROVE', 'REJECT') then
    raise exception 'invalid decision %', p_decision;
  end if;
  select * into v_s from app.kyc_submissions where public_id = p_public_id for update;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if v_s.status <> 'PENDING' then
    return jsonb_build_object('error', 'ALREADY_DECIDED', 'status', v_s.status);
  end if;
  if v_s.user_id = p_actor_id then
    return jsonb_build_object('error', 'OWN_SUBMISSION');
  end if;
  select * into v_u from app.users where id = v_s.user_id for update;
  if v_u.status = 'DELETED' then
    return jsonb_build_object('error', 'USER_INACTIVE');
  end if;

  if p_decision = 'REJECT' then
    update app.kyc_submissions set status = 'REJECTED', reason = p_reason, reviewer_id = p_actor_id,
      reviewed_at = now()
    where id = v_s.id;
    update app.users set kyc_status = 'REJECTED' where id = v_u.id;
    perform app.write_audit(p_ctx, 'admin.kyc.rejected', p_actor_id,
      jsonb_build_object('submission', v_s.public_id, 'user', v_u.public_id, 'tier', v_s.tier));
    return jsonb_build_object('status', 'REJECTED', 'tier', v_u.tier, 'kycStatus', 'REJECTED');
  end if;

  if exists (
    select 1 from app.kyc_documents d join app.files f on f.id = d.file_id
    where d.submission_id = v_s.id and f.scan_status = 'INFECTED'
  ) then
    return jsonb_build_object('error', 'DOCUMENT_INFECTED');
  end if;

  update app.kyc_submissions set status = 'APPROVED', reason = null, reviewer_id = p_actor_id,
    reviewed_at = now()
  where id = v_s.id;
  update app.users set
    kyc_status = 'APPROVED',
    tier = v_s.tier,
    requested_tier = case when requested_tier = v_s.tier then null else requested_tier end,
    tier_selected_at = coalesce(tier_selected_at, now())
  where id = v_u.id;
  if v_u.tier <> v_s.tier then
    insert into app.tier_history (user_id, from_tier, to_tier, requested_tier, reason)
    values (v_u.id, v_u.tier, v_s.tier, v_u.requested_tier, 'KYC_APPROVED');
  end if;
  perform app.write_audit(p_ctx, 'admin.kyc.approved', p_actor_id,
    jsonb_build_object('submission', v_s.public_id, 'user', v_u.public_id, 'tier', v_s.tier));
  return jsonb_build_object('status', 'APPROVED', 'tier', v_s.tier, 'kycStatus', 'APPROVED');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Moderation: reviews and ratings in one queue
-- ---------------------------------------------------------------------------------------------

-- Oldest first, so the queue is worked in the order things were submitted.
create or replace function public.app_admin_moderation_queue(
  p_types text[], p_statuses text[], p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with items as (
    select r.created_at, r.id::text as key, jsonb_build_object(
             'type', 'REVIEW', 'id', r.id, 'receiptNo', r.receipt_no, 'status', r.status,
             'submittedAt', r.created_at, 'moderationNote', r.moderation_note,
             'author', jsonb_build_object('id', r.user_id, 'name', r.author_name,
                                          'tier', u.tier, 'kycStatus', u.kyc_status),
             'subject', jsonb_build_object('type', 'COMPANY', 'id', c.id, 'name', c.name),
             'summary', jsonb_build_object(
               'sentiment', r.sentiment, 'overallScore', r.m_overall_satisfaction,
               'excerpt', left(coalesce(r.negative_description, r.detailed_review, r.mixed_review, ''), 200),
               'evidenceCount', (select count(*) from public.review_attachments a where a.review_id = r.id))) as item
    from public.reviews r
    join public.companies c on c.id = r.company_id
    left join app.users u on u.public_id = r.user_id
    where r.deleted_at is null
      and (coalesce(cardinality(p_types), 0) = 0 or 'REVIEW' = any (p_types))
      and (coalesce(cardinality(p_statuses), 0) = 0 or r.status::text = any (p_statuses))
    union all
    select ir.created_at, ir.public_id::text, jsonb_build_object(
             'type', 'RATING', 'id', ir.public_id, 'receiptNo', ir.receipt_no, 'status', ir.status,
             'submittedAt', ir.created_at, 'moderationNote', ir.moderation_note,
             'author', jsonb_build_object('id', u.public_id, 'name', coalesce(p.name, ''),
                                          'tier', u.tier, 'kycStatus', u.kyc_status),
             'subject', jsonb_build_object('type', 'ISSUER', 'id', i.id, 'name', i.name),
             'summary', jsonb_build_object('overallScore', ir.overall_score))
    from app.issuer_ratings ir
    join public.issuers i on i.id = ir.issuer_id
    join app.users u on u.id = ir.user_id
    left join app.user_profiles p on p.user_id = u.id
    where ir.deleted_at is null
      and (coalesce(cardinality(p_types), 0) = 0 or 'RATING' = any (p_types))
      and (coalesce(cardinality(p_statuses), 0) = 0 or ir.status = any (p_statuses))
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(x.item order by x.created_at, x.key)
                       from (select * from items order by created_at, key
                             limit p_limit offset p_offset) x), '[]'::jsonb),
    'total', (select count(*) from items));
$$;

-- One item in full, for the moderator's decision.
create or replace function public.app_admin_moderation_item(p_type text, p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'type', 'REVIEW', 'id', r.id, 'receiptNo', r.receipt_no, 'status', r.status,
    'moderationNote', r.moderation_note, 'submittedAt', r.created_at, 'publishedAt', r.published_at,
    'author', jsonb_build_object('id', r.user_id, 'name', r.author_name, 'tier', u.tier,
                                 'kycStatus', u.kyc_status),
    'subject', jsonb_build_object('type', 'COMPANY', 'id', c.id, 'name', c.name),
    'content', jsonb_build_object(
      'country', r.country, 'assetClass', r.asset_class, 'productScheme', r.product_scheme,
      'investmentYear', r.investment_year, 'investmentStatus', r.investment_status,
      'sentiment', r.sentiment, 'detailedReview', r.detailed_review, 'mixedReview', r.mixed_review,
      'negativeDescription', r.negative_description, 'reinvestStatus', r.reinvest_status,
      'metrics', jsonb_build_object(
        'transparency', r.m_transparency, 'responsiveness', r.m_responsiveness,
        'easeOfProcess', r.m_ease_of_process, 'trustworthiness', r.m_trustworthiness,
        'overallSatisfaction', r.m_overall_satisfaction),
      'resolutionStatus', r.resolution_status, 'followUpNote', r.follow_up_note,
      'displayMode', r.display_mode, 'allowContact', r.allow_contact,
      'appreciations', to_jsonb(array(select t.code from public.review_tags t
                                      where t.review_id = r.id and t.tag_type = 'APPRECIATION' order by t.code)),
      'concerns', to_jsonb(array(select t.code from public.review_tags t
                                 where t.review_id = r.id and t.tag_type = 'CONCERN' order by t.code)),
      'contactStatus', to_jsonb(array(select t.code from public.review_tags t
                                      where t.review_id = r.id and t.tag_type = 'CONTACT_STATUS' order by t.code))),
    'evidence', (select coalesce(jsonb_agg(jsonb_build_object('path', a.storage_path, 'docType', a.doc_type)
                                           order by a.created_at, a.storage_path), '[]'::jsonb)
                 from public.review_attachments a where a.review_id = r.id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object(
                    'changeType', v.change_type, 'fromValue', v.from_value, 'toValue', v.to_value,
                    'note', v.note, 'at', v.created_at) order by v.created_at, v.id), '[]'::jsonb)
                from public.review_versions v where v.review_id = r.id))
  from public.reviews r
  join public.companies c on c.id = r.company_id
  left join app.users u on u.public_id = r.user_id
  where p_type = 'REVIEW' and r.id = p_id and r.deleted_at is null
  union all
  select jsonb_build_object(
    'type', 'RATING', 'id', ir.public_id, 'receiptNo', ir.receipt_no, 'status', ir.status,
    'moderationNote', ir.moderation_note, 'submittedAt', ir.created_at, 'publishedAt', ir.published_at,
    'author', jsonb_build_object('id', u.public_id, 'name', coalesce(p.name, ''), 'tier', u.tier,
                                 'kycStatus', u.kyc_status),
    'subject', jsonb_build_object('type', 'ISSUER', 'id', i.id, 'name', i.name),
    'content', jsonb_build_object(
      'overallScore', ir.overall_score,
      'factors', (select coalesce(jsonb_agg(jsonb_build_object('code', f.factor_code, 'flag', f.flag)
                                            order by f.factor_code), '[]'::jsonb)
                  from app.issuer_rating_factors f where f.rating_id = ir.id),
      'riskFactors', to_jsonb(array(select k.risk_code from app.issuer_rating_risks k
                                    where k.rating_id = ir.id order by k.risk_code))),
    'evidence', '[]'::jsonb,
    'history', '[]'::jsonb)
  from app.issuer_ratings ir
  join public.issuers i on i.id = ir.issuer_id
  join app.users u on u.id = ir.user_id
  left join app.user_profiles p on p.user_id = u.id
  where p_type = 'RATING' and ir.public_id = p_id and ir.deleted_at is null;
$$;

-- APPROVE publishes (from pending or changes requested), REQUEST_CHANGES and REJECT decide a
-- pending item, REMOVE takes a published one down. Public numbers recompute through the existing
-- triggers. Staff cannot moderate their own content.
-- Returns { type, id, previousStatus, status } or { error: NOT_FOUND | OWN_CONTENT | INVALID_TRANSITION }.
create or replace function public.app_admin_moderate(
  p_actor_id bigint, p_type text, p_id uuid, p_decision text, p_note text, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_to text := case p_decision
    when 'APPROVE' then 'PUBLISHED' when 'REQUEST_CHANGES' then 'CHANGES_REQUESTED'
    when 'REJECT' then 'REJECTED' when 'REMOVE' then 'REMOVED' end;
  v_allowed text[] := case p_decision
    when 'APPROVE' then array['PENDING_MODERATION', 'CHANGES_REQUESTED']
    when 'REQUEST_CHANGES' then array['PENDING_MODERATION']
    when 'REJECT' then array['PENDING_MODERATION', 'CHANGES_REQUESTED']
    when 'REMOVE' then array['PUBLISHED'] end;
  v_from text;
  v_author bigint;
begin
  if v_to is null or p_type not in ('REVIEW', 'RATING') then
    raise exception 'invalid moderation % %', p_type, p_decision;
  end if;

  if p_type = 'REVIEW' then
    select r.status::text, u.id into v_from, v_author
    from public.reviews r left join app.users u on u.public_id = r.user_id
    where r.id = p_id and r.deleted_at is null
    for update of r;
  else
    select r.status, r.user_id into v_from, v_author
    from app.issuer_ratings r
    where r.public_id = p_id and r.deleted_at is null
    for update;
  end if;
  if v_from is null then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if v_author = p_actor_id then
    return jsonb_build_object('error', 'OWN_CONTENT');
  end if;
  if not (v_from = any (v_allowed)) then
    return jsonb_build_object('error', 'INVALID_TRANSITION', 'status', v_from);
  end if;

  if p_type = 'REVIEW' then
    update public.reviews set
      status = v_to::public.review_status,
      moderation_note = p_note,
      published_at = case when v_to = 'PUBLISHED' then coalesce(published_at, now()) else published_at end
    where id = p_id;
    insert into public.review_versions (review_id, change_type, from_value, to_value, note, actor_id)
    values (p_id, v_to::public.review_change_type, v_from, v_to, p_note,
            (select public_id from app.users where id = p_actor_id));
  else
    update app.issuer_ratings set
      status = v_to,
      moderation_note = p_note,
      published_at = case when v_to = 'PUBLISHED' then coalesce(published_at, now()) else published_at end
    where public_id = p_id;
  end if;

  perform app.write_audit(p_ctx, 'admin.moderation.decided', p_actor_id, jsonb_build_object(
    'type', p_type, 'id', p_id, 'decision', p_decision, 'from', v_from, 'to', v_to));
  return jsonb_build_object('type', p_type, 'id', p_id, 'previousStatus', v_from, 'status', v_to);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Content: companies
-- ---------------------------------------------------------------------------------------------

create or replace function public.app_admin_find_companies(
  p_q_pattern text, p_asset_classes text[], p_countries text[], p_verified boolean,
  p_include_deleted boolean, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select app.admin_company_json(c) as item,
           row_number() over (order by c.created_at desc, c.id) as rn
    from public.companies c
    where (p_include_deleted or c.deleted_at is null)
      and (p_q_pattern is null or lower(c.name || ' ' || c.slug) like p_q_pattern)
      and (coalesce(cardinality(p_asset_classes), 0) = 0 or c.asset_class::text = any (p_asset_classes))
      and (coalesce(cardinality(p_countries), 0) = 0 or c.country::text = any (p_countries))
      and (p_verified is null or c.verified = p_verified)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

create or replace function public.app_admin_get_company(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.admin_company_json(c) from public.companies c where c.id = p_id;
$$;

-- Creates (p_id null) or updates a company. p_company holds only the fields being set:
-- slug, name, assetClass, country, logoUrl, description, verified, tags (replaces all tags).
-- Returns { id } or { error: NOT_FOUND }.
create or replace function public.app_admin_save_company(
  p_actor_id bigint, p_id uuid, p_company jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_id is null then
    insert into public.companies (slug, name, asset_class, country, logo_url, description, verified)
    values (p_company ->> 'slug', p_company ->> 'name', (p_company ->> 'assetClass')::public.asset_class,
            (p_company ->> 'country')::public.market_country, p_company ->> 'logoUrl',
            p_company ->> 'description', coalesce((p_company ->> 'verified')::boolean, false))
    returning id into v_id;
  else
    update public.companies set
      slug = case when p_company ? 'slug' then p_company ->> 'slug' else slug end,
      name = case when p_company ? 'name' then p_company ->> 'name' else name end,
      asset_class = case when p_company ? 'assetClass'
                         then (p_company ->> 'assetClass')::public.asset_class else asset_class end,
      country = case when p_company ? 'country'
                     then (p_company ->> 'country')::public.market_country else country end,
      logo_url = case when p_company ? 'logoUrl' then p_company ->> 'logoUrl' else logo_url end,
      description = case when p_company ? 'description' then p_company ->> 'description' else description end,
      verified = case when p_company ? 'verified' then (p_company ->> 'verified')::boolean else verified end
    where id = p_id and deleted_at is null
    returning id into v_id;
    if v_id is null then
      return jsonb_build_object('error', 'NOT_FOUND');
    end if;
  end if;

  if p_company ? 'tags' then
    delete from public.company_tags where company_id = v_id;
    insert into public.company_tags (company_id, tag, sort_order)
    select v_id, t.tag, t.ord
    from jsonb_array_elements_text(p_company -> 'tags') with ordinality as t (tag, ord);
  end if;

  perform app.write_audit(p_ctx,
    case when p_id is null then 'admin.company.created' else 'admin.company.updated' end, p_actor_id,
    jsonb_build_object('company', v_id, 'fields', (select jsonb_agg(k order by k) from jsonb_object_keys(p_company) k)));
  return jsonb_build_object('id', v_id);
end $$;

-- Soft delete: the company leaves the app's lists; its reviews stay.
create or replace function public.app_admin_delete_company(p_actor_id bigint, p_id uuid, p_ctx jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.companies set deleted_at = now() where id = p_id and deleted_at is null;
  if not found then
    return false;
  end if;
  perform app.write_audit(p_ctx, 'admin.company.deleted', p_actor_id, jsonb_build_object('company', p_id));
  return true;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Content: issuers
-- ---------------------------------------------------------------------------------------------

create or replace function public.app_admin_find_issuers(
  p_q_pattern text, p_asset_types text[], p_listed boolean, p_include_deleted boolean,
  p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select app.admin_issuer_json(i) as item,
           row_number() over (order by i.created_at desc, i.id) as rn
    from public.issuers i
    where (p_include_deleted or i.deleted_at is null)
      and (p_q_pattern is null or lower(i.name || ' ' || i.slug || ' ' || i.instrument) like p_q_pattern)
      and (coalesce(cardinality(p_asset_types), 0) = 0 or i.asset_type = any (p_asset_types))
      and (p_listed is null or i.is_listed = p_listed)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

create or replace function public.app_admin_get_issuer(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.admin_issuer_json(i) from public.issuers i where i.id = p_id;
$$;

-- Creates (p_id null) or updates an issuer; p_issuer holds only the fields being set.
-- Returns { id } or { error: NOT_FOUND }.
create or replace function public.app_admin_save_issuer(
  p_actor_id bigint, p_id uuid, p_issuer jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_id is null then
    insert into public.issuers (slug, name, instrument, asset_type, exchange, open_date, close_date,
      is_listed, min_lot, lot_unit, price_min, price_max, offer_size, currency, use_of_funds, lock_in,
      pre_post_ratio)
    values (p_issuer ->> 'slug', p_issuer ->> 'name', p_issuer ->> 'instrument', p_issuer ->> 'assetType',
      p_issuer ->> 'exchange', (p_issuer ->> 'openDate')::date, (p_issuer ->> 'closeDate')::date,
      coalesce((p_issuer ->> 'isListed')::boolean, false), (p_issuer ->> 'minLot')::integer,
      coalesce(p_issuer ->> 'lotUnit', 'shares'), (p_issuer ->> 'priceMin')::numeric,
      (p_issuer ->> 'priceMax')::numeric, (p_issuer ->> 'offerSize')::numeric,
      coalesce(p_issuer ->> 'currency', 'INR'), p_issuer ->> 'useOfFunds', p_issuer ->> 'lockIn',
      p_issuer ->> 'prePostRatio')
    returning id into v_id;
  else
    update public.issuers set
      slug = case when p_issuer ? 'slug' then p_issuer ->> 'slug' else slug end,
      name = case when p_issuer ? 'name' then p_issuer ->> 'name' else name end,
      instrument = case when p_issuer ? 'instrument' then p_issuer ->> 'instrument' else instrument end,
      asset_type = case when p_issuer ? 'assetType' then p_issuer ->> 'assetType' else asset_type end,
      exchange = case when p_issuer ? 'exchange' then p_issuer ->> 'exchange' else exchange end,
      open_date = case when p_issuer ? 'openDate' then (p_issuer ->> 'openDate')::date else open_date end,
      close_date = case when p_issuer ? 'closeDate' then (p_issuer ->> 'closeDate')::date else close_date end,
      is_listed = case when p_issuer ? 'isListed' then (p_issuer ->> 'isListed')::boolean else is_listed end,
      min_lot = case when p_issuer ? 'minLot' then (p_issuer ->> 'minLot')::integer else min_lot end,
      lot_unit = case when p_issuer ? 'lotUnit' then p_issuer ->> 'lotUnit' else lot_unit end,
      price_min = case when p_issuer ? 'priceMin' then (p_issuer ->> 'priceMin')::numeric else price_min end,
      price_max = case when p_issuer ? 'priceMax' then (p_issuer ->> 'priceMax')::numeric else price_max end,
      offer_size = case when p_issuer ? 'offerSize' then (p_issuer ->> 'offerSize')::numeric else offer_size end,
      currency = case when p_issuer ? 'currency' then p_issuer ->> 'currency' else currency end,
      use_of_funds = case when p_issuer ? 'useOfFunds' then p_issuer ->> 'useOfFunds' else use_of_funds end,
      lock_in = case when p_issuer ? 'lockIn' then p_issuer ->> 'lockIn' else lock_in end,
      pre_post_ratio = case when p_issuer ? 'prePostRatio' then p_issuer ->> 'prePostRatio' else pre_post_ratio end
    where id = p_id and deleted_at is null
    returning id into v_id;
    if v_id is null then
      return jsonb_build_object('error', 'NOT_FOUND');
    end if;
  end if;

  if p_issuer ? 'tags' then
    delete from public.issuer_tags where issuer_id = v_id;
    insert into public.issuer_tags (issuer_id, tag, sort_order)
    select v_id, t.tag, t.ord
    from jsonb_array_elements_text(p_issuer -> 'tags') with ordinality as t (tag, ord);
  end if;

  perform app.write_audit(p_ctx,
    case when p_id is null then 'admin.issuer.created' else 'admin.issuer.updated' end, p_actor_id,
    jsonb_build_object('issuer', v_id, 'fields', (select jsonb_agg(k order by k) from jsonb_object_keys(p_issuer) k)));
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.app_admin_delete_issuer(p_actor_id bigint, p_id uuid, p_ctx jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.issuers set deleted_at = now() where id = p_id and deleted_at is null;
  if not found then
    return false;
  end if;
  perform app.write_audit(p_ctx, 'admin.issuer.deleted', p_actor_id, jsonb_build_object('issuer', p_id));
  return true;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Content: representations and the petition track
-- ---------------------------------------------------------------------------------------------

create or replace function public.app_admin_find_representations(
  p_q_pattern text, p_statuses text[], p_countries text[], p_include_deleted boolean,
  p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select app.admin_representation_json(r) as item,
           row_number() over (order by r.created_at desc, r.id) as rn
    from app.representations r
    where (p_include_deleted or r.deleted_at is null)
      and (p_q_pattern is null or lower(r.title || ' ' || r.slug) like p_q_pattern)
      and (coalesce(cardinality(p_statuses), 0) = 0
           or app.representation_effective_status(r.track_status, r.closes_at) = any (p_statuses))
      and (coalesce(cardinality(p_countries), 0) = 0 or r.country = any (p_countries))
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

-- The petition with all its documents (infected ones flagged, not hidden) and status history.
create or replace function public.app_admin_get_representation(p_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.admin_representation_json(r) || jsonb_build_object(
    'documents', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'id', d.public_id, 'title', d.title, 'documentType', d.document_type, 'bucket', d.bucket,
          'objectKey', d.object_key, 'mimeType', d.mime_type, 'sizeBytes', d.size_bytes,
          'scanStatus', d.scan_status, 'createdAt', d.created_at) order by d.sort_order, d.id), '[]'::jsonb)
      from app.representation_documents d where d.representation_id = r.id),
    'history', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'fromStatus', h.from_status, 'toStatus', h.to_status, 'note', h.note,
          'actor', case when a.id is null then null else jsonb_build_object('id', a.public_id, 'name', ap.name) end,
          'occurredAt', h.occurred_at,
          'documentIds', to_jsonb(array(select d.public_id from app.representation_documents d
                                        where d.status_history_id = h.id order by d.sort_order, d.id))
        ) order by h.occurred_at, h.id), '[]'::jsonb)
      from app.representation_status_history h
      left join app.users a on a.id = h.actor_id
      left join app.user_profiles ap on ap.user_id = a.id
      where h.representation_id = r.id))
  from app.representations r
  where r.public_id = p_public_id;
$$;

-- Creates (p_public_id null) or updates a petition; p_representation holds only the fields being
-- set: slug, title, description, asks, whyItMatters, category, country, tags, regulators, goal,
-- opensAt, closesAt. Returns { id } or { error: NOT_FOUND }.
create or replace function public.app_admin_save_representation(
  p_actor_id bigint, p_public_id uuid, p_representation jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_r jsonb := p_representation;
  v_id uuid;
begin
  if p_public_id is null then
    insert into app.representations (slug, title, description, asks, why_it_matters, category,
      country, tags, regulators, goal, opens_at, closes_at)
    values (v_r ->> 'slug', v_r ->> 'title', coalesce(v_r ->> 'description', ''),
      array(select jsonb_array_elements_text(v_r -> 'asks')), coalesce(v_r ->> 'whyItMatters', ''),
      v_r ->> 'category', v_r ->> 'country',
      array(select jsonb_array_elements_text(v_r -> 'tags')),
      array(select jsonb_array_elements_text(v_r -> 'regulators')),
      (v_r ->> 'goal')::integer, coalesce((v_r ->> 'opensAt')::timestamptz, now()),
      (v_r ->> 'closesAt')::timestamptz)
    returning public_id into v_id;
  else
    update app.representations set
      slug = case when v_r ? 'slug' then v_r ->> 'slug' else slug end,
      title = case when v_r ? 'title' then v_r ->> 'title' else title end,
      description = case when v_r ? 'description' then v_r ->> 'description' else description end,
      asks = case when v_r ? 'asks' then array(select jsonb_array_elements_text(v_r -> 'asks')) else asks end,
      why_it_matters = case when v_r ? 'whyItMatters' then v_r ->> 'whyItMatters' else why_it_matters end,
      category = case when v_r ? 'category' then v_r ->> 'category' else category end,
      country = case when v_r ? 'country' then v_r ->> 'country' else country end,
      tags = case when v_r ? 'tags' then array(select jsonb_array_elements_text(v_r -> 'tags')) else tags end,
      regulators = case when v_r ? 'regulators'
                        then array(select jsonb_array_elements_text(v_r -> 'regulators')) else regulators end,
      goal = case when v_r ? 'goal' then (v_r ->> 'goal')::integer else goal end,
      opens_at = case when v_r ? 'opensAt' then (v_r ->> 'opensAt')::timestamptz else opens_at end,
      closes_at = case when v_r ? 'closesAt' then (v_r ->> 'closesAt')::timestamptz else closes_at end
    where public_id = p_public_id and deleted_at is null
    returning public_id into v_id;
    if v_id is null then
      return jsonb_build_object('error', 'NOT_FOUND');
    end if;
  end if;

  perform app.write_audit(p_ctx,
    case when p_public_id is null then 'admin.representation.created' else 'admin.representation.updated' end,
    p_actor_id,
    jsonb_build_object('representation', v_id, 'fields', (select jsonb_agg(k order by k) from jsonb_object_keys(v_r) k)));
  return jsonb_build_object('id', v_id);
end $$;

-- Soft delete: the petition leaves the app; its signatures and history stay.
create or replace function public.app_admin_delete_representation(p_actor_id bigint, p_public_id uuid, p_ctx jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update app.representations set deleted_at = now() where public_id = p_public_id and deleted_at is null;
  if not found then
    return false;
  end if;
  perform app.write_audit(p_ctx, 'admin.representation.deleted', p_actor_id,
    jsonb_build_object('representation', p_public_id));
  return true;
end $$;

-- Moves a petition forward along its track to one of the staff-set statuses (Under Review by GIG
-- onwards); steps may be skipped, never reversed. Moving to Under Review ends signing early.
-- The status trigger records the change; this adds the note, the staff member and the documents
-- (submission pack, regulator response, meeting minutes, ...) to that history entry.
-- Returns { status, previousStatus } or { error: NOT_FOUND | INVALID_TRANSITION | DOCUMENT_INVALID }.
create or replace function public.app_admin_representation_status(
  p_actor_id bigint, p_public_id uuid, p_to_status text, p_note text, p_documents jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_track text[] := array['OPEN', 'CLOSING_SOON', 'CLOSED', 'UNDER_REVIEW', 'SUBMITTED_TO_REGULATOR',
    'MEETING_REQUESTED', 'MEETING_SCHEDULED', 'REGULATOR_RESPONDED', 'RESOLVED'];
  v_r app.representations%rowtype;
  v_current text;
  v_history_id bigint;
begin
  select * into v_r from app.representations where public_id = p_public_id and deleted_at is null for update;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  v_current := app.representation_effective_status(v_r.track_status, v_r.closes_at);
  if coalesce(array_position(v_track, p_to_status), 0) <= 3
     or array_position(v_track, p_to_status) <= array_position(v_track, v_current) then
    return jsonb_build_object('error', 'INVALID_TRANSITION', 'status', v_current);
  end if;
  if not app.admin_documents_in_folder(v_r.public_id, p_documents) then
    return jsonb_build_object('error', 'DOCUMENT_INVALID');
  end if;

  update app.representations set track_status = p_to_status where id = v_r.id;
  update app.representation_status_history set from_status = v_current, note = p_note, actor_id = p_actor_id
  where id = (select max(h.id) from app.representation_status_history h where h.representation_id = v_r.id)
  returning id into v_history_id;
  perform app.admin_add_representation_documents(v_r.id, v_history_id, p_documents);

  perform app.write_audit(p_ctx, 'admin.representation.status_changed', p_actor_id, jsonb_build_object(
    'representation', p_public_id, 'from', v_current, 'to', p_to_status,
    'documents', jsonb_array_length(coalesce(p_documents, '[]'::jsonb))));
  return jsonb_build_object('previousStatus', v_current, 'status', p_to_status);
end $$;

-- Evidence and other documents that do not belong to a track step.
-- Returns { ok } or { error: NOT_FOUND | DOCUMENT_INVALID }.
create or replace function public.app_admin_add_representation_documents(
  p_actor_id bigint, p_public_id uuid, p_documents jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
begin
  select id into v_id from app.representations where public_id = p_public_id and deleted_at is null for update;
  if v_id is null then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if not app.admin_documents_in_folder(p_public_id, p_documents) then
    return jsonb_build_object('error', 'DOCUMENT_INVALID');
  end if;
  perform app.admin_add_representation_documents(v_id, null, p_documents);
  perform app.write_audit(p_ctx, 'admin.representation.documents_added', p_actor_id, jsonb_build_object(
    'representation', p_public_id, 'documents', jsonb_array_length(p_documents)));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Credits
-- ---------------------------------------------------------------------------------------------

-- Grants (delta > 0) or revokes (delta < 0) credits, never below zero. The same Idempotency-Key
-- from the same staff member returns the original entry; with a different request it is refused.
-- Returns { entry, balance, replayed } or { error: NOT_FOUND | SELF_CHANGE | INSUFFICIENT_CREDITS |
-- IDEMPOTENCY_CONFLICT }.
create or replace function public.app_admin_grant_credits(
  p_actor_id bigint, p_public_id uuid, p_delta integer, p_reason text, p_idempotency_key text,
  p_request_hash text, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u app.users%rowtype;
  v_e app.credit_ledger%rowtype;
begin
  select * into v_u from app.users where public_id = p_public_id and status <> 'DELETED' for update;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;

  -- Checked under the user's row lock, so two retries cannot both write.
  select * into v_e from app.credit_ledger where actor_id = p_actor_id and idempotency_key = p_idempotency_key;
  if found then
    if v_e.request_hash is distinct from p_request_hash or v_e.user_id <> v_u.id then
      return jsonb_build_object('error', 'IDEMPOTENCY_CONFLICT');
    end if;
    return jsonb_build_object('replayed', true, 'balance', v_u.credit_balance, 'entry', jsonb_build_object(
      'id', v_e.public_id, 'delta', v_e.delta, 'balanceAfter', v_e.balance_after, 'reason', v_e.reason,
      'refType', v_e.ref_type, 'createdAt', v_e.created_at));
  end if;

  if v_u.id = p_actor_id then
    return jsonb_build_object('error', 'SELF_CHANGE');
  end if;
  if v_u.credit_balance + p_delta < 0 then
    return jsonb_build_object('error', 'INSUFFICIENT_CREDITS', 'balance', v_u.credit_balance);
  end if;

  update app.users set credit_balance = credit_balance + p_delta where id = v_u.id;
  insert into app.credit_ledger (user_id, delta, balance_after, reason, ref_type, actor_id,
    idempotency_key, request_hash)
  values (v_u.id, p_delta, v_u.credit_balance + p_delta, p_reason,
    case when p_delta > 0 then 'ADMIN_GRANT' else 'ADMIN_REVOKE' end, p_actor_id,
    p_idempotency_key, p_request_hash)
  returning * into v_e;

  perform app.write_audit(p_ctx, 'admin.credits.granted', p_actor_id, jsonb_build_object(
    'user', v_u.public_id, 'entry', v_e.public_id, 'delta', p_delta, 'balance', v_e.balance_after));
  return jsonb_build_object('replayed', false, 'balance', v_e.balance_after, 'entry', jsonb_build_object(
    'id', v_e.public_id, 'delta', v_e.delta, 'balanceAfter', v_e.balance_after, 'reason', v_e.reason,
    'refType', v_e.ref_type, 'createdAt', v_e.created_at));
end $$;

-- A user's balance and ledger, newest first. Null when the user does not exist.
create or replace function public.app_admin_user_credits(p_public_id uuid, p_limit integer, p_offset integer)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'balance', u.credit_balance,
    'items', coalesce((
      select jsonb_agg(x.item order by x.created_at desc, x.id desc)
      from (select e.id, e.created_at, jsonb_build_object(
                     'id', e.public_id, 'delta', e.delta, 'balanceAfter', e.balance_after,
                     'reason', e.reason, 'refType', e.ref_type, 'refId', e.ref_id,
                     'actor', case when a.id is null then null
                                   else jsonb_build_object('id', a.public_id, 'name', ap.name) end,
                     'createdAt', e.created_at) as item
            from app.credit_ledger e
            left join app.users a on a.id = e.actor_id
            left join app.user_profiles ap on ap.user_id = a.id
            where e.user_id = u.id
            order by e.created_at desc, e.id desc
            limit p_limit offset p_offset) x), '[]'::jsonb),
    'total', (select count(*) from app.credit_ledger e where e.user_id = u.id))
  from app.users u
  where u.public_id = p_public_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------------------------

-- Newest first. p_action_patterns are LIKE patterns built (and escaped) by the API. p_user
-- matches entries made by the user or about them (metadata "user").
create or replace function public.app_admin_audit_logs(
  p_action_patterns text[], p_user uuid, p_from timestamptz, p_to timestamptz,
  p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with subject as (select id from app.users where public_id = p_user),
  filtered as (
    select a.*
    from app.audit_logs a
    where (coalesce(cardinality(p_action_patterns), 0) = 0 or a.action like any (p_action_patterns))
      and (p_user is null
           or a.actor_user_id = (select id from subject)
           or a.metadata ->> 'user' = p_user::text)
      and (p_from is null or a.occurred_at >= p_from)
      and (p_to is null or a.occurred_at < p_to)
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', f.id::text, 'occurredAt', f.occurred_at, 'action', f.action,
          'actor', case when u.id is null then null
                        else jsonb_build_object('id', u.public_id, 'name', p.name) end,
          'ip', host(f.ip), 'userAgent', f.user_agent, 'requestId', f.request_id,
          'metadata', f.metadata) order by f.occurred_at desc, f.id desc)
      from (select * from filtered order by occurred_at desc, id desc limit p_limit offset p_offset) f
      left join app.users u on u.id = f.actor_user_id
      left join app.user_profiles p on p.user_id = u.id), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------------------------

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
