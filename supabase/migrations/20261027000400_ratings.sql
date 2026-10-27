-- Ratings (Phase 1). The 4 tables of the plan's Ratings domain:
--   issuer_ratings, issuer_rating_factors, issuer_rating_risks, issuer_stats
-- An investor rates an issuer once: an overall score 1-5, a flag for each of the 10 rating
-- factors and exactly 3 of the 12 risk factors. Factor and risk codes live in lookup_options.
-- Ratings are moderated; only PUBLISHED ratings count towards issuer_stats, which a trigger
-- recomputes whenever a published rating changes.

create type public.rating_flag as enum ('POSITIVE', 'NEUTRAL', 'NEGATIVE');
create type public.rating_status as enum (
  'PENDING_MODERATION', 'PUBLISHED', 'CHANGES_REQUESTED', 'REJECTED', 'REMOVED'
);

create sequence public.issuer_rating_receipt_seq;

create table public.issuer_ratings (
  id               bigint generated always as identity primary key,
  public_id        uuid not null unique default gen_random_uuid(),
  receipt_no       text not null unique default (
                     'GIG-RT-' || to_char(now(), 'YYYY') || '-' ||
                     lpad(nextval('public.issuer_rating_receipt_seq')::text, 6, '0')
                   ),
  issuer_id        uuid not null references public.issuers (id),
  user_id          bigint not null references public.users (id) on delete cascade,
  overall_score    smallint not null check (overall_score between 1 and 5),
  status           public.rating_status not null default 'PENDING_MODERATION',
  moderation_note  text,
  published_at     timestamptz,
  -- Idempotency-Key of the submitting request, so a retry returns this rating instead of a copy.
  idempotency_key  text check (char_length(idempotency_key) between 8 and 128),
  request_hash     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create trigger issuer_ratings_updated_at before update on public.issuer_ratings
  for each row execute function public.set_updated_at();

-- One active rating per investor and issuer.
create unique index issuer_ratings_one_per_user_idx
  on public.issuer_ratings (issuer_id, user_id)
  where deleted_at is null and status not in ('REJECTED', 'REMOVED');
create unique index issuer_ratings_idempotency_key_idx
  on public.issuer_ratings (user_id, idempotency_key)
  where idempotency_key is not null;
create index issuer_ratings_issuer_status_idx on public.issuer_ratings (issuer_id, status);
create index issuer_ratings_user_idx on public.issuer_ratings (user_id, created_at desc);

create table public.issuer_rating_factors (
  rating_id    bigint not null references public.issuer_ratings (id) on delete cascade,
  factor_type  public.lookup_type not null default 'RATING_FACTOR'
               check (factor_type = 'RATING_FACTOR'),
  factor_code  text not null,
  flag         public.rating_flag not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (rating_id, factor_code),
  foreign key (factor_type, factor_code) references public.lookup_options (type, code)
);

create table public.issuer_rating_risks (
  rating_id  bigint not null references public.issuer_ratings (id) on delete cascade,
  risk_type  public.lookup_type not null default 'RISK_FACTOR' check (risk_type = 'RISK_FACTOR'),
  risk_code  text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (rating_id, risk_code),
  foreign key (risk_type, risk_code) references public.lookup_options (type, code)
);

-- Public numbers per issuer, from published ratings only.
create table public.issuer_stats (
  issuer_id           uuid primary key references public.issuers (id) on delete cascade,
  rating_count        integer not null default 0,
  average_score       numeric(3, 2) not null default 0,
  -- Weighted mean: 1.0 for new ratings, decaying linearly to 0.5 at 24 months.
  weighted_score      numeric(3, 2) not null default 0,
  -- {"1": n, "2": n, "3": n, "4": n, "5": n}
  score_distribution  jsonb not null default '{}'::jsonb,
  -- {"<factor code>": {"POSITIVE": pct, "NEUTRAL": pct, "NEGATIVE": pct}}
  factor_breakdown    jsonb not null default '{}'::jsonb,
  -- {"<risk code>": number of ratings that picked it}
  risk_counts         jsonb not null default '{}'::jsonb,
  last_rating_at      timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger issuer_rating_factors_updated_at before update on public.issuer_rating_factors
  for each row execute function public.set_updated_at();
create trigger issuer_rating_risks_updated_at before update on public.issuer_rating_risks
  for each row execute function public.set_updated_at();
create trigger issuer_stats_updated_at before update on public.issuer_stats
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Aggregates
-- ---------------------------------------------------------------------------------------------

create or replace function public.recompute_issuer_stats(p_issuer_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.issuer_stats where issuer_id = p_issuer_id;

  insert into public.issuer_stats (
    issuer_id, rating_count, average_score, weighted_score,
    score_distribution, factor_breakdown, risk_counts, last_rating_at
  )
  with published as (
    select r.id, r.overall_score, r.created_at,
           greatest(0.5, 1 - 0.5 * extract(epoch from now() - r.created_at) / (730 * 86400.0))
             as weight
    from public.issuer_ratings r
    where r.issuer_id = p_issuer_id and r.status = 'PUBLISHED' and r.deleted_at is null
  ),
  agg as (
    select count(*)::integer as n,
           coalesce(avg(overall_score), 0) as average,
           coalesce(sum(weight * overall_score) / nullif(sum(weight), 0), 0) as weighted,
           max(created_at) as last_at
    from published
  ),
  distribution as (
    select jsonb_object_agg(s::text, coalesce(c.n, 0)) as value
    from generate_series(1, 5) as s
    left join (
      select overall_score, count(*)::integer as n from published group by overall_score
    ) c on c.overall_score = s
  ),
  factors as (
    select coalesce(jsonb_object_agg(f.factor_code, jsonb_build_object(
             'POSITIVE', round(100.0 * f.positive / f.total, 2),
             'NEUTRAL',  round(100.0 * f.neutral / f.total, 2),
             'NEGATIVE', round(100.0 * f.negative / f.total, 2))), '{}'::jsonb) as value
    from (
      select x.factor_code,
             count(*) as total,
             count(*) filter (where x.flag = 'POSITIVE') as positive,
             count(*) filter (where x.flag = 'NEUTRAL') as neutral,
             count(*) filter (where x.flag = 'NEGATIVE') as negative
      from public.issuer_rating_factors x
      join published p on p.id = x.rating_id
      group by x.factor_code
    ) f
  ),
  risks as (
    select coalesce(jsonb_object_agg(k.risk_code, k.n), '{}'::jsonb) as value
    from (
      select x.risk_code, count(*)::integer as n
      from public.issuer_rating_risks x
      join published p on p.id = x.rating_id
      group by x.risk_code
    ) k
  )
  select p_issuer_id, agg.n, round(agg.average, 2), round(agg.weighted, 2),
         distribution.value, factors.value, risks.value, agg.last_at
  from agg, distribution, factors, risks;
end;
$$;

-- Age-based weighting changes daily, so schedule this nightly (e.g. pg_cron) next to
-- recompute_all_company_stats().
create or replace function public.recompute_all_issuer_stats()
returns void
language plpgsql
set search_path = ''
as $$
declare
  i record;
begin
  for i in select id from public.issuers where deleted_at is null loop
    perform public.recompute_issuer_stats(i.id);
  end loop;
end;
$$;

create or replace function public.issuer_ratings_refresh_stats()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'PUBLISHED' then
      perform public.recompute_issuer_stats(new.issuer_id);
    end if;
  elsif tg_op = 'DELETE' then
    if old.status = 'PUBLISHED' then
      perform public.recompute_issuer_stats(old.issuer_id);
    end if;
  elsif old.status = 'PUBLISHED' or new.status = 'PUBLISHED' then
    perform public.recompute_issuer_stats(new.issuer_id);
    if old.issuer_id <> new.issuer_id then
      perform public.recompute_issuer_stats(old.issuer_id);
    end if;
  end if;
  return null;
end;
$$;

create trigger issuer_ratings_refresh_stats
after insert or update or delete on public.issuer_ratings
for each row execute function public.issuer_ratings_refresh_stats();

-- ---------------------------------------------------------------------------------------------
-- Read model
-- ---------------------------------------------------------------------------------------------

create view public.issuer_cards with (security_invoker = true) as
select i.id,
       i.slug,
       i.name,
       i.instrument,
       i.asset_type,
       i.exchange,
       i.is_listed,
       i.open_date,
       i.close_date,
       i.min_lot,
       i.lot_unit,
       i.price_min,
       i.price_max,
       i.offer_size,
       i.currency,
       i.use_of_funds,
       i.lock_in,
       i.pre_post_ratio,
       i.created_at,
       lower(i.name || ' ' || i.instrument) as search_text,
       array(
         select t.tag from public.issuer_tags t
         where t.issuer_id = i.id
         order by t.sort_order, t.tag
       ) as tags,
       coalesce(s.rating_count, 0) as rating_count,
       coalesce(s.average_score, 0) as average_score
from public.issuers i
left join public.issuer_stats s on s.issuer_id = i.id
where i.deleted_at is null;

-- ---------------------------------------------------------------------------------------------
-- Submit (one transaction)
-- ---------------------------------------------------------------------------------------------

-- Saves a rating with its factor flags and risk factors. The API validates input first; these
-- checks are the backstop:
--   RATING_FACTORS_INCOMPLETE  the factors are not exactly the active RATING_FACTOR options
--   RATING_RISKS_INVALID       not exactly 3 distinct, active RISK_FACTOR options
create or replace function public.submit_issuer_rating(
  p_user_id          bigint,
  p_issuer_id        uuid,
  p_overall_score    integer,
  p_factors          jsonb,
  p_risk_codes       text[],
  p_idempotency_key  text,
  p_request_hash     text
)
returns table (public_id uuid, receipt_no text, status public.rating_status, created_at timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_rating public.issuer_ratings;
begin
  if (
    select array_agg(f ->> 'code' order by f ->> 'code')
    from jsonb_array_elements(p_factors) as f
  ) is distinct from (
    select array_agg(o.code order by o.code)
    from public.lookup_options o
    where o.type = 'RATING_FACTOR' and o.active
  ) then
    raise exception 'RATING_FACTORS_INCOMPLETE';
  end if;

  if coalesce(cardinality(p_risk_codes), 0) <> 3
     or (select count(distinct c) from unnest(p_risk_codes) as c) <> 3
     or exists (
       select 1 from unnest(p_risk_codes) as c
       where not exists (
         select 1 from public.lookup_options o
         where o.type = 'RISK_FACTOR' and o.code = c and o.active
       )
     ) then
    raise exception 'RATING_RISKS_INVALID';
  end if;

  insert into public.issuer_ratings (
    issuer_id, user_id, overall_score, idempotency_key, request_hash
  ) values (
    p_issuer_id, p_user_id, p_overall_score, p_idempotency_key, p_request_hash
  )
  returning * into v_rating;

  insert into public.issuer_rating_factors (rating_id, factor_code, flag)
  select v_rating.id, f ->> 'code', (f ->> 'flag')::public.rating_flag
  from jsonb_array_elements(p_factors) as f;

  insert into public.issuer_rating_risks (rating_id, risk_code)
  select v_rating.id, c from unnest(p_risk_codes) as c;

  return query
  select v_rating.public_id, v_rating.receipt_no, v_rating.status, v_rating.created_at;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Access: API (service role) only
-- ---------------------------------------------------------------------------------------------

alter table public.issuer_ratings enable row level security;
alter table public.issuer_rating_factors enable row level security;
alter table public.issuer_rating_risks enable row level security;
alter table public.issuer_stats enable row level security;

revoke all on public.issuer_cards from anon, authenticated;

revoke execute on function
  public.recompute_issuer_stats(uuid),
  public.recompute_all_issuer_stats(),
  public.submit_issuer_rating(bigint, uuid, integer, jsonb, text[], text, text)
from public, anon, authenticated;
