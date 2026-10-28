// Runs every migration and the seed in an in-memory Postgres (PGlite) and checks the rules of the
// roadshows and engagement tables: the credit ledger, Power Pool joins, pool power and learn ratings.

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const ALL_EXPECTATIONS = [
  'BETTER_ROI_IRR',
  'SHORTER_LOCK_IN',
  'LOWER_ENTRY_LOAD',
  'LOWER_EXIT_LOAD',
  'PRIORITY_ALLOTMENT',
  'FLEXIBLE_PAYMENT_TERMS',
  'DISCOUNTED_OFFER_PRICE',
  'REGULAR_DISCLOSURES',
];

let db: PGlite;

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await db.query<T>(sql, params)).rows;
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  const [row] = await rows<T>(sql, params);
  if (!row) throw new Error(`no row for: ${sql}`);
  return row;
}

async function expectDbError(promise: Promise<unknown>, message: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as { message: string },
  );
  expect(error, 'expected a database error').not.toBeNull();
  expect(error?.message).toMatch(message);
}

/** A new GIG user (app.users.public_id), optionally with credits granted. */
async function newUser(credits = 0): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into app.users (public_id, email_enc, email_hash, phone_country_code, phone_enc,
                            phone_hash, password_hash, email_verified_at, phone_verified_at)
     values ($1, 'x', $2, '+91', 'x', $2, 'x', now(), now())`,
    [id, id],
  );
  if (credits > 0) await grant(id, credits);
  return id;
}

function grant(user: string, delta: number) {
  return one<{ id: number; balance_after: number }>(
    `select * from public.apply_credit_change($1, $2, 'ADMIN_GRANT')`,
    [user, delta],
  );
}

async function balance(user: string): Promise<number> {
  return (
    await one<{ credit_balance: number }>(
      'select credit_balance from app.users where public_id = $1',
      [user],
    )
  ).credit_balance;
}

async function roadshowId(slug: string): Promise<string> {
  return (await one<{ id: string }>('select id from public.roadshows where slug = $1', [slug])).id;
}

function joinPool(
  user: string,
  roadshow: string,
  capital = 100000,
  expectations = ALL_EXPECTATIONS.slice(0, 3),
  key = `key-${randomUUID()}`,
) {
  return one<{ joined_at: string; credits_remaining: number }>(
    `select * from public.join_roadshow_pool($1, $2, $3, $4::text[]::public.pool_expectation[], $5, 'hash')`,
    [user, roadshow, capital, expectations, key],
  );
}

beforeAll(async () => {
  // NUMERIC (oid 1700) as numbers, the way PostgREST returns them to the API.
  db = new PGlite({ extensions: { pg_trgm }, parsers: { 1700: (value: string) => Number(value) } });
  // Minimal stand-ins for what Supabase provides.
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema extensions; create schema auth; create schema storage;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb);
    create table storage.buckets (id text primary key, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);
  `);
  const dir = join(ROOT, 'supabase', 'migrations');
  for (const file of readdirSync(dir).sort()) {
    await db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  await db.exec(readFileSync(join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
});

afterAll(async () => {
  await db.close();
});

describe('schema and seed', () => {
  it('creates the roadshow and engagement tables with row level security on', async () => {
    const tables = await rows<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables where schemaname = 'public'`,
    );
    const expected = [
      'credit_ledger',
      'device_tokens',
      'fx_rates',
      'learn_items',
      'learn_ratings',
      'notifications',
      'pool_members',
      'roadshow_documents',
      'roadshow_financials',
      'roadshow_improvement_votes',
      'roadshow_offers',
      'roadshow_questions',
      'roadshows',
      'saved_items',
      'webinar_registrations',
      'webinars',
    ];
    expect(tables.map((t) => t.tablename)).toEqual(expect.arrayContaining(expected));
    expect(tables.filter((t) => !t.rowsecurity)).toEqual([]);
  });

  it('seeds published roadshows with 3 years of financials, documents and FX rates', async () => {
    const meridian = await roadshowId('meridian-green-bonds-2026');
    const years = await rows<{ fiscal_year: number }>(
      'select fiscal_year from public.roadshow_financials where roadshow_id = $1 order by 1',
      [meridian],
    );
    expect(years.map((y) => y.fiscal_year)).toEqual([2024, 2025, 2026]);
    const docs = await rows('select 1 from public.roadshow_documents where roadshow_id = $1', [
      meridian,
    ]);
    expect(docs).toHaveLength(2);
    const fx = await rows<{ currency: string }>('select currency from public.fx_rates order by 1');
    expect(fx.map((r) => r.currency)).toEqual(['INR', 'USD', 'EUR', 'GBP', 'AED']);
  });
});

describe('credit ledger', () => {
  it('appends an entry and keeps the cached balance equal to the sum of deltas', async () => {
    const user = await newUser();
    expect((await grant(user, 5)).balance_after).toBe(5);
    expect((await grant(user, -2)).balance_after).toBe(3);
    expect(await balance(user)).toBe(3);
    const sum = await one<{ s: number }>(
      'select sum(delta)::integer as s from public.credit_ledger where user_id = $1',
      [user],
    );
    expect(sum.s).toBe(3);
  });

  it('never lets the balance go below zero', async () => {
    const user = await newUser(1);
    await expectDbError(grant(user, -2), /INSUFFICIENT_CREDITS/);
    expect(await balance(user)).toBe(1);
  });

  it('rejects unknown users', async () => {
    await expectDbError(grant(randomUUID(), 1), /USER_NOT_FOUND/);
  });

  it('is append-only, but its rows are removed with their user', async () => {
    const user = await newUser(2);
    await expectDbError(
      db.query('update public.credit_ledger set delta = 99 where user_id = $1', [user]),
      /CREDIT_LEDGER_APPEND_ONLY/,
    );
    await expectDbError(
      db.query('delete from public.credit_ledger where user_id = $1', [user]),
      /CREDIT_LEDGER_APPEND_ONLY/,
    );
    await db.query('delete from app.users where public_id = $1', [user]);
    expect(await rows('select 1 from public.credit_ledger where user_id = $1', [user])).toEqual([]);
  });
});

describe('join_roadshow_pool', () => {
  it('spends 1 credit and records the membership, expectations and a notification', async () => {
    const user = await newUser(2);
    const roadshow = await roadshowId('meridian-green-bonds-2026');

    const joined = await joinPool(user, roadshow, 250000, [
      'BETTER_ROI_IRR',
      'SHORTER_LOCK_IN',
      'PRIORITY_ALLOTMENT',
      'PRIORITY_ALLOTMENT',
    ]);

    expect(joined.credits_remaining).toBe(1);
    expect(await balance(user)).toBe(1);
    const member = await one<{ capital_interest: number; reason: string; ref_id: string }>(
      `select m.capital_interest, l.reason, l.ref_id
       from public.pool_members m join public.credit_ledger l on l.id = m.ledger_entry_id
       where m.roadshow_id = $1 and m.user_id = $2`,
      [roadshow, user],
    );
    expect(member).toEqual({ capital_interest: 250000, reason: 'POOL_JOIN', ref_id: roadshow });
    const votes = await rows<{ expectation: string }>(
      `select expectation from public.roadshow_improvement_votes
       where roadshow_id = $1 and user_id = $2 order by 1`,
      [roadshow, user],
    );
    expect(votes.map((v) => v.expectation)).toEqual([
      'BETTER_ROI_IRR',
      'SHORTER_LOCK_IN',
      'PRIORITY_ALLOTMENT',
    ]);
    const notes = await rows<{ type: string; data: { roadshowId: string } }>(
      'select type, data from public.notifications where user_id = $1',
      [user],
    );
    expect(notes).toEqual([{ type: 'POOL', data: { roadshowId: roadshow } }]);
  });

  it('is blocked at 0 credits and leaves nothing behind', async () => {
    const user = await newUser();
    const roadshow = await roadshowId('meridian-green-bonds-2026');
    await expectDbError(joinPool(user, roadshow), /INSUFFICIENT_CREDITS/);
    expect(await rows('select 1 from public.pool_members where user_id = $1', [user])).toEqual([]);
    expect(await rows('select 1 from public.notifications where user_id = $1', [user])).toEqual([]);
  });

  it('allows one membership per roadshow and does not charge again', async () => {
    const user = await newUser(3);
    const roadshow = await roadshowId('meridian-green-bonds-2026');
    await joinPool(user, roadshow);
    await expectDbError(joinPool(user, roadshow), /ALREADY_IN_POOL/);
    expect(await balance(user)).toBe(2);
  });

  it('needs at least 3 different expectations', async () => {
    const user = await newUser(1);
    const roadshow = await roadshowId('meridian-green-bonds-2026');
    await expectDbError(
      joinPool(user, roadshow, 1000, ['BETTER_ROI_IRR', 'BETTER_ROI_IRR', 'SHORTER_LOCK_IN']),
      /EXPECTATIONS_INVALID/,
    );
    expect(await balance(user)).toBe(1);
  });

  it('rejects closed, pool-disabled and unpublished roadshows', async () => {
    const user = await newUser(5);
    const issuer = (await one<{ id: string }>('select id from public.issuers limit 1')).id;
    const make = async (slug: string, columns: string) =>
      (
        await one<{ id: string }>(
          `insert into public.roadshows (slug, issuer_id, title, type_of_issue, instruments,
             closes_at, pool_enabled, status, published_at)
           values ($1, $2, 'Test roadshow', 'Public Issue', 'Bonds', ${columns})
           returning id`,
          [slug, issuer],
        )
      ).id;

    const closed = await make('closed-rs', `now() - interval '1 day', true, 'PUBLISHED', now()`);
    const noPool = await make('no-pool-rs', `now() + interval '1 day', false, 'PUBLISHED', now()`);
    const draft = await make('draft-rs', `now() + interval '1 day', true, 'DRAFT', null`);

    await expectDbError(joinPool(user, closed), /ROADSHOW_CLOSED/);
    await expectDbError(joinPool(user, noPool), /POOL_NOT_ENABLED/);
    await expectDbError(joinPool(user, draft), /ROADSHOW_NOT_FOUND/);
    expect(await balance(user)).toBe(5);
  });
});

describe('roadshow_pool_power', () => {
  it('splits members into capital-interest quartiles and counts votes per band', async () => {
    const roadshow = await roadshowId('quantum-biotech-pre-ipo');
    const picks = [
      ['BETTER_ROI_IRR', 'SHORTER_LOCK_IN', 'LOWER_EXIT_LOAD'],
      ['BETTER_ROI_IRR', 'SHORTER_LOCK_IN', 'PRIORITY_ALLOTMENT'],
      ['BETTER_ROI_IRR', 'LOWER_ENTRY_LOAD', 'PRIORITY_ALLOTMENT'],
      ['BETTER_ROI_IRR', 'LOWER_ENTRY_LOAD', 'REGULAR_DISCLOSURES'],
    ];
    for (const [i, expectations] of picks.entries()) {
      await joinPool(await newUser(1), roadshow, (i + 1) * 1000, expectations);
    }

    const power = await rows<{
      band: number;
      band_min: number;
      band_max: number;
      band_members: number;
      band_capital: number;
      expectation: string;
      votes: number;
    }>('select * from public.roadshow_pool_power($1)', [roadshow]);

    // 4 bands x 8 expectations
    expect(power).toHaveLength(32);
    const band1 = power.filter((r) => r.band === 1);
    expect(band1[0]).toMatchObject({ band_min: 1000, band_max: 1000, band_members: 1 });
    expect(band1.filter((r) => r.votes > 0).map((r) => r.expectation)).toEqual([
      'BETTER_ROI_IRR',
      'SHORTER_LOCK_IN',
      'LOWER_EXIT_LOAD',
    ]);
    const roiVotes = power
      .filter((r) => r.expectation === 'BETTER_ROI_IRR')
      .reduce((n, r) => n + r.votes, 0);
    expect(roiVotes).toBe(4);
  });

  it('returns no rows for an empty pool', async () => {
    const issuer = (await one<{ id: string }>('select id from public.issuers limit 1')).id;
    const empty = await one<{ id: string }>(
      `insert into public.roadshows (slug, issuer_id, title, type_of_issue, instruments, closes_at)
       values ('empty-pool-rs', $1, 'Empty', 'Public Issue', 'Bonds', now() + interval '1 day')
       returning id`,
      [issuer],
    );
    expect(await rows('select * from public.roadshow_pool_power($1)', [empty.id])).toEqual([]);
  });
});

describe('learn ratings', () => {
  it('keeps the item average and count in step with ratings', async () => {
    const item = (
      await one<{ id: string }>(`select id from public.learn_items where format = 'VIDEO'`)
    ).id;
    const [a, b] = [await newUser(), await newUser()];
    await db.query(
      'insert into public.learn_ratings (learn_item_id, user_id, rating) values ($1, $2, 5), ($1, $3, 2)',
      [item, a, b],
    );
    const stats = () =>
      one<{ rating_avg: number; rating_count: number }>(
        'select rating_avg, rating_count from public.learn_items where id = $1',
        [item],
      );
    expect(await stats()).toEqual({ rating_avg: 3.5, rating_count: 2 });

    await db.query('update public.learn_ratings set rating = 4 where user_id = $1', [b]);
    expect(await stats()).toEqual({ rating_avg: 4.5, rating_count: 2 });

    await db.query('delete from public.learn_ratings where learn_item_id = $1', [item]);
    expect(await stats()).toEqual({ rating_avg: 0, rating_count: 0 });
  });
});
