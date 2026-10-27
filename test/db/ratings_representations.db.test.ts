// Ratings and Representations: the real migrations and seed in PGlite.

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, createUser, dbError } from './pglite';

const ALICE = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const BOB = 'bbbbbbbb-0000-4000-8000-0000000000b2';

let db: PGlite;
let alice: number;
let bob: number;

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await db.query<T>(sql, params)).rows;
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  const [row] = await rows<T>(sql, params);
  if (!row) throw new Error(`no row for: ${sql}`);
  return row;
}

beforeAll(async () => {
  db = await createTestDatabase();
  alice = await createUser(db, ALICE);
  bob = await createUser(db, BOB);
});

afterAll(async () => {
  await db?.close();
});

// =============================================================================================
// Ratings
// =============================================================================================

const FACTORS = [
  'GENERAL',
  'BUSINESS_OF_COMPANY',
  'INDUSTRY',
  'PROMOTERS',
  'ISSUE_TERMS',
  'OBJECTS_OF_ISSUE',
  'FINANCIAL_HEALTH',
  'TOP_10_SHAREHOLDERS',
  'OUTSTANDING_LITIGATIONS',
  'CONTINGENT_LIABILITIES',
];

type Flag = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

function allFactors(flag: Flag = 'POSITIVE', overrides: Record<string, Flag> = {}) {
  return FACTORS.map((code) => ({ code, flag: overrides[code] ?? flag }));
}

async function issuerId(slug: string): Promise<string> {
  return (await one<{ id: string }>('select id from public.issuers where slug = $1', [slug])).id;
}

interface RatingInput {
  user?: number;
  issuer: string;
  score?: number;
  factors?: { code: string; flag: Flag }[];
  risks?: string[];
  key?: string | null;
}

function rate(input: RatingInput) {
  return one<{ public_id: string; receipt_no: string; status: string }>(
    'select * from public.submit_issuer_rating($1, $2, $3, $4, $5, $6, $7)',
    [
      input.user ?? alice,
      input.issuer,
      input.score ?? 4,
      JSON.stringify(input.factors ?? allFactors()),
      input.risks ?? ['CREDIT', 'MARKET', 'LIQUIDITY'],
      input.key ?? null,
      input.key ? 'hash' : null,
    ],
  );
}

async function issuerStats(issuer: string) {
  return one('select * from public.issuer_stats where issuer_id = $1', [issuer]);
}

describe('ratings: schema and seed', () => {
  it("creates the plan's 4 Ratings tables with row level security", async () => {
    const ratingTables = [
      'issuer_rating_factors',
      'issuer_rating_risks',
      'issuer_ratings',
      'issuer_stats',
    ];
    const tables = await rows<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables
       where schemaname = 'public' and tablename = any ($1) order by tablename`,
      [ratingTables],
    );
    expect(tables).toEqual(ratingTables.map((tablename) => ({ tablename, rowsecurity: true })));
  });

  it('seeds the 10 rating factors and 12 risk factors', async () => {
    const counts = await rows<{ type: string; n: number }>(
      `select type::text, count(*)::int as n from public.lookup_options
       where type in ('RATING_FACTOR', 'RISK_FACTOR') group by type order by type`,
    );
    expect(counts).toEqual([
      { type: 'RATING_FACTOR', n: 10 },
      { type: 'RISK_FACTOR', n: 12 },
    ]);
  });
});

describe('submit_issuer_rating', () => {
  beforeEach(async () => {
    await db.exec('delete from public.issuer_ratings; delete from public.issuer_stats;');
  });

  it('stores the rating, all factor flags and 3 risks, pending moderation, with a receipt number', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    const result = await rate({
      issuer,
      score: 5,
      factors: allFactors('POSITIVE', { PROMOTERS: 'NEGATIVE' }),
    });

    expect(result.status).toBe('PENDING_MODERATION');
    expect(result.receipt_no).toMatch(new RegExp(`^GIG-RT-${new Date().getFullYear()}-\\d{6}$`));

    const rating = await one<{ id: number }>(
      'select id, overall_score from public.issuer_ratings where public_id = $1',
      [result.public_id],
    );
    const flags = await rows<{ factor_code: string; flag: string }>(
      'select factor_code, flag::text from public.issuer_rating_factors where rating_id = $1',
      [rating.id],
    );
    expect(flags).toHaveLength(10);
    expect(flags.find((f) => f.factor_code === 'PROMOTERS')?.flag).toBe('NEGATIVE');
    expect(
      (
        await rows<{ risk_code: string }>(
          'select risk_code from public.issuer_rating_risks where rating_id = $1 order by risk_code',
          [rating.id],
        )
      ).map((r) => r.risk_code),
    ).toEqual(['CREDIT', 'LIQUIDITY', 'MARKET']);
  });

  it('requires a flag for every one of the 10 factors', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    const missingOne = allFactors().slice(1);
    const unknown = [...missingOne, { code: 'NOPE', flag: 'NEUTRAL' as const }];
    for (const factors of [missingOne, unknown]) {
      expect((await dbError(rate({ issuer, factors }))).message).toMatch(
        /RATING_FACTORS_INCOMPLETE/,
      );
    }
  });

  it('requires exactly 3 distinct, known risk factors', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    for (const risks of [
      ['CREDIT', 'MARKET'],
      ['CREDIT', 'MARKET', 'LEGAL', 'FRAUD'],
      ['CREDIT', 'CREDIT', 'MARKET'],
      ['CREDIT', 'MARKET', 'WEATHER'],
    ]) {
      expect((await dbError(rate({ issuer, risks }))).message).toMatch(/RATING_RISKS_INVALID/);
    }
  });

  it('keeps the overall score between 1 and 5', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    expect((await dbError(rate({ issuer, score: 0 }))).code).toBe('23514');
    expect((await dbError(rate({ issuer, score: 6 }))).code).toBe('23514');
  });

  it('allows one active rating per investor and issuer', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    const first = await rate({ issuer });
    const duplicate = await dbError(rate({ issuer }));
    expect(duplicate.code).toBe('23505');
    expect(duplicate.message).toMatch(/issuer_ratings_one_per_user_idx/);

    await rate({ issuer, user: bob });
    await rate({ issuer: await issuerId('nexus-infrastructure-trust') });

    // After rejection the investor may rate again.
    await db.query(`update public.issuer_ratings set status = 'REJECTED' where public_id = $1`, [
      first.public_id,
    ]);
    await rate({ issuer });
  });

  it('refuses an Idempotency-Key used twice by the same investor', async () => {
    await rate({ issuer: await issuerId('sovereign-alpha-yield'), key: 'key-00000001' });
    const error = await dbError(
      rate({ issuer: await issuerId('nexus-infrastructure-trust'), key: 'key-00000001' }),
    );
    expect(error.message).toMatch(/issuer_ratings_idempotency_key_idx/);
  });
});

describe('issuer stats', () => {
  beforeEach(async () => {
    await db.exec('delete from public.issuer_ratings; delete from public.issuer_stats;');
  });

  it('ignores ratings until they are published', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    await rate({ issuer });
    expect(await rows('select * from public.issuer_stats where issuer_id = $1', [issuer])).toEqual(
      [],
    );
    expect(
      await one('select rating_count, average_score from public.issuer_cards where id = $1', [
        issuer,
      ]),
    ).toEqual({ rating_count: 0, average_score: 0 });
  });

  it('computes average, distribution, factor breakdown and risk counts from published ratings', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    await rate({ issuer, score: 5, risks: ['CREDIT', 'MARKET', 'LEGAL'] });
    await rate({
      issuer,
      user: bob,
      score: 2,
      factors: allFactors('NEUTRAL', { GENERAL: 'NEGATIVE' }),
      risks: ['CREDIT', 'FRAUD', 'LEGAL'],
    });
    await db.exec(`update public.issuer_ratings set status = 'PUBLISHED', published_at = now()`);

    const stats = await issuerStats(issuer);
    expect(stats).toMatchObject({
      rating_count: 2,
      average_score: 3.5,
      weighted_score: 3.5,
      score_distribution: { '1': 0, '2': 1, '3': 0, '4': 0, '5': 1 },
      risk_counts: { CREDIT: 2, LEGAL: 2, MARKET: 1, FRAUD: 1 },
    });
    const breakdown = stats.factor_breakdown as Record<string, Record<Flag, number>>;
    expect(Object.keys(breakdown)).toHaveLength(10);
    expect(breakdown.GENERAL).toEqual({ POSITIVE: 50, NEUTRAL: 0, NEGATIVE: 50 });
    expect(breakdown.PROMOTERS).toEqual({ POSITIVE: 50, NEUTRAL: 50, NEGATIVE: 0 });
    expect(
      await one('select rating_count, average_score from public.issuer_cards where id = $1', [
        issuer,
      ]),
    ).toEqual({ rating_count: 2, average_score: 3.5 });
  });

  it('weights older ratings less (linear decay to 0.5 at 24 months)', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    await rate({ issuer, score: 5 });
    const old = await rate({ issuer, user: bob, score: 1 });
    await db.query(
      `update public.issuer_ratings set created_at = now() - interval '730 days' where public_id = $1`,
      [old.public_id],
    );
    await db.exec(`update public.issuer_ratings set status = 'PUBLISHED'`);
    // (5 * 1.0 + 1 * 0.5) / 1.5 = 3.67; the plain average stays 3.
    expect(await issuerStats(issuer)).toMatchObject({ average_score: 3, weighted_score: 3.67 });
  });

  it('recomputes when a published rating is removed', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    const r = await rate({ issuer });
    await db.exec(`update public.issuer_ratings set status = 'PUBLISHED'`);
    expect((await issuerStats(issuer)).rating_count).toBe(1);
    await db.query(`update public.issuer_ratings set status = 'REMOVED' where public_id = $1`, [
      r.public_id,
    ]);
    expect(await issuerStats(issuer)).toMatchObject({
      rating_count: 0,
      average_score: 0,
      risk_counts: {},
    });
  });
});

// =============================================================================================
// Representations
// =============================================================================================

async function representation(slug: string) {
  return one<{ id: number; public_id: string }>(
    'select id, public_id from public.representations where slug = $1',
    [slug],
  );
}

async function signatureFile(owner: number, purpose = 'SIGNATURE'): Promise<number> {
  const key = `sig/${owner}/${Math.random().toString(36).slice(2)}.png`;
  return Number(
    (
      await one<{ id: number }>(
        `insert into public.files (owner_id, purpose, bucket, object_key, mime_type, size_bytes)
         values ($1, $2::file_purpose, 'signatures', $3, 'image/png', 100) returning id`,
        [owner, purpose, key],
      )
    ).id,
  );
}

let codeSeq = 0;
const nextCode = () => `GIG-T${String(++codeSeq).padStart(8, '0')}`;

interface SignInput {
  user?: number;
  representation: string;
  code?: string;
  displayMode?: 'FULL_NAME' | 'INITIALS' | 'ANONYMOUS';
  name?: string;
  investorType?: string | null;
  file?: number;
  tier?: 'OBSERVER' | 'PRIVE' | 'INSTITUTIONAL';
  key?: string | null;
}

async function sign(input: SignInput) {
  const user = input.user ?? alice;
  return one<{ public_id: string; signature_code: string }>(
    `select * from public.sign_representation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      user,
      input.representation,
      input.code ?? nextCode(),
      input.displayMode ?? 'FULL_NAME',
      input.name ?? 'Shreya Mehta',
      input.investorType === undefined ? 'RETAIL_EXPERIENCED' : input.investorType,
      input.file ?? (await signatureFile(user)),
      input.tier ?? 'PRIVE',
      ['PETITION_SUBMISSION_SUPPORT', 'PETITION_DIGITAL_ENDORSEMENT'],
      '2026-10',
      '10.0.0.1',
      '1.4.0',
      input.key ?? null,
      input.key ? 'hash' : null,
    ],
  );
}

describe('representations: schema and seed', () => {
  it("creates the plan's 4 Representations tables with row level security", async () => {
    const tables = await rows<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables
       where schemaname = 'public' and tablename like 'representation%' order by tablename`,
    );
    expect(tables).toEqual(
      [
        'representation_documents',
        'representation_signatures',
        'representation_status_history',
        'representations',
      ].map((tablename) => ({ tablename, rowsecurity: true })),
    );
  });

  it('seeds the 30 investor types and the mock petitions', async () => {
    expect(
      (
        await one<{ n: number }>(
          `select count(*)::int as n from public.lookup_options where type = 'INVESTOR_TYPE'`,
        )
      ).n,
    ).toBe(30);
    expect(
      (await one<{ n: number }>('select count(*)::int as n from public.representations')).n,
    ).toBe(6);
  });

  it('starts every petition timeline at its opening status', async () => {
    const { id } = await representation('hidden-fee-transparency');
    expect(
      await rows(
        'select from_status, to_status::text from public.representation_status_history where representation_id = $1',
        [id],
      ),
    ).toEqual([{ from_status: null, to_status: 'MEETING_REQUESTED' }]);
  });

  it('records every stored status change', async () => {
    const { id } = await representation('platform-fee-breakdown-standard');
    await db.query(
      `update public.representations set track_status = 'UNDER_REVIEW' where id = $1`,
      [id],
    );
    await db.query(`update public.representations set track_status = 'RESOLVED' where id = $1`, [
      id,
    ]);
    const history = await rows<{ from_status: string | null; to_status: string }>(
      `select from_status::text, to_status::text from public.representation_status_history
       where representation_id = $1 order by id`,
      [id],
    );
    expect(history.slice(1)).toEqual([
      { from_status: 'RESOLVED', to_status: 'UNDER_REVIEW' },
      { from_status: 'UNDER_REVIEW', to_status: 'RESOLVED' },
    ]);
  });
});

describe('representation_cards (effective status)', () => {
  it('derives Open, Closing Soon and Closed from the signing window', async () => {
    const { id } = await representation('financial-disclosures-first-time-investors');
    const status = async () =>
      await one<{ track_status: string; is_open_for_signing: boolean; days_left: number }>(
        'select track_status::text, is_open_for_signing, days_left from public.representation_cards where internal_id = $1',
        [id],
      );

    await db.query(
      `update public.representations set closes_at = now() + interval '20 days' where id = $1`,
      [id],
    );
    expect(await status()).toEqual({
      track_status: 'OPEN',
      is_open_for_signing: true,
      days_left: 20,
    });

    await db.query(
      `update public.representations set closes_at = now() + interval '3 days' where id = $1`,
      [id],
    );
    expect(await status()).toEqual({
      track_status: 'CLOSING_SOON',
      is_open_for_signing: true,
      days_left: 3,
    });

    await db.query(
      `update public.representations set opens_at = now() - interval '30 days', closes_at = now() - interval '1 day' where id = $1`,
      [id],
    );
    expect(await status()).toEqual({
      track_status: 'CLOSED',
      is_open_for_signing: false,
      days_left: 0,
    });

    await db.query(
      `update public.representations set closes_at = now() + interval '9 days' where id = $1`,
      [id],
    );
  });

  it('shows statuses set by GIG as stored', async () => {
    const { id } = await representation('retail-platform-security-standards');
    expect(
      (
        await one<{ track_status: string }>(
          'select track_status::text from public.representation_cards where internal_id = $1',
          [id],
        )
      ).track_status,
    ).toBe('SUBMITTED_TO_REGULATOR');
  });

  it('hides petitions that have not opened yet', async () => {
    const { id } = await representation('mandatory-breach-notifications');
    await db.query(
      `update public.representations set opens_at = now() + interval '1 day', closes_at = now() + interval '10 days' where id = $1`,
      [id],
    );
    expect(
      await rows('select 1 from public.representation_cards where internal_id = $1', [id]),
    ).toEqual([]);
    await db.query(
      `update public.representations set opens_at = now() - interval '90 days', closes_at = now() - interval '30 days' where id = $1`,
      [id],
    );
  });
});

describe('sign_representation', () => {
  beforeEach(async () => {
    await db.exec('delete from public.representation_signatures; delete from public.consents;');
  });

  it('stores the signature with its consents and updates the counts', async () => {
    const petition = await representation('mandatory-t1-settlement-disclosure');
    const result = await sign({ representation: petition.public_id, code: 'GIG-ET7ZWDTZK' });

    expect(result.signature_code).toBe('GIG-ET7ZWDTZK');
    expect(
      await one('select signature_count, vote_count from public.representations where id = $1', [
        petition.id,
      ]),
    ).toEqual({ signature_count: 1, vote_count: 1 });
    expect(
      await rows<{ type: string; version: string; ip_address: string; app_version: string }>(
        'select type, version, ip_address, app_version from public.consents where user_id = $1 order by type',
        [alice],
      ),
    ).toEqual([
      {
        type: 'PETITION_DIGITAL_ENDORSEMENT',
        version: '2026-10',
        ip_address: '10.0.0.1',
        app_version: '1.4.0',
      },
      {
        type: 'PETITION_SUBMISSION_SUPPORT',
        version: '2026-10',
        ip_address: '10.0.0.1',
        app_version: '1.4.0',
      },
    ]);
  });

  it('counts only Prive signatures as votes', async () => {
    const petition = await representation('mandatory-t1-settlement-disclosure');
    await sign({ representation: petition.public_id });
    await sign({ representation: petition.public_id, user: bob, tier: 'INSTITUTIONAL' });
    expect(
      await one('select signature_count, vote_count from public.representations where id = $1', [
        petition.id,
      ]),
    ).toEqual({ signature_count: 2, vote_count: 1 });
  });

  it('allows one signature per investor and petition', async () => {
    const petition = await representation('mandatory-t1-settlement-disclosure');
    await sign({ representation: petition.public_id });
    const error = await dbError(sign({ representation: petition.public_id }));
    expect(error.code).toBe('23505');
    expect(error.message).toMatch(/representation_signatures_one_per_user/);
  });

  it('keeps signature codes unique and in the GIG-XXXXXXXXX format', async () => {
    const petition = await representation('mandatory-t1-settlement-disclosure');
    const other = await representation('financial-disclosures-first-time-investors');
    await sign({ representation: petition.public_id, code: 'GIG-AAAAAAAAA' });
    expect(
      (await dbError(sign({ representation: other.public_id, code: 'GIG-AAAAAAAAA' }))).message,
    ).toMatch(/representation_signatures_code_key/);
    expect((await dbError(sign({ representation: other.public_id, code: 'GIG-short' }))).code).toBe(
      '23514',
    );
  });

  it('rejects unknown, unopened and closed petitions', async () => {
    expect(
      (await dbError(sign({ representation: '00000000-0000-4000-8000-000000000000' }))).message,
    ).toMatch(/REPRESENTATION_NOT_FOUND/);
    const closed = await representation('hidden-fee-transparency');
    expect((await dbError(sign({ representation: closed.public_id }))).message).toMatch(
      /REPRESENTATION_CLOSED/,
    );
  });

  it("rejects a file that is not the signer's own SIGNATURE upload", async () => {
    const petition = await representation('mandatory-t1-settlement-disclosure');
    for (const file of [await signatureFile(bob), await signatureFile(alice, 'AVATAR')]) {
      expect((await dbError(sign({ representation: petition.public_id, file }))).message).toMatch(
        /SIGNATURE_FILE_INVALID/,
      );
    }
  });

  it('rejects an unknown investor type and allows none', async () => {
    const petition = await representation('mandatory-t1-settlement-disclosure');
    expect(
      (await dbError(sign({ representation: petition.public_id, investorType: 'ASTRONAUT' }))).code,
    ).toBe('23503');
    await sign({ representation: petition.public_id, investorType: null });
  });

  it('rolls everything back when a step fails', async () => {
    const petition = await representation('mandatory-t1-settlement-disclosure');
    await sign({ representation: petition.public_id, file: await signatureFile(bob) }).catch(
      () => null,
    );
    expect((await one<{ n: number }>('select count(*)::int as n from public.consents')).n).toBe(0);
    expect(
      (await one<{ n: number }>('select count(*)::int as n from public.representation_signatures'))
        .n,
    ).toBe(0);
  });
});

describe('representation_signers (public signer list)', () => {
  beforeEach(async () => {
    await db.exec('delete from public.representation_signatures; delete from public.consents;');
  });

  it('shows names per display choice, never for anonymous signers, and no user ids', async () => {
    const petition = await representation('mandatory-t1-settlement-disclosure');
    const carol = await createUser(db, 'cccccccc-0000-4000-8000-0000000000c3');
    await sign({ representation: petition.public_id, displayMode: 'FULL_NAME' });
    await sign({
      representation: petition.public_id,
      user: bob,
      displayMode: 'INITIALS',
      name: 'Ravi Kumar',
    });
    await sign({
      representation: petition.public_id,
      user: carol,
      displayMode: 'ANONYMOUS',
      investorType: null,
    });

    const signers = await rows(
      `select display_name, is_anonymous, investor_type_label, is_verified
       from public.representation_signers where representation_id = $1 order by signed_at`,
      [petition.id],
    );
    expect(signers).toEqual([
      {
        display_name: 'Shreya Mehta',
        is_anonymous: false,
        investor_type_label: 'Retail Investor (Experienced Investors)',
        is_verified: true,
      },
      {
        display_name: 'R. K.',
        is_anonymous: false,
        investor_type_label: 'Retail Investor (Experienced Investors)',
        is_verified: true,
      },
      { display_name: null, is_anonymous: true, investor_type_label: null, is_verified: true },
    ]);

    const columns = await rows<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'representation_signers'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('user_id');
  });
});

// =============================================================================================
// Plan conventions (database design): timestamps, user-content status and soft delete
// =============================================================================================

describe('plan conventions', () => {
  const RATINGS_AND_REPRESENTATIONS = [
    'issuer_ratings',
    'issuer_rating_factors',
    'issuer_rating_risks',
    'issuer_stats',
    'representations',
    'representation_signatures',
    'representation_status_history',
    'representation_documents',
  ];

  it('gives every Ratings and Representations table created_at and updated_at', async () => {
    const columns = await rows<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name = any ($1)
         and column_name in ('created_at', 'updated_at')`,
      [RATINGS_AND_REPRESENTATIONS],
    );
    for (const table of RATINGS_AND_REPRESENTATIONS) {
      expect(
        columns
          .filter((c) => c.table_name === table)
          .map((c) => c.column_name)
          .sort(),
        table,
      ).toEqual(['created_at', 'updated_at']);
    }
  });

  it('gives user content (ratings and signatures) a status and soft delete', async () => {
    const columns = await rows<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and table_name in ('issuer_ratings', 'representation_signatures')
         and column_name in ('status', 'deleted_at')`,
    );
    expect(columns).toHaveLength(4);
  });

  it('stores the petition description (plan: title, description, country, goal, ...)', async () => {
    const { description } = await one<{ description: string }>(
      `select description from public.representations where slug = 'hidden-fee-transparency'`,
    );
    expect(description).toMatch(/brokerage charges/);
  });
});

describe('signature status and soft delete', () => {
  beforeEach(async () => {
    await db.exec('delete from public.representation_signatures; delete from public.consents;');
  });

  it('stops counting a removed or deleted signature and lets the investor sign again', async () => {
    const petition = await representation('mandatory-t1-settlement-disclosure');
    const counts = () =>
      one('select signature_count, vote_count from public.representations where id = $1', [
        petition.id,
      ]);

    const first = await sign({ representation: petition.public_id });
    await sign({ representation: petition.public_id, user: bob });
    expect(await counts()).toEqual({ signature_count: 2, vote_count: 2 });

    await db.query(
      `update public.representation_signatures set status = 'REMOVED' where public_id = $1`,
      [first.public_id],
    );
    expect(await counts()).toEqual({ signature_count: 1, vote_count: 1 });
    expect(
      (
        await rows('select 1 from public.representation_signers where representation_id = $1', [
          petition.id,
        ])
      ).length,
    ).toBe(1);

    await sign({ representation: petition.public_id });
    expect(await counts()).toEqual({ signature_count: 2, vote_count: 2 });

    await db.query(
      `update public.representation_signatures set deleted_at = now() where user_id = $1 and status = 'VALID'`,
      [bob],
    );
    expect(await counts()).toEqual({ signature_count: 1, vote_count: 1 });
  });

  it('rejects a signature file the virus scan flagged', async () => {
    const petition = await representation('mandatory-t1-settlement-disclosure');
    const file = await signatureFile(alice);
    await db.query(`update public.files set scan_status = 'INFECTED' where id = $1`, [file]);
    expect((await dbError(sign({ representation: petition.public_id, file }))).message).toMatch(
      /SIGNATURE_FILE_INVALID/,
    );
  });
});
