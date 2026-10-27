import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { allChainArgs, chainArgs, fake, tokenFor, type FakeCall } from '../helpers/fakeSupabase';
import {
  COMPANY_A,
  COMPANY_B,
  REVIEW_ID,
  companyCardRow,
  reviewFeedRow,
} from '../helpers/fixtures';

vi.mock('../../src/lib/supabase', async () => {
  const { fake } = await import('../helpers/fakeSupabase');
  return { supabaseAdmin: fake.client };
});
vi.mock('../../src/lib/auth', async () => {
  const { fakeAuthProvider } = await import('../helpers/fakeSupabase');
  return { authProvider: fakeAuthProvider };
});
vi.mock('../../src/modules/users/users.repository', async (importOriginal) => {
  const { fakeUsersRepository } = await import('../helpers/fakeSupabase');
  const original = await importOriginal<typeof import('../../src/modules/users/users.repository')>();
  return { ...original, usersRepository: { ...original.usersRepository, ...fakeUsersRepository } };
});

const app = createApp();
const auth = (user: Parameters<typeof tokenFor>[0]) => ({
  Authorization: `Bearer ${tokenFor(user)}`,
});

/** The company exists check (head count on companies). */
const companyExists = (exists: boolean) => fake.on('from:companies', { count: exists ? 1 : 0 });

beforeEach(() => fake.reset());

// ---------------------------------------------------------------------------------------------
describe('GET /api/v1/companies', () => {
  it('returns company cards with paging meta', async () => {
    fake.on('rpc:search_companies', { data: [companyCardRow()], count: 1 });

    const res = await request(app).get('/api/v1/companies');

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(res.body.data).toEqual([
      {
        id: COMPANY_A,
        slug: 'astra-mutuals',
        name: 'Astra Mutuals',
        description: 'Mutual fund house.',
        assetClass: 'MF',
        country: 'IN',
        logoUrl: null,
        verified: true,
        tags: ['Large CAP Stocks', 'ETF', 'IPO'],
        totalReviews: 12,
        rating: 4.56,
        avgScore: 5,
        sentiment: 'Positive',
        sentimentSplit: { positive: 66.67, neutral: 16.67, negative: 16.66 },
        resolution: 'RESOLVED',
        createdAt: '2026-01-10T00:00:00Z',
      },
    ]);
  });

  it('gives no star score to a company without reviews', async () => {
    fake.on('rpc:search_companies', {
      data: [companyCardRow({ review_count: 0, score: 0, dominant_sentiment: null })],
      count: 1,
    });
    const res = await request(app).get('/api/v1/companies');
    expect(res.body.data[0]).toMatchObject({
      totalReviews: 0,
      rating: 0,
      avgScore: null,
      sentiment: null,
    });
  });

  it('passes search and all filters to the database', async () => {
    fake.on('rpc:search_companies', { data: [], count: 0 });

    await request(app)
      .get('/api/v1/companies')
      .query({
        q: '50%_off',
        'filter[sentiment]': 'Positive,Neutral',
        'filter[assetClass]': 'MF',
        'filter[resolution]': 'RESOLVED',
        'filter[score]': '5,4',
        'filter[country]': 'IN,AE',
        'filter[investedStatus]': 'EXITED',
        'filter[year]': '2024,2025,before_2021',
      })
      .expect(200);

    const [call] = fake.callsTo('rpc:search_companies');
    expect(call?.args).toEqual([
      {
        p_q: '50\\%\\_off', // LIKE wildcards escaped
        p_sentiments: ['Positive', 'Neutral'],
        p_asset_classes: ['MF'],
        p_resolutions: ['RESOLVED'],
        p_scores: [5, 4],
        p_countries: ['IN', 'AE'],
        p_investment_statuses: ['EXITED'],
        p_years: [2024, 2025],
        p_years_before: 2021,
      },
      { count: 'exact' },
    ]);
  });

  it('leaves unused filters unset', async () => {
    fake.on('rpc:search_companies', { data: [], count: 0 });
    await request(app).get('/api/v1/companies').expect(200);
    const args = fake.callsTo('rpc:search_companies')[0]?.args[0] as Record<string, unknown>;
    expect(Object.values(args).every((v) => v === undefined)).toBe(true);
  });

  it.each([
    [
      'relevant',
      [
        ['relevance', false],
        ['review_count', false],
      ],
    ],
    ['recent', [['created_at', false]]],
    [
      'trending',
      [
        ['reviews_30d', false],
        ['review_count', false],
      ],
    ],
    [
      'top_rated',
      [
        ['score', false],
        ['review_count', false],
      ],
    ],
    [
      'most_reviewed',
      [
        ['review_count', false],
        ['score', false],
      ],
    ],
    [
      'improving',
      [
        ['score_change_12m', false],
        ['score', false],
      ],
    ],
  ] as const)('sort=%s orders by the matching columns', async (sort, expected) => {
    fake.on('rpc:search_companies', { data: [], count: 0 });
    await request(app).get('/api/v1/companies').query({ sort }).expect(200);

    const orders = allChainArgs(fake.callsTo('rpc:search_companies')[0], 'order');
    expect(orders).toEqual([
      ...expected.map(([column, ascending]) => [column, { ascending }]),
      ['id'], // stable tie-break
    ]);
  });

  it('requests the right page', async () => {
    fake.on('rpc:search_companies', { data: [], count: 45 });
    const res = await request(app).get('/api/v1/companies').query({ page: 3, pageSize: 10 });
    expect(chainArgs(fake.callsTo('rpc:search_companies')[0], 'range')).toEqual([20, 29]);
    expect(res.body.meta).toEqual({ page: 3, pageSize: 10, total: 45 });
  });

  it('returns an empty page (with the real total) past the last page', async () => {
    fake.on('rpc:search_companies', (call: FakeCall) =>
      (call.args[1] as { head?: boolean }).head
        ? { count: 7 }
        : { error: { code: 'PGRST103', message: 'Requested range not satisfiable' } },
    );
    const res = await request(app).get('/api/v1/companies').query({ page: 9 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], meta: { page: 9, pageSize: 20, total: 7 } });
  });

  it('rejects invalid query parameters with field errors', async () => {
    const res = await request(app)
      .get('/api/v1/companies')
      .query({ sort: 'sb_recent', 'filter[score]': '7', pageSize: 500 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.fields).sort()).toEqual([
      'filter.score.0',
      'pageSize',
      'sort',
    ]);
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /api/v1/companies/:id', () => {
  const scorecard = {
    transparency: 4.1,
    responsiveness: 3.9,
    easeOfProcess: 4.2,
    trustworthiness: 4.4,
    overallSatisfaction: 4.5,
  };

  beforeEach(() => fake.on('from:company_cards', { data: companyCardRow() }));

  it('shows header, sentiment split and scorecard to signed-out visitors, without analytics', async () => {
    const res = await request(app).get(`/api/v1/companies/${COMPANY_A}`).expect(200);
    expect(res.body.data).toMatchObject({
      id: COMPANY_A,
      name: 'Astra Mutuals',
      access: 'SUMMARY',
      sentimentSplit: { positive: 66.67, neutral: 16.67, negative: 16.66 },
      scorecard,
      analytics: null,
    });
    expect(chainArgs(fake.callsTo('from:company_cards')[0], 'eq')).toEqual(['id', COMPANY_A]);
  });

  it.each(['observer', 'privePending'] as const)('gives %s the summary only', async (user) => {
    const res = await request(app)
      .get(`/api/v1/companies/${COMPANY_A}`)
      .set(auth(user))
      .expect(200);
    expect(res.body.data).toMatchObject({ access: 'SUMMARY', analytics: null });
  });

  it.each(['prive', 'institutional'] as const)('gives %s full analytics', async (user) => {
    const res = await request(app)
      .get(`/api/v1/companies/${COMPANY_A}`)
      .set(auth(user))
      .expect(200);
    expect(res.body.data).toMatchObject({
      access: 'FULL',
      scorecard,
      analytics: {
        resolutionLens: { resolved: 50, inProgress: 25, unresolved: 16.67, notContacted: 8.33 },
        reviewsLast30Days: 3,
        scoreChange12m: 0.4,
        lastReviewAt: '2026-10-20T00:00:00Z',
      },
    });
  });

  it('returns 404 for an unknown company', async () => {
    fake.on('from:company_cards', { data: null });
    const res = await request(app).get(`/api/v1/companies/${COMPANY_B}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: 'Company not found' });
  });

  it('rejects an id that is not a UUID', async () => {
    const res = await request(app).get('/api/v1/companies/c1');
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ id: 'Must be a valid id' });
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /api/v1/companies/compare', () => {
  const rows = [
    companyCardRow(),
    companyCardRow({ id: COMPANY_B, name: 'Zenith Capital', asset_class: 'EQ', score: 3.1 }),
  ];

  it('requires sign-in', async () => {
    const res = await request(app).get(`/api/v1/companies/compare?ids=${COMPANY_A},${COMPANY_B}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns companies in the requested order, without lens for an Observer', async () => {
    fake.on('from:company_cards', { data: rows });
    const res = await request(app)
      .get(`/api/v1/companies/compare?ids=${COMPANY_B},${COMPANY_A}`)
      .set(auth('observer'))
      .expect(200);

    expect(res.body.data.map((c: { name: string }) => c.name)).toEqual([
      'Zenith Capital',
      'Astra Mutuals',
    ]);
    expect(res.body.data[1]).toEqual({
      id: COMPANY_A,
      name: 'Astra Mutuals',
      assetClass: 'MF',
      totalReviews: 12,
      rating: 4.56,
      sentimentSplit: { positive: 66.67, neutral: 16.67, negative: 16.66 },
      scorecard: {
        transparency: 4.1,
        responsiveness: 3.9,
        easeOfProcess: 4.2,
        trustworthiness: 4.4,
        overallSatisfaction: 4.5,
      },
      resolutionLens: null,
      scoreChange12m: null,
    });
    expect(allChainArgs(fake.callsTo('from:company_cards')[0], 'in')).toEqual([
      ['id', [COMPANY_B, COMPANY_A]],
    ]);
  });

  it('adds resolution lens and 12-month change for full-access members', async () => {
    fake.on('from:company_cards', { data: rows });
    const res = await request(app)
      .get(`/api/v1/companies/compare?ids=${COMPANY_A},${COMPANY_B}`)
      .set(auth('institutional'))
      .expect(200);
    expect(res.body.data[0]).toMatchObject({
      resolutionLens: { resolved: 50, inProgress: 25, unresolved: 16.67, notContacted: 8.33 },
      scoreChange12m: 0.4,
    });
  });

  it('returns 404 naming a company that does not exist', async () => {
    fake.on('from:company_cards', { data: [rows[0]] });
    const res = await request(app)
      .get(`/api/v1/companies/compare?ids=${COMPANY_A},${COMPANY_B}`)
      .set(auth('prive'));
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe(`Company not found: ${COMPANY_B}`);
  });

  it('needs 2 to 4 valid ids', async () => {
    for (const ids of [COMPANY_A, `${COMPANY_A},nope`, `${COMPANY_A},${COMPANY_A}`]) {
      const res = await request(app).get(`/api/v1/companies/compare?ids=${ids}`).set(auth('prive'));
      expect(res.status, ids).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /api/v1/companies/:id/trends', () => {
  const url = `/api/v1/companies/${COMPANY_A}/trends`;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    companyExists(true);
    // One review in Sept 2025 (overall 2, negative) and one in Oct 2026 (overall 5, positive).
    fake.on('from:company_trend_points', {
      data: [
        { month: '2025-09-01', review_count: 1, overall_sum: 2, positive_count: 0 },
        { month: '2026-10-01', review_count: 1, overall_sum: 5, positive_count: 1 },
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('requires sign-in', async () => {
    expect((await request(app).get(url)).status).toBe(401);
  });

  it.each(['observer', 'privePending'] as const)('is not available to %s', async (user) => {
    const res = await request(app).get(url).set(auth(user));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('computes the 12-month series and change vs 12 months ago', async () => {
    const res = await request(app).get(url).set(auth('prive')).expect(200);
    const { data } = res.body;

    expect(data.range).toBe('12M');
    expect(data.reviewCount).toBe(1);
    expect(data.overallSatisfaction.points).toHaveLength(12);
    expect(data.overallSatisfaction.points[0]).toEqual({ month: '2025-11', value: 2 });
    expect(data.overallSatisfaction.points.at(-1)).toEqual({ month: '2026-10', value: 3.5 });
    expect(data.overallSatisfaction).toMatchObject({ value: 3.5, change: 1.5 });
    expect(data.positiveSentiment).toMatchObject({ value: 50, change: 50 });
  });

  it('computes 24-month and all-time ranges', async () => {
    const res24 = await request(app)
      .get(url)
      .query({ range: '24M' })
      .set(auth('institutional'))
      .expect(200);
    expect(res24.body.data.overallSatisfaction.points).toHaveLength(24);
    expect(res24.body.data.overallSatisfaction.points[0]).toEqual({
      month: '2024-11',
      value: null,
    });
    // Nothing before the window, so there is no "24 months ago" value to compare with.
    expect(res24.body.data.overallSatisfaction).toMatchObject({ value: 3.5, change: null });

    const resAll = await request(app)
      .get(url)
      .query({ range: 'ALL' })
      .set(auth('prive'))
      .expect(200);
    expect(resAll.body.data.overallSatisfaction.points).toHaveLength(14); // Sept 2025 .. Oct 2026
    expect(resAll.body.data.overallSatisfaction).toMatchObject({ value: 3.5, change: 1.5 }); // since launch
    expect(resAll.body.data.reviewCount).toBe(2);
  });

  it('returns empty values for a company without reviews', async () => {
    fake.on('from:company_trend_points', { data: [] });
    const res = await request(app).get(url).set(auth('prive')).expect(200);
    expect(res.body.data.overallSatisfaction.value).toBe(null);
    expect(res.body.data.overallSatisfaction.change).toBe(null);
    expect(
      res.body.data.overallSatisfaction.points.every((p: { value: unknown }) => p.value === null),
    ).toBe(true);
  });

  it('returns 404 for an unknown company and 400 for a bad range', async () => {
    companyExists(false);
    expect((await request(app).get(url).set(auth('prive'))).status).toBe(404);
    expect((await request(app).get(url).query({ range: '6M' }).set(auth('prive'))).status).toBe(
      400,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /api/v1/companies/:id/reviews', () => {
  const url = `/api/v1/companies/${COMPANY_A}/reviews`;
  const longText = `${'This fund was a good experience overall. '.repeat(6)}End.`;

  beforeEach(() => {
    companyExists(true);
    fake.on('from:review_feed', {
      data: [
        reviewFeedRow({ detailed_review: longText }),
        reviewFeedRow({ id: 'r2', display_mode: 'ANONYMOUS', author_name: null }),
      ],
      count: 2,
    });
  });

  it('shows signed-out visitors and Observers a summary only', async () => {
    for (const headers of [{}, auth('observer')]) {
      const res = await request(app).get(url).set(headers).expect(200);
      const [first, second] = res.body.data;
      expect(first).toEqual({
        detail: 'SUMMARY',
        id: REVIEW_ID,
        author: { name: 'S. M.', anonymous: false },
        country: 'IN',
        assetClass: 'MF',
        productScheme: 'Bluechip',
        investmentYear: 2024,
        investmentStatus: 'CURRENTLY_INVESTED',
        sentiment: 'Positive',
        avgRating: 4.4,
        excerpt: expect.stringMatching(/…$/),
        resolutionStatus: 'RESOLVED',
        createdAt: '2026-10-01T00:00:00Z',
      });
      expect(first.excerpt.length).toBeLessThanOrEqual(161);
      expect(first).not.toHaveProperty('metrics');
      expect(second.author).toEqual({ name: null, anonymous: true });
      expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 2 });
    }
  });

  it('shows full reviews to verified Prive and Institutional members', async () => {
    for (const user of ['prive', 'institutional'] as const) {
      const res = await request(app).get(url).set(auth(user)).expect(200);
      expect(res.body.data[1]).toMatchObject({
        detail: 'FULL',
        detailedReview: 'Payouts always arrived on time.',
        reinvestStatus: 'YES',
        appreciations: ['TIMELY_PAYOUTS'],
        concerns: [],
        contactStatus: [],
        metrics: {
          transparency: 4,
          responsiveness: 5,
          easeOfProcess: 4,
          trustworthiness: 4,
          overallSatisfaction: 5,
        },
        followUpNote: null,
      });
    }
  });

  it('applies filters and sorting', async () => {
    await request(app)
      .get(url)
      .query({
        sort: 'lowest',
        'filter[sentiment]': 'Negative',
        'filter[resolution]': 'UNRESOLVED,NOT_CONTACTED',
        'filter[assetClass]': 'MF',
        'filter[investedStatus]': 'EXITED',
        'filter[year]': '2024',
        page: 2,
        pageSize: 5,
      })
      .expect(200);

    const call = fake.callsTo('from:review_feed')[0];
    expect(allChainArgs(call, 'eq')).toEqual([['company_id', COMPANY_A]]);
    expect(allChainArgs(call, 'in')).toEqual([
      ['sentiment', ['Negative']],
      ['resolution_bucket', ['UNRESOLVED', 'NOT_CONTACTED']],
      ['asset_class', ['MF']],
      ['investment_status', ['EXITED']],
      ['investment_year', [2024]],
    ]);
    expect(allChainArgs(call, 'order')).toEqual([
      ['avg_rating', { ascending: true }],
      ['created_at', { ascending: false }],
      ['id'],
    ]);
    expect(chainArgs(call, 'range')).toEqual([5, 9]);
  });

  it('returns 404 for an unknown company', async () => {
    companyExists(false);
    expect((await request(app).get(url)).status).toBe(404);
  });
});
