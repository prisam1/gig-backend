-- Auth and onboarding (Phase 1)
-- Accounts, sign-up verification, OTP challenges, sessions, profile, preferences, tier selection,
-- consents, audit log and rate limits.

-- Private schema: the backend connects as the database owner. The Supabase Data API roles
-- (anon, authenticated) get no access, so the publishable key cannot read or write these tables.
create schema if not exists app;
revoke all on schema app from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema app from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema app from authenticated';
  end if;
end $$;

create or replace function app.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Option lists (job profiles, focus, risk, styles, sectors). GIG can edit them without a release.
create table app.lookup_options (
  type text not null check (type in (
    'JOB_PROFILE', 'INVESTMENT_FOCUS', 'RISK_LEVEL', 'INVESTMENT_STYLE', 'INVESTMENT_SECTOR'
  )),
  code text not null check (code ~ '^[A-Z0-9_]{1,64}$'),
  label text not null check (char_length(label) between 1 and 120),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (type, code)
);

-- Email and phone are stored encrypted (AES-256-GCM, done by the API) plus a keyed hash used
-- for unique lookups. Plain values never reach the database.
create table app.users (
  id bigint generated always as identity primary key,
  public_id uuid not null unique default gen_random_uuid(),
  email_enc text not null,
  email_hash text not null unique,
  phone_country_code text not null check (phone_country_code in ('+91', '+971')),
  phone_enc text not null,
  phone_hash text not null unique,
  password_hash text not null,
  password_changed_at timestamptz not null default now(),
  tier text not null default 'OBSERVER' check (tier in ('OBSERVER', 'PRIVE', 'INSTITUTIONAL')),
  -- Prive and Institutional are granted only after KYC approval; until then the request waits here.
  requested_tier text check (requested_tier in ('PRIVE', 'INSTITUTIONAL')),
  tier_selected_at timestamptz,
  kyc_status text not null default 'NOT_STARTED'
    check (kyc_status in ('NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'DELETED')),
  email_verified_at timestamptz not null,
  phone_verified_at timestamptz not null,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((status = 'DELETED') = (deleted_at is not null))
);
create trigger users_updated_at before update on app.users
  for each row execute function app.set_updated_at();

create table app.user_profiles (
  user_id bigint primary key references app.users (id) on delete cascade,
  name text not null check (char_length(name) between 4 and 100),
  experience_years smallint check (experience_years between 0 and 80),
  job_profile_type text not null default 'JOB_PROFILE' check (job_profile_type = 'JOB_PROFILE'),
  job_profile_code text,
  other_job text check (char_length(other_job) between 1 and 100),
  location text check (char_length(location) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (job_profile_type, job_profile_code) references app.lookup_options (type, code),
  -- "Others" needs its own text; any other job profile must not carry one.
  check (case when job_profile_code = 'OTHERS' then other_job is not null else other_job is null end)
);
create trigger user_profiles_updated_at before update on app.user_profiles
  for each row execute function app.set_updated_at();

create table app.user_preferences (
  user_id bigint not null references app.users (id) on delete cascade,
  type text not null check (type in ('INVESTMENT_FOCUS', 'RISK_LEVEL', 'INVESTMENT_STYLE', 'INVESTMENT_SECTOR')),
  option_code text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, type, option_code),
  foreign key (type, option_code) references app.lookup_options (type, code)
);

-- Sign-up step 1 waits here until both the email and the phone OTP are verified.
-- Only then is a row created in app.users.
create table app.signup_requests (
  id bigint generated always as identity primary key,
  public_id uuid not null unique default gen_random_uuid(),
  name text not null check (char_length(name) between 4 and 100),
  email_enc text not null,
  email_hash text not null,
  phone_country_code text not null check (phone_country_code in ('+91', '+971')),
  phone_enc text not null,
  phone_hash text not null,
  password_hash text not null,
  age_confirmed_at timestamptz not null,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  completed_at timestamptz,
  user_id bigint references app.users (id) on delete set null,
  created_ip inet,
  user_agent text,
  app_version text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index signup_requests_email_hash_idx on app.signup_requests (email_hash);
create index signup_requests_phone_hash_idx on app.signup_requests (phone_hash);
create trigger signup_requests_updated_at before update on app.signup_requests
  for each row execute function app.set_updated_at();

-- One row per code sent. Codes are stored as keyed hashes. A decoy challenge is created when the
-- email/phone is unknown (login, reset) or already taken (sign-up): it looks identical to the
-- caller but nothing is sent and no code can ever match.
create table app.otp_challenges (
  id bigint generated always as identity primary key,
  public_id uuid not null unique,
  purpose text not null check (purpose in ('SIGNUP', 'LOGIN', 'PASSWORD_RESET')),
  channel text not null check (channel in ('EMAIL', 'PHONE')),
  destination_hash text not null,
  user_id bigint references app.users (id) on delete cascade,
  signup_request_id bigint references app.signup_requests (id) on delete cascade,
  is_decoy boolean not null default false,
  code_hash text not null,
  attempts smallint not null default 0 check (attempts >= 0),
  send_count smallint not null default 1 check (send_count >= 1),
  last_sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_ip inet,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((purpose = 'SIGNUP') = (signup_request_id is not null)),
  check (purpose = 'SIGNUP' or is_decoy or user_id is not null)
);
create index otp_challenges_signup_idx on app.otp_challenges (signup_request_id);
create trigger otp_challenges_updated_at before update on app.otp_challenges
  for each row execute function app.set_updated_at();

create table app.password_reset_tickets (
  id bigint generated always as identity primary key,
  token_hash text not null unique,
  user_id bigint not null references app.users (id) on delete cascade,
  challenge_id bigint not null references app.otp_challenges (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index password_reset_tickets_user_idx on app.password_reset_tickets (user_id);

-- One row per signed-in device. The refresh token is stored as a SHA-256 hash and rotated on
-- every use; presenting the previous token again revokes the session (token theft).
create table app.user_sessions (
  id bigint generated always as identity primary key,
  public_id uuid not null unique,
  user_id bigint not null references app.users (id) on delete cascade,
  refresh_token_hash text not null unique,
  previous_refresh_token_hash text,
  device_name text check (char_length(device_name) between 1 and 100),
  platform text not null default 'OTHER' check (platform in ('IOS', 'ANDROID', 'WEB', 'OTHER')),
  app_version text,
  ip inet,
  user_agent text,
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in (
    'LOGOUT', 'REVOKED_BY_USER', 'PASSWORD_RESET', 'TOKEN_REUSE', 'SESSION_LIMIT', 'ADMIN'
  )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((revoked_at is null) = (revoked_reason is null))
);
create index user_sessions_active_user_idx on app.user_sessions (user_id) where revoked_at is null;
create index user_sessions_previous_hash_idx on app.user_sessions (previous_refresh_token_hash);
create trigger user_sessions_updated_at before update on app.user_sessions
  for each row execute function app.set_updated_at();

create table app.consents (
  id bigint generated always as identity primary key,
  user_id bigint not null references app.users (id) on delete cascade,
  type text not null check (type in ('AGE_18_PLUS')),
  version text not null,
  accepted_at timestamptz not null,
  ip inet,
  user_agent text,
  app_version text,
  created_at timestamptz not null default now()
);
create index consents_user_idx on app.consents (user_id);

create table app.tier_history (
  id bigint generated always as identity primary key,
  user_id bigint not null references app.users (id) on delete cascade,
  from_tier text not null,
  to_tier text not null,
  requested_tier text,
  reason text not null,
  created_at timestamptz not null default now()
);
create index tier_history_user_idx on app.tier_history (user_id);

create table app.audit_logs (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  action text not null,
  actor_user_id bigint,
  ip inet,
  user_agent text,
  request_id text,
  metadata jsonb not null default '{}'
);
create index audit_logs_actor_idx on app.audit_logs (actor_user_id, occurred_at desc);
create index audit_logs_action_idx on app.audit_logs (action, occurred_at desc);

create or replace function app.audit_logs_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_logs is append-only';
end $$;
create trigger audit_logs_no_update before update or delete on app.audit_logs
  for each statement execute function app.audit_logs_append_only();

create table app.rate_limits (
  key text primary key,
  count integer not null,
  expires_at timestamptz not null
);
create index rate_limits_expires_idx on app.rate_limits (expires_at);

-- Defence in depth: RLS on, no policies. Even if the schema were exposed by mistake, the API
-- roles would see nothing. The backend's owner connection is not subject to RLS.
alter table app.lookup_options enable row level security;
alter table app.users enable row level security;
alter table app.user_profiles enable row level security;
alter table app.user_preferences enable row level security;
alter table app.signup_requests enable row level security;
alter table app.otp_challenges enable row level security;
alter table app.password_reset_tickets enable row level security;
alter table app.user_sessions enable row level security;
alter table app.consents enable row level security;
alter table app.tier_history enable row level security;
alter table app.audit_logs enable row level security;
alter table app.rate_limits enable row level security;

-- Removes rows that are past use. The API calls it every 15 minutes.
create or replace function app.purge_expired() returns void
language sql as $$
  delete from app.rate_limits where expires_at < now();
  delete from app.password_reset_tickets where expires_at < now() - interval '1 day';
  delete from app.otp_challenges where expires_at < now() - interval '1 day';
  delete from app.signup_requests where completed_at is null and expires_at < now() - interval '1 day';
  delete from app.user_sessions
    where revoked_at < now() - interval '90 days' or absolute_expires_at < now() - interval '90 days';
$$;

-- Seed option lists from the mobile app (src/constants/Investment.ts). Codes are the labels in
-- UPPER_SNAKE_CASE, with "&" spelled AND.
insert into app.lookup_options (type, code, label, sort_order)
select t.type,
       upper(trim(both '_' from regexp_replace(replace(t.label, '&', 'AND'), '[^A-Za-z0-9]+', '_', 'g'))),
       t.label,
       t.ord
from (
  select 'JOB_PROFILE' as type, label, ord from unnest(array[
    'Business Owner', 'Senior Manager', 'Corporate Professional', 'Advisor', 'Financial Professional',
    'Legal Professional', 'Compliance & Risk Professional', 'Family Office Representative',
    'Institutional Representative', 'Individual Investor', 'High Networth Individual', 'Angel Investor',
    'Venture Capital Participants', 'Private Equity Participant', 'Portfolio Manager', 'Asset Manager',
    'Wealth Manager', 'Research Analyst', 'Market Strategist', 'Economist', 'Financial Educator',
    'Learner/ Educator', 'Advanced Learner', 'Digital Asset Investor', 'Crypto Market Participant',
    'Blockchain Consultant', 'Web3 Professional', 'Student', 'Independent Professional',
    'Aspiring Investor', 'Treasury Managers', 'Fund Operations Manager', 'Capital Markets Professional',
    'Estate Planners', 'Pension Fund Coordinator', 'Structured Finance Professional', 'Founder',
    'Co-Founder', 'Managing Director', 'Chief Executive Officer - CEO', 'Chief Financial Officer - CFO',
    'Chief Investment Officer - CIO', 'Board Members', 'Chief Strategy Officer', 'Independent Directors',
    'Executive Directors', 'Non-Executive Directors', 'Angel Network Members',
    'Risk Management Professionals', 'Others'
  ]) with ordinality as j(label, ord)
  union all
  select 'INVESTMENT_FOCUS', label, ord from unnest(array[
    'Financial Assets', 'Real Assets', 'Commodities', 'Digital Assets', 'Alternative Investments',
    'Derivatives & Trading Instruments', 'Insurance & Retirement', 'Collectibles & Luxury Assets',
    'Business & Ownership', 'Global Investments'
  ]) with ordinality as f(label, ord)
  union all
  select 'RISK_LEVEL', label, ord from unnest(array['Low Level', 'Medium Level', 'High Level'])
    with ordinality as r(label, ord)
  union all
  select 'INVESTMENT_STYLE', label, ord from unnest(array[
    'Active Investing', 'Algorithmic Trading', 'Alternative Investments', 'Arbitrage',
    'Balanced Investing', 'Buy & Hold', 'Capital Appreciation', 'Contrarian Investing', 'Core Investing',
    'Defensive Investing', 'Dividend Investing', 'Distressed Asset Investing', 'ESG Investing',
    'Event Driven Investing', 'Factor Investing', 'Fundamental Investing', 'Global Macro Investing',
    'Growth Investing', 'Hedge Investing', 'High Frequency Trading', 'Impact Investing',
    'Income Investing', 'Index Investing', 'Long-Short Investing', 'Leverage Based Investing',
    'Multi Asset Investing', 'Passive Investing', 'Private Equity Investing', 'Quantitative Investing',
    'Real Asset Investing', 'Sector Rotation', 'Speculative Investing', 'Thematic Investing',
    'Tactical Investing', 'Value Investing', 'Venture Capital Investing', 'Yield Optimization',
    'Knowledge Based Investing', 'Niche Market Investing', 'Private Capital Investing'
  ]) with ordinality as s(label, ord)
  union all
  -- The app lists both "Private Equity" and "Private Equities"; only the first is kept.
  select 'INVESTMENT_SECTOR', label, ord from unnest(array[
    'Healthcare', 'Technology', 'Energy', 'Finance', 'Real Estate', 'Consumer Retail Sector',
    'Automotive', 'Banking', 'Blockchain', 'Aerospace & Defense', 'Chemicals', 'Cybersecurity',
    'Digital Assets', 'E-Commerce', 'Education', 'Entertainment & Media', 'Financial Services',
    'Fintech', 'Gaming & Esports', 'Healthtech', 'Hospitality & Tourism', 'Information Technology',
    'Insurance', 'Logistics', 'Media & Broadcasting', 'Telecommunications', 'Venture Capital',
    'Wealth Management', 'Utilities', 'Robotics & Automation', 'Private Equity', 'Pharmaceuticals',
    'Mining & Metals', 'Data & Analytics', 'Defense Manufacturing', 'Renewable Sources',
    'Shipping & Maritime', 'Agribusiness', 'Textiles & Apparel', 'Others'
  ]) with ordinality as c(label, ord)
) as t;
