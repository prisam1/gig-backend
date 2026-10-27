import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseError, PG_UNIQUE_VIOLATION } from '../../src/lib/supabase';
import { lookupsRepository, type LookupOption } from '../../src/modules/lookups/lookups.repository';
import {
  ratingsRepository,
  type Issuer,
  type IssuerStats,
  type StoredRating,
} from '../../src/modules/ratings/ratings.repository';
import { usersRepository } from '../../src/modules/users/users.repository';
import type { User } from '../../src/modules/users/users.repository';
import { AUTH_HEADER, app, makeUser, signInAs } from '../helpers';

const ISSUER_ID = '9a1c0000-0000-4000-8000-000000000001';
const RATING_ID = '7b2d0000-0000-4000-8000-000000000001';

const FACTORS: LookupOption[] = [
  ['GENERAL', 'General'],
  ['BUSINESS_OF_COMPANY', 'Business of the company'],
  ['INDUSTRY', 'Industry in which company operates'],
  ['PROMOTERS', 'Promoters'],
  ['ISSUE_TERMS', 'The issue terms'],
  ['OBJECTS_OF_ISSUE', 'Objects of the issue'],
  ['FINANCIAL_HEALTH', 'Financial health'],
  ['TOP_10_SHAREHOLDERS', 'Top 10 shareholders'],
  ['OUTSTANDING_LITIGATIONS', 'Outstanding litigations'],
  ['CONTINGENT_LIABILITIES', 'Contingent liabilities'],
].map(([code, label]) => ({ code: code!, label: label! }));

const RISKS: LookupOption[] = ['Credit', 'Market', 'Liquidity', 'Legal', 'Fraud', 'Regulatory'].map(
  (label) => ({ code: label.toUpperCase(), label }),
);

const issuer: Issuer = {
  id: ISSUER_ID,
  slug: 'sovereign-alpha-yield',
  name: 'Sovereign Alpha Yield',
  instrument: 'Equity',
  assetType: 'Equity',
  exchange: 'BSE/NSE',
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
  ratingCount: 2,
  averageScore: 3.5,
  createdAt: '2026-10-01T00:00:00Z',
};

const stats: IssuerStats = {
  ratingCount: 2,
  averageScore: 3.5,
  weightedScore: 3.67,
  scoreDistribution: { '1': 0, '2': 1, '3': 0, '4': 0, '5': 1 },
  factorBreakdown: { GENERAL: { POSITIVE: 50, NEUTRAL: 0, NEGATIVE: 50 } },
  riskCounts: { CREDIT: 2, LEGAL: 1 },
  lastRatingAt: '2026-10-20T00:00:00Z',
};

const validBody = {
  overallScore: 4,
  factors: FACTORS.map(({ code }) => ({ code, flag: 'POSITIVE' as const })),
  riskFactors: ['CREDIT', 'MARKET', 'LIQUIDITY'],
};

const storedRating: StoredRating = {
  publicId: RATING_ID,
  receiptNo: 'GIG-RT-2026-000001',
  status: 'PENDING_MODERATION',
  overallScore: 4,
  moderationNote: null,
  createdAt: '2026-10-27T10:00:00Z',
  issuer: { id: ISSUER_ID, name: 'Sovereign Alpha Yield' },
  // Stored order differs from the app's factor order; the receipt follows the app's order.
  factors: [...validBody.factors].reverse(),
  riskCodes: ['CREDIT', 'MARKET', 'LIQUIDITY'],
};

const verifiedPrive = () => makeUser({ tier: 'PRIVE', kycStatus: 'APPROVED' });

function stubLookups() {
  vi.spyOn(lookupsRepository, 'findActive').mockImplementation(async (type) =>
    type === 'RATING_FACTOR' ? FACTORS : type === 'RISK_FACTOR' ? RISKS : [],
  );
}

function stubSubmission() {
  stubLookups();
  vi.spyOn(ratingsRepository, 'findByIdempotencyKey').mockResolvedValue(null);
  vi.spyOn(ratingsRepository, 'findIssuer').mockResolvedValue(issuer);
  vi.spyOn(usersRepository, 'findProfile').mockResolvedValue({
    name: 'Shreya Mehta',
    experience: null,
    jobProfile: null,
    otherJob: null,
    location: null,
    avatar: null,
  });
  vi.spyOn(ratingsRepository, 'findOwn').mockResolvedValue(storedRating);
  return vi.spyOn(ratingsRepository, 'submit').mockResolvedValue({ publicId: RATING_ID });
}

function submit(body: object = validBody, key: string | null = 'rating-key-0001') {
  const req = request(app).post(`/api/v1/issuers/${ISSUER_ID}/ratings`).set(AUTH_HEADER);
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
}

// ---------------------------------------------------------------------------------------------
describe('GET /issuers', () => {
  it('lists issuers with offer terms and the aggregate score', async () => {
    const find = vi.spyOn(ratingsRepository, 'findIssuers').mockResolvedValue({
      items: [issuer, { ...issuer, id: 'other', ratingCount: 0, averageScore: 0 }],
      total: 2,
    });

    const res = await request(app).get('/api/v1/issuers').query({
      q: 'alpha',
      sort: 'closing_soon',
      'filter[assetType]': 'Equity,Bonds',
      'filter[listed]': 'true',
    });

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 2 });
    const { ratingCount: _c, averageScore: _a, ...offerDetails } = issuer;
    expect(res.body.data[0]).toEqual({ ...offerDetails, rating: { count: 2, averageScore: 3.5 } });
    // No average until the first published rating.
    expect(res.body.data[1].rating).toEqual({ count: 0, averageScore: null });
    expect(find).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      q: 'alpha',
      sort: 'closing_soon',
      filter: { assetType: ['Equity', 'Bonds'], listed: true },
    });
  });

  it('rejects unknown sorts and filters', async () => {
    const res = await request(app).get('/api/v1/issuers').query({ sort: 'sb_recent' });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toHaveProperty('sort');
  });
});

describe('GET /issuers/:id', () => {
  it('returns the offer details', async () => {
    vi.spyOn(ratingsRepository, 'findIssuer').mockResolvedValue(issuer);
    const res = await request(app).get(`/api/v1/issuers/${ISSUER_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: ISSUER_ID, offer: { priceMin: 310, priceMax: 325 } });
  });

  it('returns 404 for an unknown issuer and 400 for a malformed id', async () => {
    vi.spyOn(ratingsRepository, 'findIssuer').mockResolvedValue(null);
    expect((await request(app).get(`/api/v1/issuers/${ISSUER_ID}`)).status).toBe(404);
    expect((await request(app).get('/api/v1/issuers/iss-1')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /issuers/:id/rating-summary', () => {
  const url = `/api/v1/issuers/${ISSUER_ID}/rating-summary`;

  beforeEach(() => {
    vi.spyOn(ratingsRepository, 'findIssuer').mockResolvedValue(issuer);
    vi.spyOn(ratingsRepository, 'findStats').mockResolvedValue(stats);
    stubLookups();
  });

  it('gives visitors and Observers the aggregate score only', async () => {
    for (const user of [null, makeUser()]) {
      if (user) signInAs(user);
      const res = await request(app)
        .get(url)
        .set(user ? AUTH_HEADER : {});
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        issuerId: ISSUER_ID,
        access: 'SUMMARY',
        ratingCount: 2,
        averageScore: 3.5,
        breakdown: null,
      });
    }
  });

  it('does not give the breakdown to Prive members without approved KYC', async () => {
    signInAs(makeUser({ tier: 'PRIVE', kycStatus: 'PENDING' }));
    expect((await request(app).get(url).set(AUTH_HEADER)).body.data.access).toBe('SUMMARY');
  });

  it.each([
    ['verified Prive', verifiedPrive()],
    ['Institutional', makeUser({ tier: 'INSTITUTIONAL', kycStatus: 'APPROVED' })],
  ] as [string, User][])(
    'gives %s members the weighted score and full breakdown',
    async (_label, user) => {
      signInAs(user);
      const res = await request(app).get(url).set(AUTH_HEADER);

      expect(res.body.data.access).toBe('FULL');
      const { breakdown } = res.body.data;
      expect(breakdown.weightedScore).toBe(3.67);
      expect(breakdown.distribution).toEqual(stats.scoreDistribution);
      expect(breakdown.factors).toHaveLength(10);
      expect(breakdown.factors[0]).toEqual({
        code: 'GENERAL',
        label: 'General',
        positive: 50,
        neutral: 0,
        negative: 50,
      });
      // Factors nobody has rated yet show zeros.
      expect(breakdown.factors[1]).toMatchObject({
        code: 'BUSINESS_OF_COMPANY',
        positive: 0,
        neutral: 0,
        negative: 0,
      });
      // Most-picked risks first, with the share of ratings that picked them.
      expect(breakdown.riskFactors.slice(0, 2)).toEqual([
        { code: 'CREDIT', label: 'Credit', count: 2, percent: 100 },
        { code: 'LEGAL', label: 'Legal', count: 1, percent: 50 },
      ]);
      expect(breakdown.lastRatedAt).toBe('2026-10-20T00:00:00Z');
    },
  );

  it('returns empty numbers before the first published rating', async () => {
    vi.spyOn(ratingsRepository, 'findStats').mockResolvedValue(null);
    signInAs(verifiedPrive());
    const res = await request(app).get(url).set(AUTH_HEADER);
    expect(res.body.data).toMatchObject({ ratingCount: 0, averageScore: null });
    expect(res.body.data.breakdown).toMatchObject({
      weightedScore: null,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    });
  });

  it('returns 404 for an unknown issuer', async () => {
    vi.spyOn(ratingsRepository, 'findIssuer').mockResolvedValue(null);
    expect((await request(app).get(url)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
describe('POST /issuers/:id/ratings: access', () => {
  it('requires sign-in', async () => {
    expect(
      (await request(app).post(`/api/v1/issuers/${ISSUER_ID}/ratings`).send(validBody)).status,
    ).toBe(401);
  });

  it.each([
    ['Observer', makeUser(), 'FORBIDDEN'],
    ['Institutional', makeUser({ tier: 'INSTITUTIONAL', kycStatus: 'APPROVED' }), 'FORBIDDEN'],
    [
      'Prive without approved KYC',
      makeUser({ tier: 'PRIVE', kycStatus: 'PENDING' }),
      'KYC_REQUIRED',
    ],
  ] as [string, User, string][])('is not open to %s', async (_label, user, code) => {
    signInAs(user);
    const res = await submit();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(code);
  });
});

describe('POST /issuers/:id/ratings: validation', () => {
  beforeEach(() => signInAs(verifiedPrive()));

  it('requires an Idempotency-Key', async () => {
    const res = await submit(validBody, null);
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toHaveProperty('Idempotency-Key');
  });

  it('returns field errors for the app', async () => {
    const res = await submit({ overallScore: 9, factors: [], riskFactors: ['CREDIT'] });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({
      overallScore: 'Rate the issuer from 1 to 5',
      factors: 'Flag every rating factor',
      riskFactors: 'Select exactly 3 risk factors',
    });
  });

  it('requires every active factor and known risk factors', async () => {
    stubSubmission();
    const res = await submit({
      ...validBody,
      factors: [...validBody.factors.slice(2), { code: 'NOT_A_FACTOR', flag: 'NEUTRAL' }],
      riskFactors: ['CREDIT', 'MARKET', 'WEATHER'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({
      'factors.8.code': 'Unknown rating factor',
      factors: 'Flag every rating factor (missing: GENERAL, BUSINESS_OF_COMPANY)',
      'riskFactors.2': 'Unknown risk factor',
    });
  });

  it('returns 404 for an unknown issuer', async () => {
    stubSubmission();
    vi.spyOn(ratingsRepository, 'findIssuer').mockResolvedValue(null);
    expect((await submit()).status).toBe(404);
  });
});

describe('POST /issuers/:id/ratings: saving', () => {
  beforeEach(() => signInAs(verifiedPrive()));

  it('saves the rating and returns the receipt', async () => {
    const save = stubSubmission();

    const res = await submit();

    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(save).toHaveBeenCalledWith({
      userId: 1,
      issuerId: ISSUER_ID,
      overallScore: 4,
      factors: validBody.factors,
      riskCodes: ['CREDIT', 'MARKET', 'LIQUIDITY'],
      idempotencyKey: 'rating-key-0001',
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(res.body.data).toMatchObject({
      id: RATING_ID,
      receiptNo: 'GIG-RT-2026-000001',
      status: 'PENDING_MODERATION',
      issuer: { id: ISSUER_ID, name: 'Sovereign Alpha Yield' },
      overallScore: 4,
      riskFactors: [
        { code: 'CREDIT', label: 'Credit' },
        { code: 'MARKET', label: 'Market' },
        { code: 'LIQUIDITY', label: 'Liquidity' },
      ],
      rater: { name: 'Shreya Mehta', tier: 'PRIVE' },
    });
    expect(res.body.data.factors.map((f: { code: string }) => f.code)).toEqual(
      FACTORS.map((f) => f.code),
    );
    expect(res.body.data.factors[3]).toEqual({
      code: 'PROMOTERS',
      label: 'Promoters',
      flag: 'POSITIVE',
    });
  });

  it('returns 409 when the investor already rated this issuer', async () => {
    stubSubmission().mockRejectedValue(
      new DatabaseError(
        PG_UNIQUE_VIOLATION,
        'duplicate key value violates unique constraint "issuer_ratings_one_per_user_idx"',
      ),
    );
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RATING_ALREADY_SUBMITTED');
  });

  it('returns the same receipt for a retry with the same key and body', async () => {
    const save = stubSubmission();
    await submit();
    const { requestHash } = save.mock.calls[0]![0];
    vi.spyOn(ratingsRepository, 'findByIdempotencyKey').mockResolvedValue({
      publicId: RATING_ID,
      requestHash,
    });

    const retry = await submit();

    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.id).toBe(RATING_ID);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('refuses the same key with a different body', async () => {
    stubSubmission();
    vi.spyOn(ratingsRepository, 'findByIdempotencyKey').mockResolvedValue({
      publicId: RATING_ID,
      requestHash: 'other',
    });
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('returns the existing rating when a concurrent retry saved it first', async () => {
    const save = stubSubmission();
    const findByKey = vi
      .spyOn(ratingsRepository, 'findByIdempotencyKey')
      .mockResolvedValueOnce(null);
    save.mockImplementation(async (rating) => {
      findByKey.mockResolvedValue({ publicId: RATING_ID, requestHash: rating.requestHash });
      throw new DatabaseError(
        PG_UNIQUE_VIOLATION,
        'duplicate key value violates unique constraint "issuer_ratings_idempotency_key_idx"',
      );
    });

    const res = await submit();

    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replayed']).toBe('true');
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /ratings/me', () => {
  it('requires sign-in', async () => {
    expect((await request(app).get('/api/v1/ratings/me')).status).toBe(401);
  });

  it("lists the user's ratings, newest first, and is never cached", async () => {
    signInAs(makeUser());
    const find = vi.spyOn(ratingsRepository, 'findMine').mockResolvedValue({
      items: [
        {
          publicId: RATING_ID,
          receiptNo: 'GIG-RT-2026-000001',
          status: 'PUBLISHED',
          overallScore: 4,
          createdAt: '2026-10-27T10:00:00Z',
          issuer: { id: ISSUER_ID, name: 'Sovereign Alpha Yield' },
        },
      ],
      total: 1,
    });

    const res = await request(app).get('/api/v1/ratings/me?status=PUBLISHED').set(AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: [
        {
          id: RATING_ID,
          receiptNo: 'GIG-RT-2026-000001',
          status: 'PUBLISHED',
          issuer: { id: ISSUER_ID, name: 'Sovereign Alpha Yield' },
          overallScore: 4,
          createdAt: '2026-10-27T10:00:00Z',
        },
      ],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    expect(find).toHaveBeenCalledWith(1, { page: 1, pageSize: 20, status: ['PUBLISHED'] });
  });
});
