-- Ratings (Phase 1). The 4 tables of the plan's Ratings domain:
--   issuer_ratings, issuer_rating_factors, issuer_rating_risks, issuer_stats
-- An investor rates an issuer (public.issuers, from the catalog) once: an overall score 1-5, a
-- flag for each of the 10 rating factors and exactly 3 of the 12 risk factors. Factor and risk
-- codes are app.lookup_options. Ratings are moderated; only PUBLISHED ratings count towards
-- issuer_stats, which a trigger recomputes whenever a published rating changes.
-- Same rules as the auth migration: private "app" schema, no Data API access, RLS on.

create sequence app.issuer_rating_receipt_seq;

create table app.issuer_ratings (
  id bigint generated always as identity primary key,
  public_id uuid not null unique default gen_random_uuid(),
  receipt_no text not null unique default (
    'GIG-RT-' || to_char(now(), 'YYYY') || '-' ||
    lpad(nextval('app.issuer_rating_receipt_seq')::text, 6, '0')
  ),
  issuer_id uuid not null references public.issuers (id),
  user_id bigint not null references app.users (id) on delete cascade,
  overall_score smallint not null check (overall_score between 1 and 5),
  status text not null default 'PENDING_MODERATION' check (status in (
    'PENDING_MODERATION', 'PUBLISHED', 'CHANGES_REQUESTED', 'REJECTED', 'REMOVED'
  )),
  moderation_note text check (char_length(moderation_note) <= 2000),
  published_at timestamptz,
  -- Idempotency-Key of the submitting request, so a retry returns this rating instead of a copy.
  idempotency_key text check (char_length(idempotency_key) between 8 and 128),
  request_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create trigger issuer_ratings_updated_at before update on app.issuer_ratings
  for each row execute function app.set_updated_at();

-- One active rating per investor and issuer.
create unique index issuer_ratings_one_per_user_idx
  on app.issuer_ratings (issuer_id, user_id)
  where deleted_at is null and status not in ('REJECTED', 'REMOVED');
create unique index issuer_ratings_idempotency_key_idx
  on app.issuer_ratings (user_id, idempotency_key)
  where idempotency_key is not null;
create index issuer_ratings_issuer_status_idx on app.issuer_ratings (issuer_id, status);
create index issuer_ratings_user_idx on app.issuer_ratings (user_id, created_at desc);

create table app.issuer_rating_factors (
  rating_id bigint not null references app.issuer_ratings (id) on delete cascade,
  factor_type text not null default 'RATING_FACTOR' check (factor_type = 'RATING_FACTOR'),
  factor_code text not null,
  flag text not null check (flag in ('POSITIVE', 'NEUTRAL', 'NEGATIVE')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (rating_id, factor_code),
  foreign key (factor_type, factor_code) references app.lookup_options (type, code)
);
create trigger issuer_rating_factors_updated_at before update on app.issuer_rating_factors
  for each row execute function app.set_updated_at();

create table app.issuer_rating_risks (
  rating_id bigint not null references app.issuer_ratings (id) on delete cascade,
  risk_type text not null default 'RISK_FACTOR' check (risk_type = 'RISK_FACTOR'),
  risk_code text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (rating_id, risk_code),
  foreign key (risk_type, risk_code) references app.lookup_options (type, code)
);
create trigger issuer_rating_risks_updated_at before update on app.issuer_rating_risks
  for each row execute function app.set_updated_at();

-- Public numbers per issuer, from published ratings only.
create table app.issuer_stats (
  issuer_id uuid primary key references public.issuers (id) on delete cascade,
  rating_count integer not null default 0,
  average_score numeric(3, 2) not null default 0,
  -- Weighted mean: 1.0 for new ratings, decaying linearly to 0.5 at 24 months.
  weighted_score numeric(3, 2) not null default 0,
  -- {"1": n, "2": n, "3": n, "4": n, "5": n}
  score_distribution jsonb not null default '{}'::jsonb,
  -- {"<factor code>": {"POSITIVE": pct, "NEUTRAL": pct, "NEGATIVE": pct}}
  factor_breakdown jsonb not null default '{}'::jsonb,
  -- {"<risk code>": number of ratings that picked it}
  risk_counts jsonb not null default '{}'::jsonb,
  last_rating_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger issuer_stats_updated_at before update on app.issuer_stats
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Aggregates
-- ---------------------------------------------------------------------------------------------

create or replace function app.recompute_issuer_stats(p_issuer_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from app.issuer_stats where issuer_id = p_issuer_id;

  insert into app.issuer_stats (
    issuer_id, rating_count, average_score, weighted_score,
    score_distribution, factor_breakdown, risk_counts, last_rating_at
  )
  with published as (
    select r.id, r.overall_score, r.created_at,
           greatest(0.5, 1 - 0.5 * extract(epoch from now() - r.created_at) / (730 * 86400.0))
             as weight
    from app.issuer_ratings r
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
      from app.issuer_rating_factors x
      join published p on p.id = x.rating_id
      group by x.factor_code
    ) f
  ),
  risks as (
    select coalesce(jsonb_object_agg(k.risk_code, k.n), '{}'::jsonb) as value
    from (
      select x.risk_code, count(*)::integer as n
      from app.issuer_rating_risks x
      join published p on p.id = x.rating_id
      group by x.risk_code
    ) k
  )
  select p_issuer_id, agg.n, round(agg.average::numeric, 2), round(agg.weighted::numeric, 2),
         distribution.value, factors.value, risks.value, agg.last_at
  from agg, distribution, factors, risks;
end;
$$;

-- Age-based weighting changes daily, so schedule this nightly (e.g. pg_cron) next to
-- public.recompute_all_company_stats().
create or replace function app.recompute_all_issuer_stats()
returns void
language plpgsql
set search_path = ''
as $$
declare
  i record;
begin
  for i in select id from public.issuers where deleted_at is null loop
    perform app.recompute_issuer_stats(i.id);
  end loop;
end;
$$;

create or replace function app.issuer_ratings_refresh_stats()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'PUBLISHED' then
      perform app.recompute_issuer_stats(new.issuer_id);
    end if;
  elsif tg_op = 'DELETE' then
    if old.status = 'PUBLISHED' then
      perform app.recompute_issuer_stats(old.issuer_id);
    end if;
  elsif old.status = 'PUBLISHED' or new.status = 'PUBLISHED' then
    perform app.recompute_issuer_stats(new.issuer_id);
    if old.issuer_id <> new.issuer_id then
      perform app.recompute_issuer_stats(old.issuer_id);
    end if;
  end if;
  return null;
end;
$$;

create trigger issuer_ratings_refresh_stats
after insert or update or delete on app.issuer_ratings
for each row execute function app.issuer_ratings_refresh_stats();

-- ---------------------------------------------------------------------------------------------
-- Read model: catalog issuers with their offer terms and public rating numbers
-- ---------------------------------------------------------------------------------------------

create view app.issuer_cards as
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
left join app.issuer_stats s on s.issuer_id = i.id
where i.deleted_at is null;

alter table app.issuer_ratings enable row level security;
alter table app.issuer_rating_factors enable row level security;
alter table app.issuer_rating_risks enable row level security;
alter table app.issuer_stats enable row level security;
