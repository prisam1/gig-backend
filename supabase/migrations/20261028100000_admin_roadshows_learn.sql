-- Admin: roadshows, roadshow questions and learn content.
-- The admin console manages the tables of the Roadshows and Learn modules
-- (20261027201000_roadshows.sql, 20261027200000_learn_saved_credits_notifications.sql):
--   * roadshows and their financials: create, edit, publish, archive
--   * Ask Me Anything: list a roadshow's questions, publish the issuer's answer, feature questions;
--     questions also join the moderation queue next to reviews and ratings
--   * learn items: create, edit, publish, archive
-- Content is never hard-deleted: "delete" archives it, as the modules' status model intends.
-- Same rules as 20261028090000_admin.sql: public.app_admin_* functions only, every write audited in
-- its own transaction, expected failures returned as { "error": CODE }.

-- Who answered a question and why it was rejected, for the console and the audit trail.
alter table public.roadshow_questions
  add column moderation_note text check (char_length(moderation_note) <= 2000),
  add column answered_by uuid references app.users (public_id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- JSON shapes (app schema, not callable through the API)
-- ---------------------------------------------------------------------------------------------

create or replace function app.admin_roadshow_json(r public.roadshows)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'slug', r.slug, 'title', r.title, 'summary', r.summary,
    'issuer', (select jsonb_build_object('id', i.id, 'name', i.name) from public.issuers i where i.id = r.issuer_id),
    'typeOfIssue', r.type_of_issue, 'instruments', r.instruments, 'noOfInstruments', r.no_of_instruments,
    'offerPrice', r.offer_price::float8, 'currency', r.currency, 'lockIn', r.lock_in, 'maturity', r.maturity,
    'convertibility', r.convertibility, 'callable', r.callable, 'couponRate', r.coupon_rate::float8,
    'riskFactors', to_jsonb(r.risk_factors), 'opensAt', r.opens_at, 'closesAt', r.closes_at,
    'poolEnabled', r.pool_enabled, 'status', r.status, 'publishedAt', r.published_at,
    'isOpen', r.status = 'PUBLISHED' and (r.opens_at is null or r.opens_at <= now()) and now() < r.closes_at,
    'financials', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'fiscalYear', f.fiscal_year, 'revenue', f.revenue::float8, 'ebitda', f.ebitda::float8,
          'netProfit', f.net_profit::float8, 'totalAssets', f.total_assets::float8,
          'totalLiabilities', f.total_liabilities::float8, 'netWorth', f.net_worth::float8,
          'totalDebt', f.total_debt::float8, 'cashAndEquivalents', f.cash_and_equivalents::float8,
          'operatingCashFlow', f.operating_cash_flow::float8, 'eps', f.eps::float8)
          order by f.fiscal_year desc), '[]'::jsonb)
      from public.roadshow_financials f where f.roadshow_id = r.id),
    'documentCount', (select count(*) from public.roadshow_documents d where d.roadshow_id = r.id),
    'poolMembers', (select count(*) from public.pool_members m where m.roadshow_id = r.id),
    'questions', (
      select jsonb_build_object(
        'pending', count(*) filter (where q.status = 'PENDING_MODERATION'),
        'published', count(*) filter (where q.status = 'PUBLISHED'),
        'unanswered', count(*) filter (where q.status <> 'REJECTED' and q.answer is null))
      from public.roadshow_questions q where q.roadshow_id = r.id),
    'createdAt', r.created_at, 'updatedAt', r.updated_at);
$$;

create or replace function app.admin_question_json(q public.roadshow_questions)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', q.id, 'category', q.category, 'question', q.question, 'status', q.status,
    'featured', q.featured, 'moderationNote', q.moderation_note, 'answer', q.answer,
    'answeredAt', q.answered_at,
    'answeredBy', (select jsonb_build_object('id', a.public_id, 'name', ap.name)
                   from app.users a left join app.user_profiles ap on ap.user_id = a.id
                   where a.public_id = q.answered_by),
    'author', (select jsonb_build_object('id', u.public_id, 'name', coalesce(p.name, ''),
                                         'tier', u.tier, 'kycStatus', u.kyc_status)
               from app.users u left join app.user_profiles p on p.user_id = u.id
               where u.public_id = q.user_id),
    'submittedAt', q.created_at, 'updatedAt', q.updated_at);
$$;

create or replace function app.admin_learn_json(l public.learn_items)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', l.id, 'title', l.title, 'summary', l.summary, 'format', l.format, 'category', l.category,
    'access', l.access, 'thumbnailUrl', l.thumbnail_url, 'contentUrl', l.content_url,
    'durationSeconds', l.duration_seconds, 'downloadPath', l.download_path,
    'ratingAvg', l.rating_avg::float8, 'ratingCount', l.rating_count, 'status', l.status,
    'publishedAt', l.published_at, 'createdAt', l.created_at, 'updatedAt', l.updated_at);
$$;

-- ---------------------------------------------------------------------------------------------
-- Roadshows
-- ---------------------------------------------------------------------------------------------

-- Latest closing first. The API leaves ARCHIVED out unless asked for it.
create or replace function public.app_admin_find_roadshows(
  p_q_pattern text, p_issuer_id uuid, p_statuses text[], p_open boolean, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select app.admin_roadshow_json(r) as item,
           row_number() over (order by r.closes_at desc, r.id) as rn
    from public.roadshows r
    where (p_q_pattern is null or lower(r.title || ' ' || r.slug) like p_q_pattern)
      and (p_issuer_id is null or r.issuer_id = p_issuer_id)
      and (coalesce(cardinality(p_statuses), 0) = 0 or r.status::text = any (p_statuses))
      and (p_open is null
           or (r.status = 'PUBLISHED' and (r.opens_at is null or r.opens_at <= now())
               and now() < r.closes_at) = p_open)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

create or replace function public.app_admin_get_roadshow(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.admin_roadshow_json(r) from public.roadshows r where r.id = p_id;
$$;

-- Creates (p_id null) or updates a roadshow; p_roadshow holds only the fields being set.
-- Publishing keeps the first publication time. "financials" replaces every fiscal year.
-- Returns { id } or { error: NOT_FOUND | ISSUER_NOT_FOUND }.
create or replace function public.app_admin_save_roadshow(
  p_actor_id bigint, p_id uuid, p_roadshow jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_r jsonb := p_roadshow;
  v_id uuid;
begin
  if v_r ? 'issuerId' and not exists (
    select 1 from public.issuers where id = (v_r ->> 'issuerId')::uuid and deleted_at is null
  ) then
    return jsonb_build_object('error', 'ISSUER_NOT_FOUND');
  end if;

  if p_id is null then
    insert into public.roadshows (slug, issuer_id, title, summary, type_of_issue, instruments,
      no_of_instruments, offer_price, currency, lock_in, maturity, convertibility, callable, coupon_rate,
      risk_factors, opens_at, closes_at, pool_enabled, status, published_at)
    values (v_r ->> 'slug', (v_r ->> 'issuerId')::uuid, v_r ->> 'title', v_r ->> 'summary',
      v_r ->> 'typeOfIssue', v_r ->> 'instruments', (v_r ->> 'noOfInstruments')::bigint,
      (v_r ->> 'offerPrice')::numeric, coalesce(v_r ->> 'currency', 'INR')::public.currency_code,
      v_r ->> 'lockIn', v_r ->> 'maturity', v_r ->> 'convertibility',
      coalesce((v_r ->> 'callable')::boolean, false), (v_r ->> 'couponRate')::numeric,
      array(select jsonb_array_elements_text(v_r -> 'riskFactors')), (v_r ->> 'opensAt')::timestamptz,
      (v_r ->> 'closesAt')::timestamptz, coalesce((v_r ->> 'poolEnabled')::boolean, false),
      coalesce(v_r ->> 'status', 'DRAFT')::public.content_status,
      case when v_r ->> 'status' = 'PUBLISHED' then now() end)
    returning id into v_id;
  else
    update public.roadshows set
      slug = case when v_r ? 'slug' then v_r ->> 'slug' else slug end,
      issuer_id = case when v_r ? 'issuerId' then (v_r ->> 'issuerId')::uuid else issuer_id end,
      title = case when v_r ? 'title' then v_r ->> 'title' else title end,
      summary = case when v_r ? 'summary' then v_r ->> 'summary' else summary end,
      type_of_issue = case when v_r ? 'typeOfIssue' then v_r ->> 'typeOfIssue' else type_of_issue end,
      instruments = case when v_r ? 'instruments' then v_r ->> 'instruments' else instruments end,
      no_of_instruments = case when v_r ? 'noOfInstruments'
                               then (v_r ->> 'noOfInstruments')::bigint else no_of_instruments end,
      offer_price = case when v_r ? 'offerPrice' then (v_r ->> 'offerPrice')::numeric else offer_price end,
      currency = case when v_r ? 'currency' then (v_r ->> 'currency')::public.currency_code else currency end,
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
      status = case when v_r ? 'status' then (v_r ->> 'status')::public.content_status else status end,
      published_at = case when v_r ->> 'status' = 'PUBLISHED' then coalesce(published_at, now())
                          else published_at end
    where id = p_id
    returning id into v_id;
    if v_id is null then
      return jsonb_build_object('error', 'NOT_FOUND');
    end if;
  end if;

  if v_r ? 'financials' then
    delete from public.roadshow_financials where roadshow_id = v_id;
    insert into public.roadshow_financials (roadshow_id, fiscal_year, revenue, ebitda, net_profit,
      total_assets, total_liabilities, net_worth, total_debt, cash_and_equivalents, operating_cash_flow, eps)
    select v_id, (f ->> 'fiscalYear')::smallint, (f ->> 'revenue')::numeric, (f ->> 'ebitda')::numeric,
           (f ->> 'netProfit')::numeric, (f ->> 'totalAssets')::numeric, (f ->> 'totalLiabilities')::numeric,
           (f ->> 'netWorth')::numeric, (f ->> 'totalDebt')::numeric, (f ->> 'cashAndEquivalents')::numeric,
           (f ->> 'operatingCashFlow')::numeric, (f ->> 'eps')::numeric
    from jsonb_array_elements(v_r -> 'financials') f;
  end if;

  perform app.write_audit(p_ctx,
    case when p_id is null then 'admin.roadshow.created' else 'admin.roadshow.updated' end, p_actor_id,
    jsonb_build_object('roadshow', v_id, 'fields', (select jsonb_agg(k order by k) from jsonb_object_keys(v_r) k)));
  return jsonb_build_object('id', v_id);
end $$;

-- "Delete" archives: the roadshow leaves the app; its pool, offers and questions stay.
create or replace function public.app_admin_archive_roadshow(p_actor_id bigint, p_id uuid, p_ctx jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.roadshows set status = 'ARCHIVED' where id = p_id and status <> 'ARCHIVED';
  if not found then
    return false;
  end if;
  perform app.write_audit(p_ctx, 'admin.roadshow.archived', p_actor_id, jsonb_build_object('roadshow', p_id));
  return true;
end $$;

-- A roadshow's questions, oldest first. Null when the roadshow does not exist.
create or replace function public.app_admin_roadshow_questions(
  p_id uuid, p_statuses text[], p_categories text[], p_answered boolean, p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select app.admin_question_json(q) as item, row_number() over (order by q.created_at, q.id) as rn
    from public.roadshow_questions q
    where q.roadshow_id = p_id
      and (coalesce(cardinality(p_statuses), 0) = 0 or q.status::text = any (p_statuses))
      and (coalesce(cardinality(p_categories), 0) = 0 or q.category::text = any (p_categories))
      and (p_answered is null or (q.answer is not null) = p_answered)
  )
  select case when exists (select 1 from public.roadshows r where r.id = p_id) then jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered)) end;
$$;

-- Publishes the issuer's answer (sending it again replaces it) and notifies the asker. Answering a
-- pending question publishes it too; p_featured (null keeps it) picks it for "Top Asked".
-- Rejected questions cannot be answered, nor can staff answer their own question.
-- Returns the question, or { error: NOT_FOUND | INVALID_TRANSITION | OWN_CONTENT }.
create or replace function public.app_admin_answer_question(
  p_actor_id bigint, p_roadshow_id uuid, p_question_id uuid, p_answer text, p_featured boolean, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_q public.roadshow_questions%rowtype;
  v_actor uuid;
  v_title text;
  v_replaced boolean;
begin
  select * into v_q from public.roadshow_questions
  where id = p_question_id and roadshow_id = p_roadshow_id
  for update;
  if not found then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  select public_id into v_actor from app.users where id = p_actor_id;
  if v_q.user_id = v_actor then
    return jsonb_build_object('error', 'OWN_CONTENT');
  end if;
  if v_q.status = 'REJECTED' then
    return jsonb_build_object('error', 'INVALID_TRANSITION', 'status', v_q.status);
  end if;
  v_replaced := v_q.answer is not null;

  update public.roadshow_questions set
    answer = p_answer, answered_at = now(), answered_by = v_actor, status = 'PUBLISHED',
    featured = coalesce(p_featured, featured)
  where id = v_q.id
  returning * into v_q;

  if not v_replaced then
    select title into v_title from public.roadshows where id = p_roadshow_id;
    insert into public.notifications (user_id, type, title, body, data)
    values (v_q.user_id, 'ROADSHOW', 'Your question was answered',
      'The issuer answered your question on ' || v_title || '.',
      jsonb_build_object('roadshowId', p_roadshow_id, 'questionId', v_q.id));
  end if;

  perform app.write_audit(p_ctx, 'admin.roadshow.question_answered', p_actor_id, jsonb_build_object(
    'roadshow', p_roadshow_id, 'question', p_question_id, 'replacedAnswer', v_replaced));
  return app.admin_question_json(v_q);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Learn
-- ---------------------------------------------------------------------------------------------

-- Newest first. The API leaves ARCHIVED out unless asked for it.
create or replace function public.app_admin_find_learn(
  p_q_pattern text, p_formats text[], p_access text[], p_statuses text[], p_limit integer, p_offset integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select app.admin_learn_json(l) as item,
           row_number() over (order by l.created_at desc, l.id) as rn
    from public.learn_items l
    where (p_q_pattern is null or lower(l.title || ' ' || coalesce(l.category, '')) like p_q_pattern)
      and (coalesce(cardinality(p_formats), 0) = 0 or l.format::text = any (p_formats))
      and (coalesce(cardinality(p_access), 0) = 0 or l.access::text = any (p_access))
      and (coalesce(cardinality(p_statuses), 0) = 0 or l.status::text = any (p_statuses))
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by rn) from filtered
                       where rn > p_offset and rn <= p_offset + p_limit), '[]'::jsonb),
    'total', (select count(*) from filtered));
$$;

create or replace function public.app_admin_get_learn(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.admin_learn_json(l) from public.learn_items l where l.id = p_id;
$$;

-- Creates (p_id null) or updates a learn item; p_item holds only the fields being set.
-- Publishing keeps the first publication time. Returns { id } or { error: NOT_FOUND }.
create or replace function public.app_admin_save_learn(
  p_actor_id bigint, p_id uuid, p_item jsonb, p_ctx jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_l jsonb := p_item;
  v_id uuid;
begin
  if p_id is null then
    insert into public.learn_items (title, summary, format, category, access, thumbnail_url, content_url,
      duration_seconds, download_path, status, published_at)
    values (v_l ->> 'title', v_l ->> 'summary', (v_l ->> 'format')::public.learn_format, v_l ->> 'category',
      coalesce(v_l ->> 'access', 'FREE')::public.content_access, v_l ->> 'thumbnailUrl', v_l ->> 'contentUrl',
      (v_l ->> 'durationSeconds')::integer, v_l ->> 'downloadPath',
      coalesce(v_l ->> 'status', 'DRAFT')::public.content_status,
      case when v_l ->> 'status' = 'PUBLISHED' then now() end)
    returning id into v_id;
  else
    update public.learn_items set
      title = case when v_l ? 'title' then v_l ->> 'title' else title end,
      summary = case when v_l ? 'summary' then v_l ->> 'summary' else summary end,
      format = case when v_l ? 'format' then (v_l ->> 'format')::public.learn_format else format end,
      category = case when v_l ? 'category' then v_l ->> 'category' else category end,
      access = case when v_l ? 'access' then (v_l ->> 'access')::public.content_access else access end,
      thumbnail_url = case when v_l ? 'thumbnailUrl' then v_l ->> 'thumbnailUrl' else thumbnail_url end,
      content_url = case when v_l ? 'contentUrl' then v_l ->> 'contentUrl' else content_url end,
      duration_seconds = case when v_l ? 'durationSeconds'
                              then (v_l ->> 'durationSeconds')::integer else duration_seconds end,
      download_path = case when v_l ? 'downloadPath' then v_l ->> 'downloadPath' else download_path end,
      status = case when v_l ? 'status' then (v_l ->> 'status')::public.content_status else status end,
      published_at = case when v_l ->> 'status' = 'PUBLISHED' then coalesce(published_at, now())
                          else published_at end
    where id = p_id
    returning id into v_id;
    if v_id is null then
      return jsonb_build_object('error', 'NOT_FOUND');
    end if;
  end if;

  perform app.write_audit(p_ctx,
    case when p_id is null then 'admin.learn.created' else 'admin.learn.updated' end, p_actor_id,
    jsonb_build_object('learn', v_id, 'fields', (select jsonb_agg(k order by k) from jsonb_object_keys(v_l) k)));
  return jsonb_build_object('id', v_id);
end $$;

-- "Delete" archives: the item leaves the app; its ratings and saves stay.
create or replace function public.app_admin_archive_learn(p_actor_id bigint, p_id uuid, p_ctx jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.learn_items set status = 'ARCHIVED' where id = p_id and status <> 'ARCHIVED';
  if not found then
    return false;
  end if;
  perform app.write_audit(p_ctx, 'admin.learn.archived', p_actor_id, jsonb_build_object('learn', p_id));
  return true;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Moderation: roadshow questions join reviews and ratings
-- ---------------------------------------------------------------------------------------------

-- Questions have three statuses (PENDING_MODERATION, PUBLISHED, REJECTED): APPROVE publishes a
-- pending one, REJECT rejects it, REMOVE takes a published one down (as REJECTED). Askers cannot
-- edit questions, so REQUEST_CHANGES does not apply to them.

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
    select q.created_at, q.id::text, jsonb_build_object(
             'type', 'QUESTION', 'id', q.id, 'receiptNo', null, 'status', q.status,
             'submittedAt', q.created_at, 'moderationNote', q.moderation_note,
             'author', jsonb_build_object('id', q.user_id, 'name', coalesce(p.name, ''),
                                          'tier', u.tier, 'kycStatus', u.kyc_status),
             'subject', jsonb_build_object('type', 'ROADSHOW', 'id', rs.id, 'name', rs.title),
             'summary', jsonb_build_object('category', q.category, 'excerpt', left(q.question, 200),
                                           'answered', q.answer is not null))
    from public.roadshow_questions q
    join public.roadshows rs on rs.id = q.roadshow_id
    left join app.users u on u.public_id = q.user_id
    left join app.user_profiles p on p.user_id = u.id
    where (coalesce(cardinality(p_types), 0) = 0 or 'QUESTION' = any (p_types))
      and (coalesce(cardinality(p_statuses), 0) = 0 or q.status::text = any (p_statuses))
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
    'type', 'QUESTION', 'id', q.id, 'receiptNo', null, 'status', q.status,
    'moderationNote', q.moderation_note, 'submittedAt', q.created_at,
    'publishedAt', case when q.status = 'PUBLISHED' then q.updated_at end,
    'author', jsonb_build_object('id', q.user_id, 'name', coalesce(p.name, ''), 'tier', u.tier,
                                 'kycStatus', u.kyc_status),
    'subject', jsonb_build_object('type', 'ROADSHOW', 'id', rs.id, 'name', rs.title),
    'content', jsonb_build_object('category', q.category, 'question', q.question, 'answer', q.answer,
                                  'answeredAt', q.answered_at, 'featured', q.featured),
    'evidence', '[]'::jsonb,
    'history', '[]'::jsonb)
  from public.roadshow_questions q
  join public.roadshows rs on rs.id = q.roadshow_id
  left join app.users u on u.public_id = q.user_id
  left join app.user_profiles p on p.user_id = u.id
  where p_type = 'QUESTION' and q.id = p_id;
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
    select q.status::text, u.id into v_from, v_author
    from public.roadshow_questions q left join app.users u on u.public_id = q.user_id
    where q.id = p_id
    for update of q;
    -- Questions have no CHANGES_REQUESTED or REMOVED status; a removed question is REJECTED.
    if p_decision = 'REQUEST_CHANGES' then
      v_allowed := array[]::text[];
    end if;
    if v_to = 'REMOVED' then
      v_to := 'REJECTED';
    end if;
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
    update public.roadshow_questions set
      status = v_to::public.question_status,
      moderation_note = p_note
    where id = p_id;
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
