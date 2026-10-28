-- Admin: roadshows, roadshow questions and learn content.
-- The admin console manages this content before the app-facing modules exist (Phase 1 "Learn" and
-- Phase 2 "Roadshows"), so the core tables of both domains start here; those modules add the
-- investor side (pool members, offers, improvement votes, DD documents, learn ratings).
--   * roadshows + roadshow_financials (one row per fiscal year, 10 metrics)
--   * roadshow_questions: Ask Me Anything, moderated, answered by GIG on the issuer's behalf
--   * learn_items: articles, videos, podcasts, reports and courses, gated by tier
-- Questions join the moderation queue next to reviews and ratings.
-- Same rules as 20261028090000_admin.sql: private "app" schema, public.app_admin_* functions only,
-- every write audited in its own transaction, expected failures returned as { "error": CODE }.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table app.roadshows (
  id bigint generated always as identity primary key,
  public_id uuid not null unique default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  issuer_id uuid not null references public.issuers (id),
  title text not null check (char_length(title) between 5 and 200),
  summary text not null default '' check (char_length(summary) <= 2000),
  -- Issue summary
  type_of_issue text not null check (char_length(type_of_issue) between 1 and 60),
  instruments text not null check (char_length(instruments) between 1 and 60),
  no_of_instruments bigint check (no_of_instruments > 0),
  offer_price numeric(18, 2) check (offer_price >= 0),
  -- The issuer's reporting currency: offer price and financials are stored in it.
  currency char(3) not null default 'INR' check (currency in ('INR', 'USD', 'EUR', 'GBP', 'AED')),
  lock_in text check (char_length(lock_in) <= 60),
  maturity text check (char_length(maturity) <= 60),
  convertibility text check (char_length(convertibility) <= 60),
  callable boolean not null default false,
  coupon_rate numeric(5, 2) check (coupon_rate between 0 and 100),
  risk_factors text[] not null default '{}' check (cardinality(risk_factors) <= 20),
  opens_at timestamptz not null default now(),
  closes_at timestamptz not null,
  pool_enabled boolean not null default false,
  -- Null while a draft; the app shows only published roadshows.
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (closes_at > opens_at)
);
create trigger roadshows_updated_at before update on app.roadshows
  for each row execute function app.set_updated_at();
create index roadshows_closes_at_idx on app.roadshows (closes_at);
create index roadshows_issuer_idx on app.roadshows (issuer_id);

create table app.roadshow_financials (
  roadshow_id bigint not null references app.roadshows (id) on delete cascade,
  fiscal_year text not null check (fiscal_year ~ '^FY[0-9]{4}$'),
  revenue numeric(18, 2),
  ebitda numeric(18, 2),
  net_profit numeric(18, 2),
  total_assets numeric(18, 2),
  total_liabilities numeric(18, 2),
  net_worth numeric(18, 2),
  total_debt numeric(18, 2),
  operating_cash_flow numeric(18, 2),
  eps numeric(18, 4),
  roe_pct numeric(7, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (roadshow_id, fiscal_year)
);
create trigger roadshow_financials_updated_at before update on app.roadshow_financials
  for each row execute function app.set_updated_at();

-- Ask Me Anything. Questions are moderated like reviews; GIG publishes the issuer's answer.
create table app.roadshow_questions (
  id bigint generated always as identity primary key,
  public_id uuid not null unique default gen_random_uuid(),
  roadshow_id bigint not null references app.roadshows (id) on delete cascade,
  user_id bigint not null references app.users (id) on delete cascade,
  category text not null check (category in ('EQUITY', 'DEBT', 'INSURANCE', 'CRYPTO', 'MUTUAL_FUNDS')),
  question text not null check (char_length(question) between 10 and 1000),
  status text not null default 'PENDING_MODERATION' check (status in (
    'PENDING_MODERATION', 'PUBLISHED', 'CHANGES_REQUESTED', 'REJECTED', 'REMOVED'
  )),
  moderation_note text check (char_length(moderation_note) <= 2000),
  published_at timestamptz,
  answer text check (char_length(answer) between 1 and 4000),
  answered_at timestamptz,
  answered_by bigint references app.users (id) on delete set null,
  credit_spent smallint not null default 0 check (credit_spent >= 0),
  upvote_count integer not null default 0 check (upvote_count >= 0),
  idempotency_key text check (char_length(idempotency_key) between 8 and 128),
  request_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((answer is null) = (answered_at is null))
);
create trigger roadshow_questions_updated_at before update on app.roadshow_questions
  for each row execute function app.set_updated_at();
create index roadshow_questions_feed_idx on app.roadshow_questions (roadshow_id, status, created_at desc);
create unique index roadshow_questions_idempotency_key_idx
  on app.roadshow_questions (user_id, idempotency_key)
  where idempotency_key is not null;

create table app.learn_items (
  id bigint generated always as identity primary key,
  public_id uuid not null unique default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (char_length(title) between 3 and 200),
  summary text not null default '' check (char_length(summary) <= 2000),
  content_type text not null check (content_type in ('ARTICLE', 'VIDEO', 'PODCAST', 'REPORT', 'COURSE')),
  category text check (char_length(category) <= 60),
  tags text[] not null default '{}' check (cardinality(tags) <= 10),
  -- The lowest tier that may open it: premium content and reports are gated.
  min_tier text not null default 'OBSERVER' check (min_tier in ('OBSERVER', 'PRIVE', 'INSTITUTIONAL')),
  -- Downloads are for Prive and Institutional members.
  downloadable boolean not null default false,
  author text check (char_length(author) <= 120),
  thumbnail_url text check (char_length(thumbnail_url) <= 500),
  media_url text check (char_length(media_url) <= 1000),
  body text check (char_length(body) <= 100000),
  duration_seconds integer check (duration_seconds > 0),
  featured boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create trigger learn_items_updated_at before update on app.learn_items
  for each row execute function app.set_updated_at();
create index learn_items_published_idx on app.learn_items (published_at desc) where deleted_at is null;

alter table app.roadshows enable row level security;
alter table app.roadshow_financials enable row level security;
alter table app.roadshow_questions enable row level security;
alter table app.learn_items enable row level security;

-- ---------------------------------------------------------------------------------------------
-- JSON shapes (app schema, not callable through the API)
-- ---------------------------------------------------------------------------------------------

create or replace function app.admin_roadshow_json(r app.roadshows)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.public_id, 'slug', r.slug, 'title', r.title, 'summary', r.summary,
    'issuer', (select jsonb_build_object('id', i.id, 'name', i.name) from public.issuers i where i.id = r.issuer_id),
    'typeOfIssue', r.type_of_issue, 'instruments', r.instruments, 'noOfInstruments', r.no_of_instruments,
    'offerPrice', r.offer_price::float8, 'currency', r.currency, 'lockIn', r.lock_in, 'maturity', r.maturity,
    'convertibility', r.convertibility, 'callable', r.callable, 'couponRate', r.coupon_rate::float8,
    'riskFactors', to_jsonb(r.risk_factors), 'opensAt', r.opens_at, 'closesAt', r.closes_at,
    'poolEnabled', r.pool_enabled, 'isPublished', r.published_at is not null, 'publishedAt', r.published_at,
    'isOpen', r.published_at is not null and r.opens_at <= now() and now() < r.closes_at,
    'financials', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'fiscalYear', f.fiscal_year, 'revenue', f.revenue::float8, 'ebitda', f.ebitda::float8,
          'netProfit', f.net_profit::float8, 'totalAssets', f.total_assets::float8,
          'totalLiabilities', f.total_liabilities::float8, 'netWorth', f.net_worth::float8,
          'totalDebt', f.total_debt::float8, 'operatingCashFlow', f.operating_cash_flow::float8,
          'eps', f.eps::float8, 'roePct', f.roe_pct::float8) order by f.fiscal_year desc), '[]'::jsonb)
      from app.roadshow_financials f where f.roadshow_id = r.id),
    'questions', (
      select jsonb_build_object(
        'pending', count(*) filter (where q.status = 'PENDING_MODERATION'),
        'published', count(*) filter (where q.status = 'PUBLISHED'),
        'unanswered', count(*) filter (where q.status in ('PENDING_MODERATION', 'PUBLISHED') and q.answer is null))
      from app.roadshow_questions q where q.roadshow_id = r.id and q.deleted_at is null),
    'createdAt', r.created_at, 'updatedAt', r.updated_at, 'deletedAt', r.deleted_at);
$$;

create or replace function app.admin_question_json(q app.roadshow_questions)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', q.public_id, 'category', q.category, 'question', q.question, 'status', q.status,
    'moderationNote', q.moderation_note, 'answer', q.answer, 'answeredAt', q.answered_at,
    'answeredBy', (select jsonb_build_object('id', a.public_id, 'name', ap.name)
                   from app.users a left join app.user_profiles ap on ap.user_id = a.id
                   where a.id = q.answered_by),
    'author', (select jsonb_build_object('id', u.public_id, 'name', coalesce(p.name, ''),
                                         'tier', u.tier, 'kycStatus', u.kyc_status)
               from app.users u left join app.user_profiles p on p.user_id = u.id where u.id = q.user_id),
    'creditSpent', q.credit_spent, 'upvoteCount', q.upvote_count,
    'submittedAt', q.created_at, 'publishedAt', q.published_at);
$$;

create or replace function app.admin_learn_json(l app.learn_items)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', l.public_id, 'slug', l.slug, 'title', l.title, 'summary', l.summary,
    'contentType', l.content_type, 'category', l.category, 'tags', to_jsonb(l.tags),
    'minTier', l.min_tier, 'downloadable', l.downloadable, 'author', l.author,
    'thumbnailUrl', l.thumbnail_url, 'mediaUrl', l.media_url, 'body', l.body,
    'durationSeconds', l.duration_seconds, 'featured', l.featured,
    'isPublished', l.published_at is not null, 'publishedAt', l.published_at,
    'createdAt', l.created_at, 'updatedAt', l.updated_at, 'deletedAt', l.deleted_at);
$$;

-- ---------------------------------------------------------------------------------------------
-- Roadshows
-- ---------------------------------------------------------------------------------------------

create or replace function public.app_admin_find_roadshows(
  p_q_pattern text, p_issuer_id uuid, p_published boolean, p_open boolean, p_include_deleted boolean,
  p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select app.admin_roadshow_json(r) as item,
           row_number() over (order by r.closes_at desc, r.id) as rn
    from app.roadshows r
    where (p_include_deleted or r.deleted_at is null)
      and (p_q_pattern is null or lower(r.title || ' ' || r.slug) like p_q_pattern)
      and (p_issuer_id is null or r.issuer_id = p_issuer_id)
      and (p_published is null or (r.published_at is not null) = p_published)
      and (p_open is null
           or (r.published_at is not null and r.opens_at <= now() and now() < r.closes_at) = p_open)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

create or replace function public.app_admin_get_roadshow(p_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.admin_roadshow_json(r) from app.roadshows r where r.public_id = p_public_id;
$$;

-- Creates (p_public_id null) or updates a roadshow; p_roadshow holds only the fields being set.
-- "published" publishes (keeping the first publication time) or returns it to draft; "financials"
-- replaces every fiscal year. Returns { id } or { error: NOT_FOUND | ISSUER_NOT_FOUND }.
create or replace function public.app_admin_save_roadshow(
  p_actor_id bigint, p_public_id uuid, p_roadshow jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_r jsonb := p_roadshow;
  v_id bigint;
  v_public_id uuid;
begin
  if v_r ? 'issuerId' and not exists (
    select 1 from public.issuers where id = (v_r ->> 'issuerId')::uuid and deleted_at is null
  ) then
    return jsonb_build_object('error', 'ISSUER_NOT_FOUND');
  end if;

  if p_public_id is null then
    insert into app.roadshows (slug, issuer_id, title, summary, type_of_issue, instruments,
      no_of_instruments, offer_price, currency, lock_in, maturity, convertibility, callable, coupon_rate,
      risk_factors, opens_at, closes_at, pool_enabled, published_at)
    values (v_r ->> 'slug', (v_r ->> 'issuerId')::uuid, v_r ->> 'title', coalesce(v_r ->> 'summary', ''),
      v_r ->> 'typeOfIssue', v_r ->> 'instruments', (v_r ->> 'noOfInstruments')::bigint,
      (v_r ->> 'offerPrice')::numeric, coalesce(v_r ->> 'currency', 'INR'), v_r ->> 'lockIn',
      v_r ->> 'maturity', v_r ->> 'convertibility', coalesce((v_r ->> 'callable')::boolean, false),
      (v_r ->> 'couponRate')::numeric, array(select jsonb_array_elements_text(v_r -> 'riskFactors')),
      coalesce((v_r ->> 'opensAt')::timestamptz, now()), (v_r ->> 'closesAt')::timestamptz,
      coalesce((v_r ->> 'poolEnabled')::boolean, false),
      case when coalesce((v_r ->> 'published')::boolean, false) then now() end)
    returning id, public_id into v_id, v_public_id;
  else
    update app.roadshows set
      slug = case when v_r ? 'slug' then v_r ->> 'slug' else slug end,
      issuer_id = case when v_r ? 'issuerId' then (v_r ->> 'issuerId')::uuid else issuer_id end,
      title = case when v_r ? 'title' then v_r ->> 'title' else title end,
      summary = case when v_r ? 'summary' then v_r ->> 'summary' else summary end,
      type_of_issue = case when v_r ? 'typeOfIssue' then v_r ->> 'typeOfIssue' else type_of_issue end,
      instruments = case when v_r ? 'instruments' then v_r ->> 'instruments' else instruments end,
      no_of_instruments = case when v_r ? 'noOfInstruments'
                               then (v_r ->> 'noOfInstruments')::bigint else no_of_instruments end,
      offer_price = case when v_r ? 'offerPrice' then (v_r ->> 'offerPrice')::numeric else offer_price end,
      currency = case when v_r ? 'currency' then v_r ->> 'currency' else currency end,
      lock_in = case when v_r ? 'lockIn' then v_r ->> 'lockIn' else lock_in end,
      maturity = case when v_r ? 'maturity' then v_r ->> 'maturity' else maturity end,
      convertibility = case when v_r ? 'convertibility' then v_r ->> 'convertibility' else convertibility end,
      callable = case when v_r ? 'callable' then (v_r ->> 'callable')::boolean else callable end,
      coupon_rate = case when v_r ? 'couponRate' then (v_r ->> 'couponRate')::numeric else coupon_rate end,
      risk_factors = case when v_r ? 'riskFactors'
                          then array(select jsonb_array_elements_text(v_r -> 'riskFactors')) else risk_factors end,
      opens_at = case when v_r ? 'opensAt' then (v_r ->> 'opensAt')::timestamptz else opens_at end,
      closes_at = case when v_r ? 'closesAt' then (v_r ->> 'closesAt')::timestamptz else closes_at end,
      pool_enabled = case when v_r ? 'poolEnabled' then (v_r ->> 'poolEnabled')::boolean else pool_enabled end,
      published_at = case when not (v_r ? 'published') then published_at
                          when (v_r ->> 'published')::boolean then coalesce(published_at, now())
                          else null end
    where public_id = p_public_id and deleted_at is null
    returning id, public_id into v_id, v_public_id;
    if v_id is null then
      return jsonb_build_object('error', 'NOT_FOUND');
    end if;
  end if;

  if v_r ? 'financials' then
    delete from app.roadshow_financials where roadshow_id = v_id;
    insert into app.roadshow_financials (roadshow_id, fiscal_year, revenue, ebitda, net_profit,
      total_assets, total_liabilities, net_worth, total_debt, operating_cash_flow, eps, roe_pct)
    select v_id, f ->> 'fiscalYear', (f ->> 'revenue')::numeric, (f ->> 'ebitda')::numeric,
           (f ->> 'netProfit')::numeric, (f ->> 'totalAssets')::numeric, (f ->> 'totalLiabilities')::numeric,
           (f ->> 'netWorth')::numeric, (f ->> 'totalDebt')::numeric, (f ->> 'operatingCashFlow')::numeric,
           (f ->> 'eps')::numeric, (f ->> 'roePct')::numeric
    from jsonb_array_elements(v_r -> 'financials') f;
  end if;

  perform app.write_audit(p_ctx,
    case when p_public_id is null then 'admin.roadshow.created' else 'admin.roadshow.updated' end, p_actor_id,
    jsonb_build_object('roadshow', v_public_id, 'fields', (select jsonb_agg(k order by k) from jsonb_object_keys(v_r) k)));
  return jsonb_build_object('id', v_public_id);
end $$;

-- Soft delete: the roadshow leaves the app; its questions stay.
create or replace function public.app_admin_delete_roadshow(p_actor_id bigint, p_public_id uuid, p_ctx jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update app.roadshows set deleted_at = now() where public_id = p_public_id and deleted_at is null;
  if not found then
    return false;
  end if;
  perform app.write_audit(p_ctx, 'admin.roadshow.deleted', p_actor_id, jsonb_build_object('roadshow', p_public_id));
  return true;
end $$;

-- A roadshow's questions, oldest first. Null when the roadshow does not exist.
create or replace function public.app_admin_roadshow_questions(
  p_public_id uuid, p_statuses text[], p_categories text[], p_answered boolean, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with roadshow as (select id from app.roadshows where public_id = p_public_id),
  filtered as (
    select app.admin_question_json(q) as item, row_number() over (order by q.created_at, q.id) as rn
    from app.roadshow_questions q
    where q.roadshow_id = (select id from roadshow) and q.deleted_at is null
      and (coalesce(cardinality(p_statuses), 0) = 0 or q.status = any (p_statuses))
      and (coalesce(cardinality(p_categories), 0) = 0 or q.category = any (p_categories))
      and (p_answered is null or (q.answer is not null) = p_answered)
  )
  select case when exists (select 1 from roadshow) then jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered)) end;
$$;

-- Publishes the issuer's answer (or replaces it). Answering a pending question publishes it too;
-- rejected, removed and changes-requested questions cannot be answered, nor can staff answer their
-- own question. Returns the question, or { error: NOT_FOUND | INVALID_TRANSITION | OWN_CONTENT }.
create or replace function public.app_admin_answer_question(
  p_actor_id bigint, p_roadshow_id uuid, p_question_id uuid, p_answer text, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_q app.roadshow_questions%rowtype;
  v_replaced boolean;
begin
  select q.* into v_q
  from app.roadshow_questions q join app.roadshows r on r.id = q.roadshow_id
  where q.public_id = p_question_id and r.public_id = p_roadshow_id
    and q.deleted_at is null and r.deleted_at is null
  for update of q;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  if v_q.user_id = p_actor_id then
    return jsonb_build_object('error', 'OWN_CONTENT');
  end if;
  if v_q.status not in ('PENDING_MODERATION', 'PUBLISHED') then
    return jsonb_build_object('error', 'INVALID_TRANSITION', 'status', v_q.status);
  end if;
  v_replaced := v_q.answer is not null;

  update app.roadshow_questions set
    answer = p_answer, answered_at = now(), answered_by = p_actor_id,
    status = 'PUBLISHED', published_at = coalesce(published_at, now())
  where id = v_q.id
  returning * into v_q;

  perform app.write_audit(p_ctx, 'admin.roadshow.question_answered', p_actor_id, jsonb_build_object(
    'roadshow', p_roadshow_id, 'question', p_question_id, 'replacedAnswer', v_replaced));
  return app.admin_question_json(v_q);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Learn
-- ---------------------------------------------------------------------------------------------

create or replace function public.app_admin_find_learn(
  p_q_pattern text, p_content_types text[], p_min_tiers text[], p_published boolean,
  p_include_deleted boolean, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select app.admin_learn_json(l) as item,
           row_number() over (order by l.created_at desc, l.id) as rn
    from app.learn_items l
    where (p_include_deleted or l.deleted_at is null)
      and (p_q_pattern is null or lower(l.title || ' ' || l.slug || ' ' || coalesce(l.category, '')) like p_q_pattern)
      and (coalesce(cardinality(p_content_types), 0) = 0 or l.content_type = any (p_content_types))
      and (coalesce(cardinality(p_min_tiers), 0) = 0 or l.min_tier = any (p_min_tiers))
      and (p_published is null or (l.published_at is not null) = p_published)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

create or replace function public.app_admin_get_learn(p_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.admin_learn_json(l) from app.learn_items l where l.public_id = p_public_id;
$$;

-- Creates (p_public_id null) or updates a learn item; p_item holds only the fields being set.
-- Returns { id } or { error: NOT_FOUND }.
create or replace function public.app_admin_save_learn(
  p_actor_id bigint, p_public_id uuid, p_item jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_l jsonb := p_item;
  v_public_id uuid;
begin
  if p_public_id is null then
    insert into app.learn_items (slug, title, summary, content_type, category, tags, min_tier,
      downloadable, author, thumbnail_url, media_url, body, duration_seconds, featured, published_at)
    values (v_l ->> 'slug', v_l ->> 'title', coalesce(v_l ->> 'summary', ''), v_l ->> 'contentType',
      v_l ->> 'category', array(select jsonb_array_elements_text(v_l -> 'tags')),
      coalesce(v_l ->> 'minTier', 'OBSERVER'), coalesce((v_l ->> 'downloadable')::boolean, false),
      v_l ->> 'author', v_l ->> 'thumbnailUrl', v_l ->> 'mediaUrl', v_l ->> 'body',
      (v_l ->> 'durationSeconds')::integer, coalesce((v_l ->> 'featured')::boolean, false),
      case when coalesce((v_l ->> 'published')::boolean, false) then now() end)
    returning public_id into v_public_id;
  else
    update app.learn_items set
      slug = case when v_l ? 'slug' then v_l ->> 'slug' else slug end,
      title = case when v_l ? 'title' then v_l ->> 'title' else title end,
      summary = case when v_l ? 'summary' then v_l ->> 'summary' else summary end,
      content_type = case when v_l ? 'contentType' then v_l ->> 'contentType' else content_type end,
      category = case when v_l ? 'category' then v_l ->> 'category' else category end,
      tags = case when v_l ? 'tags' then array(select jsonb_array_elements_text(v_l -> 'tags')) else tags end,
      min_tier = case when v_l ? 'minTier' then v_l ->> 'minTier' else min_tier end,
      downloadable = case when v_l ? 'downloadable' then (v_l ->> 'downloadable')::boolean else downloadable end,
      author = case when v_l ? 'author' then v_l ->> 'author' else author end,
      thumbnail_url = case when v_l ? 'thumbnailUrl' then v_l ->> 'thumbnailUrl' else thumbnail_url end,
      media_url = case when v_l ? 'mediaUrl' then v_l ->> 'mediaUrl' else media_url end,
      body = case when v_l ? 'body' then v_l ->> 'body' else body end,
      duration_seconds = case when v_l ? 'durationSeconds'
                              then (v_l ->> 'durationSeconds')::integer else duration_seconds end,
      featured = case when v_l ? 'featured' then (v_l ->> 'featured')::boolean else featured end,
      published_at = case when not (v_l ? 'published') then published_at
                          when (v_l ->> 'published')::boolean then coalesce(published_at, now())
                          else null end
    where public_id = p_public_id and deleted_at is null
    returning public_id into v_public_id;
    if v_public_id is null then
      return jsonb_build_object('error', 'NOT_FOUND');
    end if;
  end if;

  perform app.write_audit(p_ctx,
    case when p_public_id is null then 'admin.learn.created' else 'admin.learn.updated' end, p_actor_id,
    jsonb_build_object('learn', v_public_id, 'fields', (select jsonb_agg(k order by k) from jsonb_object_keys(v_l) k)));
  return jsonb_build_object('id', v_public_id);
end $$;

create or replace function public.app_admin_delete_learn(p_actor_id bigint, p_public_id uuid, p_ctx jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update app.learn_items set deleted_at = now() where public_id = p_public_id and deleted_at is null;
  if not found then
    return false;
  end if;
  perform app.write_audit(p_ctx, 'admin.learn.deleted', p_actor_id, jsonb_build_object('learn', p_public_id));
  return true;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Moderation: questions join reviews and ratings
-- ---------------------------------------------------------------------------------------------

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
    union all
    select q.created_at, q.public_id::text, jsonb_build_object(
             'type', 'QUESTION', 'id', q.public_id, 'receiptNo', null, 'status', q.status,
             'submittedAt', q.created_at, 'moderationNote', q.moderation_note,
             'author', jsonb_build_object('id', u.public_id, 'name', coalesce(p.name, ''),
                                          'tier', u.tier, 'kycStatus', u.kyc_status),
             'subject', jsonb_build_object('type', 'ROADSHOW', 'id', rs.public_id, 'name', rs.title),
             'summary', jsonb_build_object('category', q.category, 'excerpt', left(q.question, 200),
                                           'answered', q.answer is not null))
    from app.roadshow_questions q
    join app.roadshows rs on rs.id = q.roadshow_id
    join app.users u on u.id = q.user_id
    left join app.user_profiles p on p.user_id = u.id
    where q.deleted_at is null and rs.deleted_at is null
      and (coalesce(cardinality(p_types), 0) = 0 or 'QUESTION' = any (p_types))
      and (coalesce(cardinality(p_statuses), 0) = 0 or q.status = any (p_statuses))
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(x.item order by x.created_at, x.key)
                       from (select * from items order by created_at, key
                             limit p_limit offset p_offset) x), '[]'::jsonb),
    'total', (select count(*) from items));
$$;

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
  where p_type = 'RATING' and ir.public_id = p_id and ir.deleted_at is null
  union all
  select jsonb_build_object(
    'type', 'QUESTION', 'id', q.public_id, 'receiptNo', null, 'status', q.status,
    'moderationNote', q.moderation_note, 'submittedAt', q.created_at, 'publishedAt', q.published_at,
    'author', jsonb_build_object('id', u.public_id, 'name', coalesce(p.name, ''), 'tier', u.tier,
                                 'kycStatus', u.kyc_status),
    'subject', jsonb_build_object('type', 'ROADSHOW', 'id', rs.public_id, 'name', rs.title),
    'content', jsonb_build_object('category', q.category, 'question', q.question, 'answer', q.answer,
                                  'answeredAt', q.answered_at, 'creditSpent', q.credit_spent,
                                  'upvoteCount', q.upvote_count),
    'evidence', '[]'::jsonb,
    'history', '[]'::jsonb)
  from app.roadshow_questions q
  join app.roadshows rs on rs.id = q.roadshow_id
  join app.users u on u.id = q.user_id
  left join app.user_profiles p on p.user_id = u.id
  where p_type = 'QUESTION' and q.public_id = p_id and q.deleted_at is null;
$$;

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
  if v_to is null or p_type not in ('REVIEW', 'RATING', 'QUESTION') then
    raise exception 'invalid moderation % %', p_type, p_decision;
  end if;

  if p_type = 'REVIEW' then
    select r.status::text, u.id into v_from, v_author
    from public.reviews r left join app.users u on u.public_id = r.user_id
    where r.id = p_id and r.deleted_at is null
    for update of r;
  elsif p_type = 'RATING' then
    select r.status, r.user_id into v_from, v_author
    from app.issuer_ratings r
    where r.public_id = p_id and r.deleted_at is null
    for update;
  else
    select q.status, q.user_id into v_from, v_author
    from app.roadshow_questions q
    where q.public_id = p_id and q.deleted_at is null
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
  elsif p_type = 'RATING' then
    update app.issuer_ratings set
      status = v_to,
      moderation_note = p_note,
      published_at = case when v_to = 'PUBLISHED' then coalesce(published_at, now()) else published_at end
    where public_id = p_id;
  else
    update app.roadshow_questions set
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
-- Who may call what
-- ---------------------------------------------------------------------------------------------

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
