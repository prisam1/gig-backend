// Runs the real migration and seed in an in-memory Postgres (PGlite) and checks the database
// rules: constraints, review submission, evidence, stats, trends, feed, search and resolution.

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';

let db: PGlite;

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await db.query<T>(sql, params)).rows;
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  const [row] = await rows<T>(sql, params);
  if (!row) throw new Error(`no row for: ${sql}`);
  return row;
}

async function companyId(slug: string): Promise<string> {
  return (await one<{ id: string }>('select id from public.companies where slug = $1', [slug])).id;
}

interface ReviewInput {
  user?: string;
  author?: string;
  company: string;
  product?: string;
  year?: number | null;
  status?: string;
  sentiment?: 'Positive' | 'Neutral' | 'Negative';
  detailed?: string | null;
  mixed?: string | null;
  negative?: string | null;
  reinvest?: string | null;
  appreciations?: string[];
  concerns?: string[];
  contacts?: string[];
  paths?: string[];
  docTypes?: string[];
  metrics?: [number, number, number, number, number];
  resolution?: string;
  note?: string | null;
  display?: string;
  country?: string;
  assetClass?: string;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}

/** Calls public.submit_review with sensible positive-review defaults. */
async function submit(input: ReviewInput) {
  const sentiment = input.sentiment ?? 'Positive';
  const m = input.metrics ?? [4, 4, 4, 4, 4];
  return one<{ id: string; receipt_no: string; status: string }>(
    `select * from public.submit_review(
       p_user_id => $1, p_idempotency_key => $27, p_request_hash => $28,
       p_author_name => $2, p_company_id => $3, p_country => $4,
       p_asset_class => $5, p_product_scheme => $6, p_investment_year => $7,
       p_investment_status => $8, p_sentiment => $9, p_detailed_review => $10,
       p_mixed_review => $11, p_negative_description => $12, p_reinvest_status => $13,
       p_appreciations => $14, p_concerns => $15, p_contact_statuses => $16,
       p_evidence_paths => $17, p_evidence_doc_types => $18,
       p_m_transparency => $19, p_m_responsiveness => $20, p_m_ease_of_process => $21,
       p_m_trustworthiness => $22, p_m_overall_satisfaction => $23,
       p_resolution_status => $24, p_follow_up_note => $25, p_display_mode => $26,
       p_allow_contact => false, p_declarations_version => '2026-10')`,
    [
      input.user ?? ALICE,
      input.author ?? 'Shreya Mehta',
      input.company,
      input.country ?? 'IN',
      input.assetClass ?? 'MF',
      input.product ?? 'Bluechip',
      input.year === undefined ? 2024 : input.year,
      input.status ?? 'CURRENTLY_INVESTED',
      sentiment,
      input.detailed === undefined
        ? sentiment === 'Negative'
          ? null
          : 'A detailed, genuine review.'
        : input.detailed,
      input.mixed === undefined
        ? sentiment === 'Neutral'
          ? 'Some things were mixed.'
          : null
        : input.mixed,
      input.negative === undefined
        ? sentiment === 'Negative'
          ? 'Redemption took 21 days.'
          : null
        : input.negative,
      input.reinvest === undefined ? (sentiment === 'Positive' ? 'YES' : null) : input.reinvest,
      input.appreciations ?? (sentiment === 'Positive' ? ['TIMELY_PAYOUTS'] : []),
      input.concerns ?? (sentiment === 'Negative' ? ['DELAY_IN_RESPONSE'] : []),
      input.contacts ?? (sentiment === 'Negative' ? ['CONTACTED_NO_RESPONSE'] : []),
      input.paths ?? [],
      input.docTypes ?? [],
      ...m,
      input.resolution ?? 'RESOLVED',
      input.note ?? null,
      input.display ?? 'FULL_NAME',
      input.idempotencyKey ?? null,
      input.requestHash ?? null,
    ],
  );
}

let fileSeq = 0;

/** A path in the evidence bucket, inside the owner's folder. */
function evidencePath(owner: string): string {
  fileSeq += 1;
  return `${owner}/statement-${fileSeq}.pdf`;
}

async function publishAll() {
  await db.exec(`update public.reviews set status = 'PUBLISHED', published_at = now()`);
}

async function stats(company: string) {
  return rows<Record<string, unknown>>('select * from public.company_stats where company_id = $1', [
    company,
  ]);
}

async function expectDbError(promise: Promise<unknown>, code: string, message?: RegExp) {
  const error = await promise.then(
    () => null,
    (e: { code?: string; message: string }) => e,
  );
  expect(error, 'expected a database error').not.toBeNull();
  expect(error?.code).toBe(code);
  if (message) expect(error?.message).toMatch(message);
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
  // Reviewers are auth-module users, identified by app.users.public_id.
  await db.exec(`
    insert into app.users (public_id, email_enc, email_hash, phone_country_code, phone_enc, phone_hash,
                           password_hash, email_verified_at, phone_verified_at)
    values ('${ALICE}', 'x', 'alice', '+91', 'x', 'alice', 'x', now(), now()),
           ('${BOB}', 'x', 'bob', '+91', 'x', 'bob', 'x', now(), now())`);
});

afterAll(async () => {
  await db?.close();
});

// Every test starts from the seeded catalog with no reviews.
beforeEach(async () => {
  await db.exec(`
    delete from public.review_versions; delete from public.review_attachments;
    delete from public.review_tags; delete from public.reviews;
    delete from public.company_stats; delete from public.company_trend_points;
  `);
});

describe('schema and seed', () => {
  it("creates exactly the plan's 10 Catalog and Reviews tables, with row level security on", async () => {
    const tables = await rows<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename`,
    );
    expect(tables.map((t) => t.tablename)).toEqual([
      'companies',
      'company_stats',
      'company_tags',
      'company_trend_points',
      'issuer_tags',
      'issuers',
      'review_attachments',
      'review_tags',
      'review_versions',
      'reviews',
    ]);
    expect(tables.every((t) => t.rowsecurity)).toBe(true);
  });

  it('does not depend on a profiles table (owned by the auth module)', async () => {
    expect((await one<{ t: string | null }>(`select to_regclass('public.profiles') as t`)).t).toBe(
      null,
    );
  });

  it('seeds the 5 companies from the app mock data, with ordered tags', async () => {
    const companies = await rows<{ slug: string; asset_class: string; country: string }>(
      'select slug, asset_class, country from public.companies order by slug',
    );
    expect(companies).toEqual([
      { slug: 'astra-mutuals', asset_class: 'MF', country: 'IN' },
      { slug: 'nexa-funds', asset_class: 'MF', country: 'IN' },
      { slug: 'prime-fincorp', asset_class: 'BND', country: 'AE' },
      { slug: 'summit-banking', asset_class: 'BRK', country: 'IN' },
      { slug: 'zenith-capital', asset_class: 'EQ', country: 'AE' },
    ]);
    const card = await one<{ tags: string[] }>(
      `select tags from public.company_cards where slug = 'astra-mutuals'`,
    );
    expect(card.tags).toEqual(['Large CAP Stocks', 'ETF', 'IPO']);
  });

  it('seeds the 7 issuers from the app mock data', async () => {
    const issuers = await rows<{ slug: string; asset_type: string }>(
      'select slug, asset_type from public.issuers order by slug',
    );
    expect(issuers).toHaveLength(7);
    expect(issuers.map((i) => i.asset_type).sort()).toEqual([
      'Bonds',
      'Bonds',
      'Equity',
      'Equity',
      'Equity',
      'InvIT',
      'REIT',
    ]);
    expect(
      await one(
        `select open_date::text, close_date::text, is_listed, min_lot, price_min, price_max,
                offer_size, currency
         from public.issuers where slug = 'sovereign-alpha-yield'`,
      ),
    ).toEqual({
      open_date: '2024-03-25',
      close_date: '2024-03-29',
      is_listed: true,
      min_lot: 45,
      price_min: 310,
      price_max: 325,
      offer_size: 14500000000,
      currency: 'INR',
    });
  });

  it('validates issuers: price range, dates and currency', async () => {
    const insert = (values: string) =>
      db.query(
        `insert into public.issuers (slug, name, instrument, asset_type, ${values.split('|')[0]})
         values ('test-issuer', 'Test Issuer', 'Equity', 'Equity', ${values.split('|')[1]})`,
      );
    await expectDbError(insert('price_min, price_max|100, 90'), '23514');
    await expectDbError(insert(`open_date, close_date|'2024-05-02', '2024-05-01'`), '23514');
    await expectDbError(insert(`currency|'JPY'`), '23514');
  });

  it('keeps issuer tags with their issuer', async () => {
    const issuer = (
      await one<{ id: string }>(`select id from public.issuers where slug = 'fintech-growth-bonds'`)
    ).id;
    await db.query(
      `insert into public.issuer_tags (issuer_id, tag, sort_order) values ($1, 'Fixed', 1)`,
      [issuer],
    );
    await expectDbError(
      db.query(`insert into public.issuer_tags (issuer_id, tag) values ($1, 'Fixed')`, [issuer]),
      '23505',
    );
    await db.query(`delete from public.issuer_tags where issuer_id = $1`, [issuer]);
  });

  it('creates the private evidence bucket (PDF/JPG/PNG, 10 MB)', async () => {
    expect(await one('select * from storage.buckets where id = $1', ['review-evidence'])).toEqual({
      id: 'review-evidence',
      name: 'review-evidence',
      public: false,
      file_size_limit: 10485760,
      allowed_mime_types: ['application/pdf', 'image/jpeg', 'image/png'],
    });
  });
});

describe('submit_review', () => {
  it('stores the review as pending moderation with a receipt number and a SUBMITTED event', async () => {
    const astra = await companyId('astra-mutuals');
    const result = await submit({
      company: astra,
      appreciations: ['TIMELY_PAYOUTS', 'DIGITAL_EXPERIENCE'],
    });

    expect(result.status).toBe('PENDING_MODERATION');
    expect(result.receipt_no).toMatch(new RegExp(`^GIG-RV-${new Date().getFullYear()}-\\d{6}$`));

    const review = await one(
      'select author_name, sentiment, reinvest_status from public.reviews where id = $1',
      [result.id],
    );
    expect(review).toEqual({
      author_name: 'Shreya Mehta',
      sentiment: 'Positive',
      reinvest_status: 'YES',
    });

    const tags = await rows(
      'select tag_type, code from public.review_tags where review_id = $1 order by code',
      [result.id],
    );
    expect(tags).toEqual([
      { tag_type: 'APPRECIATION', code: 'DIGITAL_EXPERIENCE' },
      { tag_type: 'APPRECIATION', code: 'TIMELY_PAYOUTS' },
    ]);

    const versions = await rows(
      'select change_type, to_value, actor_id from public.review_versions where review_id = $1',
      [result.id],
    );
    expect(versions).toEqual([
      { change_type: 'SUBMITTED', to_value: 'PENDING_MODERATION', actor_id: ALICE },
    ]);
  });

  it('gives each review a new, increasing receipt number', async () => {
    const astra = await companyId('astra-mutuals');
    const a = await submit({ company: astra, product: 'One' });
    const b = await submit({ company: astra, product: 'Two' });
    expect(Number(b.receipt_no.slice(-6))).toBe(Number(a.receipt_no.slice(-6)) + 1);
  });

  it('allows one active review per user, company and product (case-insensitive)', async () => {
    const astra = await companyId('astra-mutuals');
    await submit({ company: astra, product: 'Bluechip' });
    await expectDbError(submit({ company: astra, product: 'BLUECHIP' }), '23505');
    // Another user, another product or another company is fine.
    await submit({ company: astra, product: 'Bluechip', user: BOB });
    await submit({ company: astra, product: 'Midcap' });
    await submit({ company: await companyId('nexa-funds'), product: 'Bluechip' });
  });

  it('allows a new review once the previous one was rejected', async () => {
    const astra = await companyId('astra-mutuals');
    const first = await submit({ company: astra });
    await db.query(`update public.reviews set status = 'REJECTED' where id = $1`, [first.id]);
    await submit({ company: astra });
  });

  it('rejects unknown tag codes and codes of the wrong list', async () => {
    const astra = await companyId('astra-mutuals');
    await expectDbError(
      submit({ company: astra, appreciations: ['NOPE'] }),
      '23514',
      /review_tags_code_valid/,
    );
    await expectDbError(
      submit({ company: astra, sentiment: 'Negative', concerns: ['TIMELY_PAYOUTS'] }),
      '23514',
      /review_tags_code_valid/,
    );
  });

  it('stores the Idempotency-Key and refuses it twice for the same user', async () => {
    const astra = await companyId('astra-mutuals');
    const first = await submit({
      company: astra,
      product: 'One',
      idempotencyKey: 'key-00000001',
      requestHash: 'h1',
    });
    expect(
      await one('select idempotency_key, request_hash from public.reviews where id = $1', [
        first.id,
      ]),
    ).toEqual({ idempotency_key: 'key-00000001', request_hash: 'h1' });

    await expectDbError(
      submit({ company: astra, product: 'Two', idempotencyKey: 'key-00000001', requestHash: 'h1' }),
      '23505',
      /reviews_idempotency_key_idx/,
    );
    // Another user may use the same key, and reviews without a key are unaffected.
    await submit({ company: astra, user: BOB, idempotencyKey: 'key-00000001' });
    await submit({ company: astra, product: 'Three' });
    await submit({ company: astra, product: 'Four' });
  });

  it('enforces the per-sentiment required fields', async () => {
    const astra = await companyId('astra-mutuals');
    await expectDbError(
      submit({ company: astra, reinvest: null }),
      '23514',
      /reviews_positive_fields/,
    );
    await expectDbError(
      submit({ company: astra, detailed: null }),
      '23514',
      /reviews_positive_fields/,
    );
    await expectDbError(
      submit({ company: astra, sentiment: 'Neutral', mixed: null }),
      '23514',
      /reviews_neutral_fields/,
    );
    await expectDbError(
      submit({ company: astra, sentiment: 'Negative', negative: null }),
      '23514',
      /reviews_negative_fields/,
    );
  });

  it('enforces text lengths and metric ranges', async () => {
    const astra = await companyId('astra-mutuals');
    await expectDbError(submit({ company: astra, detailed: 'short' }), '23514');
    await expectDbError(submit({ company: astra, detailed: 'x'.repeat(801) }), '23514');
    await expectDbError(submit({ company: astra, note: 'x'.repeat(401) }), '23514');
    await expectDbError(submit({ company: astra, metrics: [0, 4, 4, 4, 4] }), '23514');
    await expectDbError(submit({ company: astra, metrics: [4, 4, 4, 4, 6] }), '23514');
  });

  it('rejects an unknown company', async () => {
    await expectDbError(submit({ company: '00000000-0000-4000-8000-000000000000' }), '23503');
  });

  it('stores "Older" as a null investment year', async () => {
    const r = await submit({ company: await companyId('astra-mutuals'), year: null });
    expect(
      (await one('select investment_year from public.reviews where id = $1', [r.id]))
        .investment_year,
    ).toBe(null);
  });
});

describe('review evidence', () => {
  const negative = async (paths: string[], docTypes: string[], extra: Partial<ReviewInput> = {}) =>
    submit({
      company: await companyId('astra-mutuals'),
      sentiment: 'Negative',
      paths,
      docTypes,
      ...extra,
    });

  it('stores each supporting document with its type', async () => {
    const statement = evidencePath(ALICE);
    const email = evidencePath(ALICE);
    const r = await negative([statement, email], ['STATEMENT', 'EMAIL']);
    expect(
      await rows(
        'select storage_path, doc_type from public.review_attachments where review_id = $1 order by doc_type',
        [r.id],
      ),
    ).toEqual([
      { storage_path: email, doc_type: 'EMAIL' },
      { storage_path: statement, doc_type: 'STATEMENT' },
    ]);
  });

  it("rejects a file in another user's folder", async () => {
    await expectDbError(negative([evidencePath(BOB)], ['EMAIL']), 'P0001', /EVIDENCE_INVALID/);
  });

  it('rejects a file already attached to another review', async () => {
    const path = evidencePath(ALICE);
    await negative([path], ['EMAIL'], { product: 'One' });
    await expectDbError(
      negative([path], ['EMAIL'], { product: 'Two' }),
      'P0001',
      /EVIDENCE_INVALID/,
    );
  });

  it('rejects an unknown document type, a malformed path and mismatched arrays', async () => {
    await expectDbError(negative([evidencePath(ALICE)], ['PHOTO']), '23514');
    await expectDbError(negative([`${ALICE}/a/b.pdf`], ['EMAIL']), '23514');
    await expectDbError(negative([evidencePath(ALICE)], []), 'P0001', /EVIDENCE_INVALID/);
  });

  it('rolls back the whole review when evidence is invalid', async () => {
    await negative([evidencePath(BOB)], ['EMAIL']).catch(() => null);
    expect((await one<{ n: number }>('select count(*)::int as n from public.reviews')).n).toBe(0);
  });
});

describe('company stats', () => {
  it('ignores reviews until they are published', async () => {
    const astra = await companyId('astra-mutuals');
    await submit({ company: astra });
    expect(await stats(astra)).toEqual([]);
    const card = await one('select review_count, score from public.company_cards where id = $1', [
      astra,
    ]);
    expect(card).toEqual({ review_count: 0, score: 0 });
  });

  it('computes counts, sentiment split, 5-metric averages and resolution lens', async () => {
    const astra = await companyId('astra-mutuals');
    await submit({
      company: astra,
      product: 'P1',
      metrics: [5, 5, 5, 5, 5],
      resolution: 'RESOLVED',
    });
    await submit({
      company: astra,
      product: 'P2',
      metrics: [3, 3, 3, 3, 3],
      resolution: 'IN_PROGRESS',
    });
    await submit({
      company: astra,
      product: 'P3',
      sentiment: 'Neutral',
      metrics: [4, 2, 4, 2, 4],
      resolution: 'CONTACTED',
    });
    await submit({
      company: astra,
      product: 'P4',
      sentiment: 'Negative',
      metrics: [1, 1, 1, 1, 1],
      resolution: 'NOT_CONTACTED',
    });
    await publishAll();

    const [s] = await stats(astra);
    expect(s).toMatchObject({
      review_count: 4,
      positive_pct: 50,
      neutral_pct: 25,
      negative_pct: 25,
      dominant_sentiment: 'Positive',
      avg_transparency: 3.25,
      avg_responsiveness: 2.75,
      avg_ease_of_process: 3.25,
      avg_trustworthiness: 2.75,
      avg_overall_satisfaction: 3.25,
      resolved_pct: 25,
      in_progress_pct: 50,
      unresolved_pct: 0,
      not_contacted_pct: 25,
      dominant_resolution: 'IN_PROGRESS',
      reviews_30d: 4,
    });
    // All reviews are new (weight 1.0), so the score equals the plain average.
    expect(s?.score).toBe(3.25);
  });

  it('weights older reviews less (linear decay to 0.5 at 24 months)', async () => {
    const astra = await companyId('astra-mutuals');
    const recent = await submit({ company: astra, product: 'New', metrics: [5, 5, 5, 5, 5] });
    const old = await submit({ company: astra, product: 'Old', metrics: [1, 1, 1, 1, 1] });
    await db.query(
      `update public.reviews set created_at = now() - interval '730 days' where id = $1`,
      [old.id],
    );
    await publishAll();
    void recent;

    // weights 1.0 and 0.5: (5*1 + 1*0.5) / 1.5 = 3.67
    expect((await stats(astra))[0]?.score).toBe(3.67);
  });

  it('reports the 12-month change in overall satisfaction', async () => {
    const astra = await companyId('astra-mutuals');
    await submit({ company: astra, product: 'New', metrics: [5, 5, 5, 5, 5] });
    const old = await submit({ company: astra, product: 'Old', metrics: [2, 2, 2, 2, 2] });
    await db.query(
      `update public.reviews set created_at = now() - interval '13 months' where id = $1`,
      [old.id],
    );
    await publishAll();
    // all-time average 3.5 vs 2.0 among reviews older than 12 months
    expect((await stats(astra))[0]?.score_change_12m).toBe(1.5);
  });

  it('stores monthly trend points', async () => {
    const astra = await companyId('astra-mutuals');
    await submit({ company: astra, product: 'A', metrics: [5, 5, 5, 5, 5] });
    await submit({ company: astra, product: 'B', sentiment: 'Negative', metrics: [2, 2, 2, 2, 2] });
    const old = await submit({ company: astra, product: 'C', metrics: [4, 4, 4, 4, 4] });
    await db.query(
      `update public.reviews set created_at = date_trunc('month', now()) - interval '2 months' where id = $1`,
      [old.id],
    );
    await publishAll();

    const points = await rows<{
      review_count: number;
      overall_sum: number;
      positive_count: number;
    }>(
      'select review_count, overall_sum, positive_count from public.company_trend_points where company_id = $1 order by month',
      [astra],
    );
    expect(points).toEqual([
      { review_count: 1, overall_sum: 4, positive_count: 1 },
      { review_count: 2, overall_sum: 7, positive_count: 1 },
    ]);
  });

  it('recomputes when a published review is removed', async () => {
    const astra = await companyId('astra-mutuals');
    const r = await submit({ company: astra });
    await publishAll();
    expect((await stats(astra))[0]?.review_count).toBe(1);
    await db.query(`update public.reviews set status = 'REMOVED' where id = $1`, [r.id]);
    expect((await stats(astra))[0]).toMatchObject({
      review_count: 0,
      score: 0,
      dominant_sentiment: null,
    });
  });

  it('maps the 6 resolution statuses to the 4 lens buckets', async () => {
    const mapping = await rows<{ s: string; b: string }>(
      `select s::text, public.resolution_bucket_of(s)::text as b
       from unnest(enum_range(null::public.resolution_status)) s`,
    );
    expect(Object.fromEntries(mapping.map((m) => [m.s, m.b]))).toEqual({
      NOT_CONTACTED: 'NOT_CONTACTED',
      CONTACTED: 'IN_PROGRESS',
      IN_PROGRESS: 'IN_PROGRESS',
      RESOLVED: 'RESOLVED',
      PARTIALLY_RESOLVED: 'IN_PROGRESS',
      CLOSED_UNRESOLVED: 'UNRESOLVED',
    });
  });
});

describe('review_feed (public reviews)', () => {
  it('shows published reviews only', async () => {
    const astra = await companyId('astra-mutuals');
    const pending = await submit({ company: astra, product: 'Pending' });
    const published = await submit({ company: astra, product: 'Published' });
    await db.query(`update public.reviews set status = 'PUBLISHED' where id = $1`, [published.id]);

    const ids = (await rows<{ id: string }>('select id from public.review_feed')).map((r) => r.id);
    expect(ids).toEqual([published.id]);
    expect(ids).not.toContain(pending.id);
  });

  it('shows the author per display mode and never the user id', async () => {
    const astra = await companyId('astra-mutuals');
    await submit({ company: astra, product: 'A', display: 'FULL_NAME' });
    await submit({ company: astra, product: 'B', display: 'INITIALS' });
    await submit({ company: astra, product: 'C', display: 'ANONYMOUS' });
    await submit({ company: astra, product: 'D', display: 'FULL_NAME', author: '   ' });
    await publishAll();

    const feed = await rows<{ product_scheme: string; author_name: string | null }>(
      'select product_scheme, author_name from public.review_feed order by product_scheme',
    );
    expect(feed).toEqual([
      { product_scheme: 'A', author_name: 'Shreya Mehta' },
      { product_scheme: 'B', author_name: 'S. M.' },
      { product_scheme: 'C', author_name: null },
      { product_scheme: 'D', author_name: null },
    ]);
    const columns = await rows<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'review_feed'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('user_id');
  });

  it('includes tags, average rating and resolution bucket', async () => {
    const astra = await companyId('astra-mutuals');
    await submit({
      company: astra,
      sentiment: 'Negative',
      metrics: [2, 1, 2, 2, 2],
      concerns: ['MIS_SELLING', 'DELAY_IN_RESPONSE'],
      contacts: ['IN_DISCUSSION'],
      resolution: 'PARTIALLY_RESOLVED',
    });
    await publishAll();
    expect(
      await one(
        'select avg_rating, resolution_bucket, appreciations, concerns, contact_statuses from public.review_feed',
      ),
    ).toEqual({
      avg_rating: 1.8,
      resolution_bucket: 'IN_PROGRESS',
      appreciations: [],
      concerns: ['DELAY_IN_RESPONSE', 'MIS_SELLING'],
      contact_statuses: ['IN_DISCUSSION'],
    });
  });
});

describe('search_companies (list filters)', () => {
  const names = async (where: string, params: unknown[] = []) =>
    (
      await rows<{ name: string }>(
        `select name from public.search_companies(${where}) order by name`,
        params,
      )
    ).map((r) => r.name);

  beforeEach(async () => {
    const astra = await companyId('astra-mutuals');
    const zenith = await companyId('zenith-capital');
    // Astra: positive, resolved, 2024, currently invested, score 5
    await submit({ company: astra, metrics: [5, 5, 5, 5, 5], resolution: 'RESOLVED', year: 2024 });
    // Zenith: negative, not contacted, older, exited, score 2
    await submit({
      company: zenith,
      sentiment: 'Negative',
      metrics: [2, 2, 2, 2, 2],
      resolution: 'NOT_CONTACTED',
      year: null,
      status: 'EXITED',
    });
    await publishAll();
  });

  it('returns every company without filters', async () => {
    expect(await names('')).toHaveLength(5);
  });

  it('searches company names and tags', async () => {
    expect(await names(`p_q => 'astra'`)).toEqual(['Astra Mutuals']);
    expect(await names(`p_q => 'bonds'`)).toEqual(['Prime Fincorp']);
    expect(await names(`p_q => 'ETF'`)).toEqual(['Astra Mutuals', 'Nexa Funds', 'Zenith Capital']);
  });

  it('filters by sentiment, asset class, resolution, score and country', async () => {
    expect(await names(`p_sentiments => '{Negative}'`)).toEqual(['Zenith Capital']);
    expect(await names(`p_asset_classes => '{BND,BRK}'`)).toEqual([
      'Prime Fincorp',
      'Summit Banking',
    ]);
    expect(await names(`p_resolutions => '{RESOLVED}'`)).toEqual(['Astra Mutuals']);
    expect(await names(`p_scores => '{5}'`)).toEqual(['Astra Mutuals']);
    expect(await names(`p_scores => '{2}'`)).toEqual(['Zenith Capital']);
    expect(await names(`p_countries => '{AE}'`)).toEqual(['Prime Fincorp', 'Zenith Capital']);
  });

  it('filters by investment status and year of published reviews', async () => {
    expect(await names(`p_investment_statuses => '{EXITED}'`)).toEqual(['Zenith Capital']);
    expect(await names(`p_years => '{2024}'`)).toEqual(['Astra Mutuals']);
    expect(await names(`p_years_before => 2021`)).toEqual(['Zenith Capital']);
    expect(await names(`p_years => '{2024}', p_years_before => 2021`)).toEqual([
      'Astra Mutuals',
      'Zenith Capital',
    ]);
  });

  it('combines different filters with AND', async () => {
    expect(await names(`p_countries => '{IN}', p_sentiments => '{Positive}'`)).toEqual([
      'Astra Mutuals',
    ]);
    expect(await names(`p_countries => '{AE}', p_sentiments => '{Positive}'`)).toEqual([]);
  });
});

describe('update_review_resolution', () => {
  async function setup() {
    const r = await submit({
      company: await companyId('astra-mutuals'),
      resolution: 'CONTACTED',
      note: 'Called them',
    });
    return r.id;
  }
  const update = (
    user: string,
    id: string,
    status: string,
    note: string | null,
    setNote: boolean,
  ) =>
    one(`select * from public.update_review_resolution($1, $2, $3, $4, $5)`, [
      user,
      id,
      status,
      note,
      setNote,
    ]);

  it('lets the reviewer change status and note, and records the change', async () => {
    const id = await setup();
    expect(await update(ALICE, id, 'RESOLVED', 'Refund received', true)).toMatchObject({
      id,
      resolution_status: 'RESOLVED',
      follow_up_note: 'Refund received',
    });
    const event = await one(
      `select from_value, to_value, note, actor_id from public.review_versions where change_type = 'RESOLUTION_UPDATED'`,
    );
    expect(event).toEqual({
      from_value: 'CONTACTED',
      to_value: 'RESOLVED',
      note: 'Refund received',
      actor_id: ALICE,
    });
  });

  it('keeps the note when told not to update it, and clears it with null', async () => {
    const id = await setup();
    expect((await update(ALICE, id, 'IN_PROGRESS', null, false)).follow_up_note).toBe(
      'Called them',
    );
    expect((await update(ALICE, id, 'IN_PROGRESS', null, true)).follow_up_note).toBe(null);
  });

  it('refuses anyone but the reviewer', async () => {
    const id = await setup();
    await expectDbError(update(BOB, id, 'RESOLVED', null, false), 'P0001', /REVIEW_NOT_FOUND/);
  });

  it('refuses rejected, removed or deleted reviews', async () => {
    for (const change of ["status = 'REJECTED'", "status = 'REMOVED'", 'deleted_at = now()']) {
      const id = await setup();
      await db.query(`update public.reviews set ${change} where id = $1`, [id]);
      await expectDbError(update(ALICE, id, 'RESOLVED', null, false), 'P0001', /REVIEW_NOT_FOUND/);
      await db.exec(
        'delete from public.review_versions; delete from public.review_tags; delete from public.reviews',
      );
    }
  });

  it('updates the resolution lens of a published review', async () => {
    const astra = await companyId('astra-mutuals');
    const id = await setup();
    await publishAll();
    expect((await stats(astra))[0]).toMatchObject({ resolved_pct: 0, in_progress_pct: 100 });
    await update(ALICE, id, 'RESOLVED', null, false);
    expect((await stats(astra))[0]).toMatchObject({ resolved_pct: 100, in_progress_pct: 0 });
  });
});

describe('helpers', () => {
  it('name_initials builds "S. M." style initials', async () => {
    expect(
      await one(
        `select public.name_initials('  shreya   mehta ') a, public.name_initials('Ravi') b, public.name_initials('') c`,
      ),
    ).toEqual({ a: 'S. M.', b: 'R.', c: null });
  });
});
