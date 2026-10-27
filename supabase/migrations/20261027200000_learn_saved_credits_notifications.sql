-- Learn, webinars, saved items, credits and notifications. Tables from the plan's
-- "Engagement and ops" domain:
--   learn_items, learn_ratings, webinars, webinar_registrations, saved_items, credit_ledger,
--   notifications, device_tokens
-- Users are referenced by app.users.public_id, like reviews.

-- ---------------------------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------------------------

create type public.content_status as enum ('DRAFT', 'PUBLISHED', 'ARCHIVED');
-- PREMIUM content is for Full members (verified Prive and Institutional).
create type public.content_access as enum ('FREE', 'PREMIUM');
create type public.learn_format as enum ('VIDEO', 'ARTICLE', 'REPORT', 'PODCAST');
-- Representations are added when that module is built.
create type public.saved_entity_type as enum ('COMPANY', 'ISSUER', 'ROADSHOW', 'LEARN_ITEM');
create type public.credit_reason as enum (
  'ADMIN_GRANT', 'ADMIN_REVOKE', 'PURCHASE', 'REFUND', 'POOL_JOIN'
);
create type public.notification_type as enum (
  'SYSTEM', 'CREDITS', 'POOL', 'ROADSHOW', 'WEBINAR', 'REVIEW', 'LEARN'
);
create type public.device_platform as enum ('IOS', 'ANDROID', 'WEB');

-- ---------------------------------------------------------------------------------------------
-- Learn
-- ---------------------------------------------------------------------------------------------

create table public.learn_items (
  id                uuid primary key default gen_random_uuid(),
  title             text not null check (char_length(title) between 2 and 200),
  summary           text check (char_length(summary) <= 2000),
  format            public.learn_format not null,
  category          text check (char_length(category) between 1 and 60),
  access            public.content_access not null default 'FREE',
  thumbnail_url     text,
  -- Stream or article URL. For PREMIUM items it is returned to Full members only.
  content_url       text,
  duration_seconds  integer check (duration_seconds > 0),
  -- Downloadable report in the private "learn-reports" bucket; Full members only.
  download_path     text check (download_path ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'),
  -- Kept in step with learn_ratings by a trigger.
  rating_avg        numeric(3, 2) not null default 0,
  rating_count      integer not null default 0,
  status            public.content_status not null default 'DRAFT',
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (status <> 'PUBLISHED' or published_at is not null)
);

create trigger learn_items_set_updated_at
before update on public.learn_items
for each row execute function public.catalog_set_updated_at();

create index learn_items_feed_idx on public.learn_items (status, published_at desc);
create index learn_items_title_trgm_idx on public.learn_items using gin (title extensions.gin_trgm_ops);

create table public.learn_ratings (
  learn_item_id  uuid not null references public.learn_items (id) on delete cascade,
  user_id        uuid not null references app.users (public_id) on delete cascade,
  rating         smallint not null check (rating between 1 and 5),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (learn_item_id, user_id)
);

create trigger learn_ratings_set_updated_at
before update on public.learn_ratings
for each row execute function public.catalog_set_updated_at();

create or replace function public.learn_ratings_refresh_stats()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_item_id uuid := coalesce(new.learn_item_id, old.learn_item_id);
begin
  update public.learn_items i
  set rating_avg = coalesce(s.avg, 0),
      rating_count = s.n
  from (
    select round(avg(r.rating), 2) as avg, count(*)::integer as n
    from public.learn_ratings r
    where r.learn_item_id = v_item_id
  ) s
  where i.id = v_item_id;
  return null;
end;
$$;

create trigger learn_ratings_refresh_stats
after insert or update or delete on public.learn_ratings
for each row execute function public.learn_ratings_refresh_stats();

-- Reports (PDF) are downloaded through 5-minute signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('learn-reports', 'learn-reports', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Webinars
-- ---------------------------------------------------------------------------------------------

create table public.webinars (
  id                     uuid primary key default gen_random_uuid(),
  title                  text not null check (char_length(title) between 2 and 200),
  description            text check (char_length(description) <= 4000),
  host_name              text check (char_length(host_name) <= 120),
  starts_at              timestamptz not null,
  ends_at                timestamptz not null,
  access                 public.content_access not null default 'FREE',
  -- Shown to registered members only.
  join_url               text,
  recording_url          text,
  -- Observers get recordings after a delay; Full members as soon as there is one.
  observer_recording_at  timestamptz,
  status                 public.content_status not null default 'DRAFT',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (ends_at > starts_at)
);

create trigger webinars_set_updated_at
before update on public.webinars
for each row execute function public.catalog_set_updated_at();

create index webinars_schedule_idx on public.webinars (status, ends_at);

create table public.webinar_registrations (
  webinar_id  uuid not null references public.webinars (id) on delete cascade,
  user_id     uuid not null references app.users (public_id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (webinar_id, user_id)
);

create index webinar_registrations_user_idx on public.webinar_registrations (user_id);

-- ---------------------------------------------------------------------------------------------
-- Saved items
-- ---------------------------------------------------------------------------------------------

-- entity_id points at companies, issuers, roadshows or learn_items per entity_type; the API
-- checks the entity exists before saving it.
create table public.saved_items (
  user_id      uuid not null references app.users (public_id) on delete cascade,
  entity_type  public.saved_entity_type not null,
  entity_id    uuid not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);

create index saved_items_user_recent_idx on public.saved_items (user_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Credits
-- ---------------------------------------------------------------------------------------------

-- Cached balance: always equal to the sum of the user's credit_ledger deltas.
alter table app.users
  add column credit_balance integer not null default 0 check (credit_balance >= 0);

create table public.credit_ledger (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references app.users (public_id) on delete cascade,
  delta          integer not null check (delta <> 0),
  balance_after  integer not null check (balance_after >= 0),
  reason         public.credit_reason not null,
  -- What the credits were spent on or granted for, e.g. ('ROADSHOW', <roadshow id>).
  ref_type       text check (char_length(ref_type) between 1 and 40),
  ref_id         uuid,
  note           text check (char_length(note) <= 400),
  created_at     timestamptz not null default now()
);

create index credit_ledger_user_idx on public.credit_ledger (user_id, id desc);

-- The ledger is append-only. Rows go away only with their user (the foreign-key cascade runs
-- this trigger at depth 2; a direct DELETE or any UPDATE runs it at depth 1).
create or replace function public.credit_ledger_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'CREDIT_LEDGER_APPEND_ONLY';
end;
$$;

create trigger credit_ledger_append_only
before update or delete on public.credit_ledger
for each row execute function public.credit_ledger_append_only();

-- The only way credits change: locks the user, checks the balance cannot go negative, appends to
-- the ledger and updates the cached balance. Raises USER_NOT_FOUND or INSUFFICIENT_CREDITS.
-- Admin grants (later: /admin/credits/grant) call this too, e.g.
--   select public.apply_credit_change('<user public_id>', 5, 'ADMIN_GRANT', null, null, 'Welcome');
create or replace function public.apply_credit_change(
  p_user_id   uuid,
  p_delta     integer,
  p_reason    public.credit_reason,
  p_ref_type  text default null,
  p_ref_id    uuid default null,
  p_note      text default null
)
returns setof public.credit_ledger
language plpgsql
-- Definer rights: the service role cannot read the private app schema directly.
security definer
set search_path = ''
as $$
declare
  v_balance integer;
begin
  select u.credit_balance into v_balance
  from app.users u
  where u.public_id = p_user_id
  for update;

  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;
  if v_balance + p_delta < 0 then
    raise exception 'INSUFFICIENT_CREDITS';
  end if;

  update app.users u set credit_balance = v_balance + p_delta where u.public_id = p_user_id;

  return query
  insert into public.credit_ledger (user_id, delta, balance_after, reason, ref_type, ref_id, note)
  values (p_user_id, p_delta, v_balance + p_delta, p_reason, p_ref_type, p_ref_id, p_note)
  returning *;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Notifications and push devices
-- ---------------------------------------------------------------------------------------------

create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app.users (public_id) on delete cascade,
  type        public.notification_type not null,
  title       text not null check (char_length(title) between 1 and 120),
  body        text not null check (char_length(body) <= 1000),
  -- Deep-link payload for the app, e.g. { "roadshowId": "..." }.
  data        jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index notifications_inbox_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

-- One row per push token. Registering a token again moves it to the signed-in user.
create table public.device_tokens (
  token         text primary key check (char_length(token) between 16 and 4096),
  user_id       uuid not null references app.users (public_id) on delete cascade,
  platform      public.device_platform not null,
  app_version   text check (char_length(app_version) <= 40),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index device_tokens_user_idx on public.device_tokens (user_id);

-- ---------------------------------------------------------------------------------------------
-- Access: the API uses the service role. Block direct access from app clients.
-- ---------------------------------------------------------------------------------------------

alter table public.learn_items enable row level security;
alter table public.learn_ratings enable row level security;
alter table public.webinars enable row level security;
alter table public.webinar_registrations enable row level security;
alter table public.saved_items enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.notifications enable row level security;
alter table public.device_tokens enable row level security;

revoke execute on function
  public.apply_credit_change(uuid, integer, public.credit_reason, text, uuid, text)
from public, anon, authenticated;
