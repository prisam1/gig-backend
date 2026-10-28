// Ratings and Representations against the real migrations and seed: the API's own repositories
// run against PGlite, calling the same app_* database functions they call through supabase-js.

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseError, dbTransport, isUniqueViolationOf } from '../../src/lib/db';
import { HttpError } from '../../src/middleware/errorHandler';
import type { ClientContext } from '../../src/middleware/requestContext';
import {
  RATING_INDEXES,
  ratingsRepository,
  type FactorFlag,
  type NewRating,
} from '../../src/modules/ratings/ratings.repository';
import {
  representationsRepository,
  SIGNATURE_CONSTRAINTS,
  type NewSignature,
  type Representation,
} from '../../src/modules/representations/representations.repository';
import { listOptions } from '../../src/modules/users/users.service';
import type { RatingFlag } from '../../src/types/domain';
import { callFunction, createTestDatabase, createUser, dbError } from './pglite';

// The real audit log (test/setup.ts stubs it), so its write inside each transaction is checked.
vi.mock('../../src/lib/audit', async (importOriginal) => importOriginal());

const ALICE = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const BOB = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const CAROL = 'cccccccc-0000-4000-8000-0000000000c3';

const CTX: ClientContext = {
  ip: '10.0.0.1',
  userAgent: 'vitest',
  appVersion: '1.4.0',
  requestId: 'req-1',
};

let db: PGlite;
let alice: string;
let bob: string;
let carol: string;

async function rows<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  return (await db.query<T>(query, params)).rows;
}

async function one<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  const [row] = await rows<T>(query, params);
  if (!row) throw new Error(`no row for: ${query}`);
  return row;
}

async function count(query: string, params: unknown[] = []): Promise<number> {
  return (await one<{ n: number }>(`select count(*)::int as n from (${query}) q`, params)).n;
}

beforeAll(async () => {
  db = await createTestDatabase();
  alice = await createUser(db, ALICE);
  bob = await createUser(db, BOB);
  carol = await createUser(db, CAROL);
});

// callDb runs as in production (arguments and results checked against src/lib/dbFunctions.ts);
// only its transport is swapped, so the app_* functions run in PGlite instead of through supabase-js.
beforeEach(() => {
  vi.spyOn(dbTransport, 'rpc').mockImplementation((fn, args) =>
    callFunction(db, fn, args, (code, message) => new DatabaseError(code, message)),
  );
});

afterAll(async () => {
  await db.close();
});

const TABLES = {
  ratings: ['issuer_rating_factors', 'issuer_rating_risks', 'issuer_ratings', 'issuer_stats'],
  representations: [
    'representation_documents',
    'representation_signatures',
    'representation_status_history',
    'representations',
  ],
};

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

function allFactors(flag: RatingFlag = 'POSITIVE', overrides: Record<string, RatingFlag> = {}) {
  return FACTORS.map((code): FactorFlag => ({ code, flag: overrides[code] ?? flag }));
}

async function issuerId(slug: string): Promise<string> {
  return (await one<{ id: string }>('select id from public.issuers where slug = $1', [slug])).id;
}

let keySeq = 0;

function rate(input: Partial<NewRating> & { issuerId: string }): Promise<string> {
  return ratingsRepository.submit(
    {
      userId: alice,
      overallScore: 4,
      factors: allFactors(),
      riskCodes: ['CREDIT', 'MARKET', 'LIQUIDITY'],
      idempotencyKey: `rating-key-${++keySeq}`,
      requestHash: 'hash',
      ...input,
    },
    CTX,
  );
}

async function publishAll() {
  await db.exec(`update app.issuer_ratings set status = 'PUBLISHED', published_at = now()`);
}

const clearRatings = () => db.exec('delete from app.issuer_ratings; delete from app.issuer_stats;');

describe('ratings: schema and seed', () => {
  it("creates the plan's 4 Ratings tables in the private app schema, with row level security", async () => {
    const tables = await rows<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables
       where schemaname = 'app' and tablename = any ($1) order by tablename`,
      [TABLES.ratings],
    );
    expect(tables).toEqual(TABLES.ratings.map((tablename) => ({ tablename, rowsecurity: true })));
  });

  it('seeds the 10 rating factors and 12 risk factors, in the wizard order', async () => {
    const factors = await listOptions('RATING_FACTOR');
    expect(factors.map((o) => o.code)).toEqual(FACTORS);
    expect(factors[1]).toEqual({ code: 'BUSINESS_OF_COMPANY', label: 'Business of the company' });
    expect(await listOptions('RISK_FACTOR')).toHaveLength(12);
  });
});

describe('ratingsRepository.submit', () => {
  beforeEach(clearRatings);

  it('stores the rating, every factor flag and 3 risks, pending moderation, with a receipt number', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    const id = await rate({
      issuerId: issuer,
      overallScore: 5,
      factors: allFactors('POSITIVE', { BUSINESS_OF_COMPANY: 'NEGATIVE' }),
    });

    const rating = await ratingsRepository.findOwn(alice, id);
    expect(rating).toMatchObject({
      publicId: id,
      status: 'PENDING_MODERATION',
      overallScore: 5,
      moderationNote: null,
      issuer: { id: issuer, name: 'Sovereign Alpha Yield' },
      riskCodes: ['CREDIT', 'LIQUIDITY', 'MARKET'],
    });
    expect(rating?.receiptNo).toMatch(new RegExp(`^GIG-RT-${new Date().getFullYear()}-\\d{6}$`));
    expect(rating?.createdAt).toBeInstanceOf(Date);
    // Codes keep their underscores (the camelCase transform renames keys, not values).
    expect(rating?.factors).toContainEqual({ code: 'BUSINESS_OF_COMPANY', flag: 'NEGATIVE' });
    expect(rating?.factors).toHaveLength(10);
  });

  it('writes the audit entry in the same transaction', async () => {
    const id = await rate({ issuerId: await issuerId('sovereign-alpha-yield') });
    const entry = await one<{ actor_user_id: string; ip: string; metadata: { rating: string } }>(
      `select actor_user_id::text, host(ip) as ip, metadata from app.audit_logs
       where action = 'rating.submitted' order by id desc limit 1`,
    );
    expect(entry).toMatchObject({ actor_user_id: alice, ip: '10.0.0.1', metadata: { rating: id } });
  });

  it("reads back only the user's own rating", async () => {
    const id = await rate({ issuerId: await issuerId('sovereign-alpha-yield') });
    expect(await ratingsRepository.findOwn(bob, id)).toBeNull();
  });

  it('keeps the overall score between 1 and 5', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    expect((await dbError(rate({ issuerId: issuer, overallScore: 6 }))).code).toBe('23514');
  });

  it('accepts only known factor and risk codes, and rolls the whole rating back otherwise', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    const unknownFactor = [
      ...allFactors().slice(1),
      { code: 'ASTROLOGY', flag: 'POSITIVE' as const },
    ];
    expect((await dbError(rate({ issuerId: issuer, factors: unknownFactor }))).code).toBe('23503');
    expect(
      (await dbError(rate({ issuerId: issuer, riskCodes: ['CREDIT', 'MARKET', 'GENERAL'] }))).code,
    ).toBe('23503');
    expect(await count('select 1 from app.issuer_ratings')).toBe(0);
  });

  it('allows one active rating per investor and issuer', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    await rate({ issuerId: issuer });
    const error = await dbError(rate({ issuerId: issuer }));
    expect(isUniqueViolationOf(error, RATING_INDEXES.onePerUser)).toBe(true);

    // Another investor, or the same investor after a rejection, may rate it.
    await rate({ issuerId: issuer, userId: bob });
    await db.exec(`update app.issuer_ratings set status = 'REJECTED'`);
    await rate({ issuerId: issuer });
  });

  it('finds a rating by its Idempotency-Key and refuses the key twice', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    const id = await rate({ issuerId: issuer, idempotencyKey: 'same-key-123' });
    expect(await ratingsRepository.findByIdempotencyKey(alice, 'same-key-123')).toEqual({
      publicId: id,
      requestHash: 'hash',
    });
    expect(await ratingsRepository.findByIdempotencyKey(bob, 'same-key-123')).toBeNull();

    const other = await issuerId('nexus-infrastructure-trust');
    const error = await dbError(rate({ issuerId: other, idempotencyKey: 'same-key-123' }));
    expect(isUniqueViolationOf(error, RATING_INDEXES.idempotencyKey)).toBe(true);
  });

});

describe('issuer stats', () => {
  beforeEach(clearRatings);

  it('ignores ratings until they are published', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    await rate({ issuerId: issuer });
    expect(await ratingsRepository.findStats(issuer)).toBeNull();
    expect(await ratingsRepository.findIssuer(issuer)).toMatchObject({
      ratingCount: 0,
      averageScore: 0,
    });
  });

  it('computes average, distribution, factor breakdown and risk counts from published ratings', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    await rate({ issuerId: issuer, overallScore: 5, riskCodes: ['CREDIT', 'MARKET', 'LEGAL'] });
    await rate({
      issuerId: issuer,
      userId: bob,
      overallScore: 2,
      factors: allFactors('NEUTRAL', { GENERAL: 'NEGATIVE' }),
      riskCodes: ['CREDIT', 'FRAUD', 'LEGAL'],
    });
    await publishAll();

    const stats = await ratingsRepository.findStats(issuer);
    expect(stats).toMatchObject({
      ratingCount: 2,
      averageScore: 3.5,
      weightedScore: 3.5,
      scoreDistribution: { '1': 0, '2': 1, '3': 0, '4': 0, '5': 1 },
      riskCounts: { CREDIT: 2, LEGAL: 2, MARKET: 1, FRAUD: 1 },
    });
    expect(stats?.lastRatingAt).toBeInstanceOf(Date);
    expect(Object.keys(stats?.factorBreakdown ?? {}).sort()).toEqual([...FACTORS].sort());
    expect(stats?.factorBreakdown['GENERAL']).toEqual({ POSITIVE: 50, NEUTRAL: 0, NEGATIVE: 50 });
    expect(stats?.factorBreakdown['BUSINESS_OF_COMPANY']).toEqual({
      POSITIVE: 50,
      NEUTRAL: 50,
      NEGATIVE: 0,
    });
    expect(await ratingsRepository.findIssuer(issuer)).toMatchObject({
      ratingCount: 2,
      averageScore: 3.5,
    });
  });

  it('weights older ratings less (linear decay to 0.5 at 24 months)', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    await rate({ issuerId: issuer, overallScore: 5 });
    const old = await rate({ issuerId: issuer, userId: bob, overallScore: 1 });
    await db.query(
      `update app.issuer_ratings set created_at = now() - interval '730 days' where public_id = $1`,
      [old],
    );
    await publishAll();
    // (5 * 1.0 + 1 * 0.5) / 1.5 = 3.67; the plain average stays 3.
    expect(await ratingsRepository.findStats(issuer)).toMatchObject({
      averageScore: 3,
      weightedScore: 3.67,
    });
  });

  it('recomputes when a published rating is removed', async () => {
    const issuer = await issuerId('sovereign-alpha-yield');
    const id = await rate({ issuerId: issuer });
    await publishAll();
    expect((await ratingsRepository.findStats(issuer))?.ratingCount).toBe(1);
    await db.query(`update app.issuer_ratings set status = 'REMOVED' where public_id = $1`, [id]);
    expect(await ratingsRepository.findStats(issuer)).toMatchObject({
      ratingCount: 0,
      averageScore: 0,
      riskCounts: {},
    });
  });
});

describe('ratingsRepository issuers', () => {
  beforeEach(clearRatings);

  it('returns the offer terms as numbers and the dates as YYYY-MM-DD', async () => {
    const issuer = await ratingsRepository.findIssuer(await issuerId('sovereign-alpha-yield'));
    expect(issuer).toMatchObject({
      slug: 'sovereign-alpha-yield',
      assetType: 'Equity',
      isListed: true,
      openDate: '2024-03-25',
      closeDate: '2024-03-29',
      offer: {
        minLot: 45,
        lotUnit: 'shares',
        priceMin: 310,
        priceMax: 325,
        offerSize: 14500000000,
        currency: 'INR',
        useOfFunds: 'Debt',
        lockIn: '30-60 days',
        prePostRatio: '100%/75%',
      },
      tags: [],
    });
    expect(await ratingsRepository.findIssuer('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('searches name or instrument, filters, sorts and pages', async () => {
    const all = await ratingsRepository.findIssuers({ page: 1, pageSize: 20, sort: 'recent' });
    expect(all.total).toBe(7);
    expect(all.items[0]?.slug).toBe('vanguard-realty-housing');

    const bonds = await ratingsRepository.findIssuers({
      page: 1,
      pageSize: 20,
      sort: 'closing_soon',
      q: 'BONDS',
    });
    expect(bonds.items.map((i) => i.slug)).toEqual([
      'fintech-growth-bonds',
      'meridian-renewable-energy',
    ]);

    const listedBonds = await ratingsRepository.findIssuers({
      page: 1,
      pageSize: 20,
      sort: 'recent',
      filter: { assetType: ['Bonds'], listed: true },
    });
    expect(listedBonds.items.map((i) => i.slug)).toEqual(['meridian-renewable-energy']);

    // LIKE wildcards in the search match literally.
    expect(
      (await ratingsRepository.findIssuers({ page: 1, pageSize: 20, sort: 'recent', q: '%' }))
        .total,
    ).toBe(0);

    expect(await ratingsRepository.findIssuers({ page: 9, pageSize: 20, sort: 'recent' })).toEqual({
      items: [],
      total: 7,
    });
  });

  it('sorts by rating', async () => {
    const top = await issuerId('quantum-biotech-limited');
    await rate({ issuerId: top, overallScore: 5 });
    await rate({ issuerId: await issuerId('nexus-infrastructure-trust'), overallScore: 3 });
    await publishAll();
    const page = await ratingsRepository.findIssuers({ page: 1, pageSize: 2, sort: 'top_rated' });
    expect(page.items.map((i) => [i.slug, i.averageScore])).toEqual([
      ['quantum-biotech-limited', 5],
      ['nexus-infrastructure-trust', 3],
    ]);
  });
});

// =============================================================================================
// Representations
// =============================================================================================

async function petition(slug: string): Promise<Representation> {
  const { id } = await one<{ id: string }>(
    'select public_id as id from app.representations where slug = $1',
    [slug],
  );
  const found = await representationsRepository.findById(id);
  if (!found) throw new Error(`petition ${slug} is not visible`);
  return found;
}

async function uploadedFile(
  owner: string,
  purpose = 'SIGNATURE',
  scanStatus = 'CLEAN',
): Promise<string> {
  const bucket = purpose === 'SIGNATURE' ? 'signatures' : 'avatars';
  const key = `${owner}/${Math.random().toString(36).slice(2)}.png`;
  return (
    await one<{ id: string }>(
      `insert into app.files (owner_id, purpose, bucket, object_key, mime_type, size_bytes, scan_status)
       values ($1, $2, $3, $4, 'image/png', 100, $5) returning id::text`,
      [owner, purpose, bucket, key, scanStatus],
    )
  ).id;
}

let codeSeq = 0;
const nextCode = () => `GIG-T${String(++codeSeq).padStart(8, '0')}`;

async function sign(input: Partial<NewSignature> & { representationId: string }): Promise<string> {
  const userId = input.userId ?? alice;
  const signatureCode = input.signatureCode ?? nextCode();
  await representationsRepository.sign(
    {
      userId,
      signatureCode,
      displayMode: 'FULL_NAME',
      signerName: 'Shreya Mehta',
      investorType: 'RETAIL_EXPERIENCED',
      signatureFileId: input.signatureFileId ?? (await uploadedFile(userId)),
      signerTier: 'PRIVE',
      consentTypes: ['PETITION_SUBMISSION_SUPPORT', 'PETITION_DIGITAL_ENDORSEMENT'],
      consentVersion: '2026-10',
      idempotencyKey: `sign-key-${signatureCode}`,
      requestHash: 'hash',
      ...input,
    },
    CTX,
  );
  return signatureCode;
}

async function counts(slug: string) {
  const { signatureCount, voteCount } = await petition(slug);
  return { signatureCount, voteCount };
}

const OPEN = 'mandatory-t1-settlement-disclosure';
const clearSignatures = () =>
  db.exec(`delete from app.representation_signatures;
           delete from app.consents where type like 'PETITION_%';`);

describe('representations: schema and seed', () => {
  it("creates the plan's 4 Representations tables in the private app schema, with row level security", async () => {
    const tables = await rows<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables
       where schemaname = 'app' and tablename like 'representation%' order by tablename`,
    );
    expect(tables).toEqual(
      TABLES.representations.map((tablename) => ({ tablename, rowsecurity: true })),
    );
  });

  it('seeds the 30 investor types and the mock petitions', async () => {
    expect(await listOptions('INVESTOR_TYPE')).toHaveLength(30);
    expect(
      (await representationsRepository.findAll({ page: 1, pageSize: 20, sort: 'recent' })).total,
    ).toBe(6);
  });

  it('starts every petition timeline at its opening status and records each stored change', async () => {
    const before = await representationsRepository.findStatusHistory(
      await petition('hidden-fee-transparency'),
    );
    expect(before).toEqual([
      expect.objectContaining({
        fromStatus: null,
        toStatus: 'MEETING_REQUESTED',
        note: null,
        documents: [],
      }),
    ]);

    const resolved = await petition('platform-fee-breakdown-standard');
    await db.query(`update app.representations set track_status = 'UNDER_REVIEW' where id = $1`, [
      resolved.internalId,
    ]);
    await db.query(`update app.representations set track_status = 'RESOLVED' where id = $1`, [
      resolved.internalId,
    ]);
    const history = await representationsRepository.findStatusHistory(resolved);
    expect(history.slice(1).map((h) => [h.fromStatus, h.toStatus])).toEqual([
      ['RESOLVED', 'UNDER_REVIEW'],
      ['UNDER_REVIEW', 'RESOLVED'],
    ]);
    expect(history[0]?.occurredAt).toBeInstanceOf(Date);
  });
});

describe('representation cards (effective status)', () => {
  it('derives Open, Closing Soon and Closed from the signing window', async () => {
    const slug = 'financial-disclosures-first-time-investors';
    const { internalId } = await petition(slug);
    const setWindow = (opens: string, closes: string) =>
      db.query(
        `update app.representations set opens_at = now() + $2::interval, closes_at = now() + $3::interval where id = $1`,
        [internalId, opens, closes],
      );
    const status = async () => {
      const { trackStatus, isOpenForSigning, daysLeft } = await petition(slug);
      return { trackStatus, isOpenForSigning, daysLeft };
    };

    await setWindow('-21 days', '20 days');
    expect(await status()).toEqual({ trackStatus: 'OPEN', isOpenForSigning: true, daysLeft: 20 });
    await setWindow('-21 days', '3 days');
    expect(await status()).toEqual({
      trackStatus: 'CLOSING_SOON',
      isOpenForSigning: true,
      daysLeft: 3,
    });
    await setWindow('-30 days', '-1 day');
    expect(await status()).toEqual({ trackStatus: 'CLOSED', isOpenForSigning: false, daysLeft: 0 });
    await setWindow('-21 days', '9 days');
  });

  it('shows statuses set by GIG as stored, and hides petitions that have not opened yet', async () => {
    expect((await petition('retail-platform-security-standards')).trackStatus).toBe(
      'SUBMITTED_TO_REGULATOR',
    );

    const { internalId, id } = await petition('mandatory-breach-notifications');
    await db.query(
      `update app.representations set opens_at = now() + interval '1 day', closes_at = now() + interval '10 days' where id = $1`,
      [internalId],
    );
    expect(await representationsRepository.findById(id)).toBeNull();
    await db.query(
      `update app.representations set opens_at = now() - interval '90 days', closes_at = now() - interval '30 days' where id = $1`,
      [internalId],
    );
  });

  it('maps the card: numbers, dates and progress', async () => {
    const card = await petition('hidden-fee-transparency');
    expect(card).toMatchObject({
      slug: 'hidden-fee-transparency',
      country: 'IN',
      goal: 2000,
      signatureCount: 0,
      progressPercent: 0,
      regulators: ['SEBI'],
      tags: ['India', 'Fees'],
    });
    expect(card.description).toMatch(/brokerage charges/);
    expect(card.closesAt).toBeInstanceOf(Date);
    expect(typeof card.internalId).toBe('string');
  });

  it('searches, filters and sorts petitions', async () => {
    const open = await representationsRepository.findAll({
      page: 1,
      pageSize: 20,
      sort: 'closing_soon',
      filter: { openForSigning: true },
    });
    expect(open.items.map((r) => r.slug)).toEqual([
      OPEN,
      'financial-disclosures-first-time-investors',
    ]);

    const uae = await representationsRepository.findAll({
      page: 1,
      pageSize: 20,
      sort: 'recent',
      filter: { country: ['AE'], status: ['MEETING_SCHEDULED'] },
    });
    expect(uae.items.map((r) => r.slug)).toEqual(['mandatory-breach-notifications']);

    const fees = await representationsRepository.findAll({
      page: 1,
      pageSize: 20,
      sort: 'recent',
      q: 'FEE',
    });
    expect(fees.items.map((r) => r.slug)).toEqual([
      'hidden-fee-transparency',
      'platform-fee-breakdown-standard',
    ]);
  });
});

describe('representationsRepository.sign', () => {
  beforeEach(clearSignatures);

  it('stores the signature with its consents, updates the counts and audits it', async () => {
    const code = await sign({
      representationId: (await petition(OPEN)).id,
      signatureCode: 'GIG-ET7ZWDTZK',
    });

    expect(code).toBe('GIG-ET7ZWDTZK');
    expect(await counts(OPEN)).toEqual({ signatureCount: 1, voteCount: 1 });
    expect(
      await rows(
        `select type, version, host(ip) as ip, user_agent, app_version from app.consents
         where user_id = $1 and type like 'PETITION_%' order by type`,
        [alice],
      ),
    ).toEqual(
      ['PETITION_DIGITAL_ENDORSEMENT', 'PETITION_SUBMISSION_SUPPORT'].map((type) => ({
        type,
        version: '2026-10',
        ip: '10.0.0.1',
        user_agent: 'vitest',
        app_version: '1.4.0',
      })),
    );
    expect(
      await one(
        `select metadata from app.audit_logs where action = 'representation.signed' order by id desc limit 1`,
      ),
    ).toMatchObject({ metadata: { signature: 'GIG-ET7ZWDTZK' } });

    const mine = await representationsRepository.findSignature(alice, await petition(OPEN));
    expect(mine).toMatchObject({
      signatureCode: 'GIG-ET7ZWDTZK',
      displayMode: 'FULL_NAME',
      signerName: 'Shreya Mehta',
      investorType: 'RETAIL_EXPERIENCED',
      signerTier: 'PRIVE',
    });
    expect(await representationsRepository.findSignature(bob, await petition(OPEN))).toBeNull();
  });

  it('counts only Prive signatures as votes', async () => {
    const { id } = await petition(OPEN);
    await sign({ representationId: id });
    await sign({ representationId: id, userId: bob, signerTier: 'INSTITUTIONAL' });
    expect(await counts(OPEN)).toEqual({ signatureCount: 2, voteCount: 1 });
  });

  it('allows one signature per investor and petition', async () => {
    const { id } = await petition(OPEN);
    await sign({ representationId: id });
    const error = await dbError(sign({ representationId: id }));
    expect(isUniqueViolationOf(error, SIGNATURE_CONSTRAINTS.onePerUser)).toBe(true);
  });

  it('keeps signature codes unique and in the GIG-XXXXXXXXX format', async () => {
    const { id } = await petition(OPEN);
    const other = (await petition('financial-disclosures-first-time-investors')).id;
    await sign({ representationId: id, signatureCode: 'GIG-AAAAAAAAA' });
    const duplicate = await dbError(
      sign({ representationId: other, signatureCode: 'GIG-AAAAAAAAA' }),
    );
    expect(isUniqueViolationOf(duplicate, SIGNATURE_CONSTRAINTS.code)).toBe(true);
    expect(
      (await dbError(sign({ representationId: other, signatureCode: 'GIG-short' }))).code,
    ).toBe('23514');
  });

  it('finds a signature by its Idempotency-Key and refuses the key twice', async () => {
    const { id } = await petition(OPEN);
    await sign({ representationId: id, idempotencyKey: 'sign-same-key' });
    expect(await representationsRepository.findByIdempotencyKey(alice, 'sign-same-key')).toEqual({
      representationId: id,
      requestHash: 'hash',
    });
    const other = (await petition('financial-disclosures-first-time-investors')).id;
    const error = await dbError(sign({ representationId: other, idempotencyKey: 'sign-same-key' }));
    expect(isUniqueViolationOf(error, SIGNATURE_CONSTRAINTS.idempotencyKey)).toBe(true);
  });

  it('rejects unknown and closed petitions', async () => {
    const unknown = await dbError(
      sign({ representationId: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(unknown).toBeInstanceOf(HttpError);
    expect(unknown).toMatchObject({ status: 404 });

    const closed = await dbError(
      sign({ representationId: (await petition('hidden-fee-transparency')).id }),
    );
    expect(closed).toMatchObject({ status: 409, code: 'REPRESENTATION_CLOSED' });
  });

  it("rejects a file that is not the signer's own clean SIGNATURE upload, and saves nothing", async () => {
    const { id } = await petition(OPEN);
    for (const signatureFileId of [
      await uploadedFile(bob),
      await uploadedFile(alice, 'AVATAR'),
      await uploadedFile(alice, 'SIGNATURE', 'INFECTED'),
    ]) {
      const error = await dbError(sign({ representationId: id, signatureFileId }));
      expect(error).toMatchObject({ status: 400, fields: { signatureFileId: expect.any(String) } });
    }
    expect(await count(`select 1 from app.representation_signatures`)).toBe(0);
    expect(await count(`select 1 from app.consents where type like 'PETITION_%'`)).toBe(0);
  });

  it('rejects an unknown investor type and allows none', async () => {
    const { id } = await petition(OPEN);
    expect((await dbError(sign({ representationId: id, investorType: 'ASTRONAUT' }))).code).toBe(
      '23503',
    );
    await sign({ representationId: id, investorType: null });
  });

  it('stops counting a removed or deleted signature and lets the investor sign again', async () => {
    const { id } = await petition(OPEN);
    const first = await sign({ representationId: id });
    await sign({ representationId: id, userId: bob });
    expect(await counts(OPEN)).toEqual({ signatureCount: 2, voteCount: 2 });

    await db.query(
      `update app.representation_signatures set status = 'REMOVED' where signature_code = $1`,
      [first],
    );
    expect(await counts(OPEN)).toEqual({ signatureCount: 1, voteCount: 1 });
    expect(await representationsRepository.findSigners(await petition(OPEN), 20)).toHaveLength(1);

    await sign({ representationId: id });
    expect(await counts(OPEN)).toEqual({ signatureCount: 2, voteCount: 2 });

    await db.query(
      `update app.representation_signatures set deleted_at = now() where user_id = $1 and status = 'VALID'`,
      [bob],
    );
    expect(await counts(OPEN)).toEqual({ signatureCount: 1, voteCount: 1 });
  });
});

describe('representationsRepository.findSigners', () => {
  beforeEach(clearSignatures);

  it('shows names per display choice, never for anonymous signers, newest first', async () => {
    const { id } = await petition(OPEN);
    await sign({ representationId: id, displayMode: 'FULL_NAME' });
    await sign({
      representationId: id,
      userId: bob,
      displayMode: 'INITIALS',
      signerName: 'Ravi Kumar',
    });
    await sign({
      representationId: id,
      userId: carol,
      displayMode: 'ANONYMOUS',
      investorType: null,
      signerTier: 'INSTITUTIONAL',
    });
    await db.exec(
      `update app.representation_signatures set created_at = now() + (id || ' seconds')::interval`,
    );

    const signers = await representationsRepository.findSigners(await petition(OPEN), 20);
    expect(signers.map(({ id: _id, signedAt: _signedAt, ...signer }) => signer)).toEqual([
      { displayName: null, isAnonymous: true, investorType: null, isVerified: false },
      {
        displayName: 'R. K.',
        isAnonymous: false,
        investorType: {
          code: 'RETAIL_EXPERIENCED',
          label: 'Retail Investor (Experienced Investors)',
        },
        isVerified: true,
      },
      {
        displayName: 'Shreya Mehta',
        isAnonymous: false,
        investorType: {
          code: 'RETAIL_EXPERIENCED',
          label: 'Retail Investor (Experienced Investors)',
        },
        isVerified: true,
      },
    ]);
    expect(await representationsRepository.findSigners(await petition(OPEN), 1)).toHaveLength(1);
  });
});

describe('representation documents', () => {
  beforeAll(async () => {
    const { internalId } = await petition('retail-platform-security-standards');
    const { id: step } = await one<{ id: string }>(
      `select id from app.representation_status_history where representation_id = $1`,
      [internalId],
    );
    await db.query(
      `insert into app.representation_documents
         (representation_id, status_history_id, document_type, title, object_key, mime_type, size_bytes, scan_status, created_at)
       values ($1, null, 'EVIDENCE', 'Clean evidence', 'rep/clean.pdf', 'application/pdf', 100, 'CLEAN', now()),
              ($1, null, 'EVIDENCE', 'Infected evidence', 'rep/bad.pdf', 'application/pdf', 100, 'INFECTED', now()),
              ($1, $2, 'SUBMISSION_PACK', 'Older pack', 'rep/pack-1.pdf', 'application/pdf', 200, 'CLEAN', now() - interval '2 days'),
              ($1, $2, 'SUBMISSION_PACK', 'Latest pack', 'rep/pack-2.pdf', 'application/pdf', 300, 'INFECTED', now())`,
      [internalId, step],
    );
  });

  it('never offers documents the virus scan flagged', async () => {
    const card = await petition('retail-platform-security-standards');
    expect(await representationsRepository.findEvidence(card)).toEqual([
      {
        id: expect.any(String),
        title: 'Clean evidence',
        documentType: 'EVIDENCE',
        file: {
          bucket: 'representation-documents',
          objectKey: 'rep/clean.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 100,
        },
      },
    ]);
    expect((await representationsRepository.findLatestSubmissionPack(card))?.title).toBe(
      'Older pack',
    );
    const [step] = await representationsRepository.findStatusHistory(card);
    expect(step?.documents.map((d) => d.title)).toEqual(['Older pack']);
  });

  it('has no submission pack before GIG submits a petition', async () => {
    expect(
      await representationsRepository.findLatestSubmissionPack(await petition(OPEN)),
    ).toBeNull();
  });
});

// =============================================================================================
// Plan conventions (database design): timestamps, user-content status and soft delete
// =============================================================================================

describe('plan conventions', () => {
  const ALL = [...TABLES.ratings, ...TABLES.representations];

  it('gives every Ratings and Representations table created_at and updated_at', async () => {
    const columns = await rows<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'app' and table_name = any ($1)
         and column_name in ('created_at', 'updated_at')`,
      [ALL],
    );
    for (const table of ALL) {
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
    expect(
      await count(
        `select 1 from information_schema.columns
         where table_schema = 'app' and table_name in ('issuer_ratings', 'representation_signatures')
           and column_name in ('status', 'deleted_at')`,
      ),
    ).toBe(4);
  });

  it('adds nothing to the public schema (its tables live only in the private app schema)', async () => {
    const tables = [...TABLES.ratings, ...TABLES.representations];
    expect(
      await count(`select 1 from pg_tables where schemaname = 'public' and tablename = any ($1)`, [tables]),
    ).toBe(0);
  });
});
