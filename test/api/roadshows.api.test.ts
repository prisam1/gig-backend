import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { chainArgs, fake, tokenFor, type TestUser } from '../helpers/fakeSupabase';

vi.mock('../../src/lib/supabase', async (importOriginal) => {
  const { fake } = await import('../helpers/fakeSupabase');
  const original = await importOriginal<typeof import('../../src/lib/supabase')>();
  return { ...original, supabaseAdmin: fake.client };
});
vi.mock('../../src/lib/auth', async () => {
  const { fakeAuthProvider } = await import('../helpers/fakeSupabase');
  return { authProvider: fakeAuthProvider };
});
vi.mock('../../src/modules/users/users.repository', async (importOriginal) => {
  const { fakeUsersRepository } = await import('../helpers/fakeSupabase');
  const original =
    await importOriginal<typeof import('../../src/modules/users/users.repository')>();
  return { ...original, usersRepository: { ...original.usersRepository, ...fakeUsersRepository } };
});

const app = createApp();
const auth = (user: TestUser) => ({ Authorization: `Bearer ${tokenFor(user)}` });
const RS = '7a000000-0000-4000-8000-000000000001';
const DOC = '7d000000-0000-4000-8000-000000000001';
const future = new Date(Date.now() + 86_400_000).toISOString();

const roadshowRef = (overrides: Record<string, unknown> = {}) => ({
  id: RS,
  title: 'Meridian Green Bonds',
  currency: 'INR',
  opens_at: null,
  closes_at: future,
  pool_enabled: true,
  ...overrides,
});

const poolBody = {
  capitalInterest: 250000,
  expectations: ['PRIORITY_ALLOTMENT', 'BETTER_ROI_IRR', 'SHORTER_LOCK_IN'],
};

beforeEach(() => fake.reset());

describe('access rules', () => {
  it('requires a token for financials and Full access for DD documents', async () => {
    expect((await request(app).get(`/api/v1/roadshows/${RS}/financials`)).status).toBe(401);
    const res = await request(app)
      .get(`/api/v1/roadshows/${RS}/documents/${DOC}`)
      .set(auth('observer'));
    expect(res.status).toBe(403);
  });

  it('lets only verified Prive members join the pool and ask questions', async () => {
    for (const user of ['observer', 'privePending', 'institutional'] as const) {
      const res = await request(app)
        .post(`/api/v1/roadshows/${RS}/pool`)
        .set(auth(user))
        .set('Idempotency-Key', 'key-12345678')
        .send(poolBody);
      expect(res.status, user).toBe(403);
    }
  });

  it('lets only Institutional members post offers', async () => {
    const res = await request(app)
      .post(`/api/v1/roadshows/${RS}/offers`)
      .set(auth('prive'))
      .send({ offerPrice: 100 });
    expect(res.status).toBe(403);
  });
});

describe('GET /roadshows/:id/financials', () => {
  it('converts the reporting currency with the latest FX rates', async () => {
    fake.on('from:roadshows', { data: roadshowRef() });
    fake.on('from:fx_rates', {
      data: [
        { currency: 'INR', per_usd: 80, as_of: '2026-10-26T00:00:00Z' },
        { currency: 'USD', per_usd: 1, as_of: '2026-10-27T00:00:00Z' },
      ],
    });
    fake.on('from:roadshow_financials', {
      data: [
        { fiscal_year: 2026, revenue: 8000, eps: 10, ebitda: null },
        { fiscal_year: 2025, revenue: 4000, eps: 5, ebitda: null },
      ],
    });

    const res = await request(app)
      .get(`/api/v1/roadshows/${RS}/financials?currency=USD`)
      .set(auth('observer'));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      currency: 'USD',
      reportingCurrency: 'INR',
      fx: { rate: 0.0125, asOf: '2026-10-26T00:00:00Z' },
    });
    expect(res.body.data.years.map((y: { fiscalYear: number }) => y.fiscalYear)).toEqual([
      2025, 2026,
    ]);
    expect(res.body.data.years[1]).toMatchObject({ revenue: 100, eps: 0.125, ebitda: null });
  });

  it('rejects unknown currencies', async () => {
    const res = await request(app)
      .get(`/api/v1/roadshows/${RS}/financials?currency=JPY`)
      .set(auth('observer'));
    expect(res.status).toBe(400);
  });
});

describe('GET /roadshows/:id/documents/:docId', () => {
  it('returns a 5-minute signed download URL', async () => {
    fake.on('from:roadshows', { data: roadshowRef() });
    fake.on('from:roadshow_documents', {
      data: { id: DOC, title: 'Offer document', storage_path: 'meridian/offer.pdf' },
    });
    fake.on('signedUrl:roadshow-documents', { data: { signedUrl: 'https://signed.example/x' } });

    const res = await request(app)
      .get(`/api/v1/roadshows/${RS}/documents/${DOC}`)
      .set(auth('institutional'));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ url: 'https://signed.example/x', fileName: 'offer.pdf' });
    expect(fake.callsTo('signedUrl:roadshow-documents')[0]?.args).toEqual([
      'meridian/offer.pdf',
      300,
      { download: 'offer.pdf' },
    ]);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /roadshows/:id/pool', () => {
  const join = (key: string | null = 'key-12345678', body: object = poolBody) => {
    const req = request(app).post(`/api/v1/roadshows/${RS}/pool`).set(auth('prive'));
    if (key) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  it('needs an Idempotency-Key and at least 3 distinct expectations', async () => {
    expect((await join(null)).status).toBe(400);
    const res = await join('key-12345678', { ...poolBody, expectations: ['BETTER_ROI_IRR'] });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.expectations).toBe('Pick at least 3 expectations');
  });

  it('joins through the transactional RPC and returns the remaining credits', async () => {
    fake.on('from:pool_members', { data: null });
    fake.on('from:roadshows', { data: roadshowRef() });
    fake.on('rpc:join_roadshow_pool', {
      data: { joined_at: '2026-10-27T10:00:00Z', credits_remaining: 4 },
    });

    const res = await join();

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      roadshowId: RS,
      capitalInterest: 250000,
      currency: 'INR',
      expectations: ['BETTER_ROI_IRR', 'SHORTER_LOCK_IN', 'PRIORITY_ALLOTMENT'],
      joinedAt: '2026-10-27T10:00:00Z',
      creditsRemaining: 4,
    });
    expect(fake.callsTo('rpc:join_roadshow_pool')[0]?.args[0]).toMatchObject({
      p_user_id: '22222222-2222-4222-8222-222222222222',
      p_roadshow_id: RS,
      p_capital_interest: 250000,
      p_idempotency_key: 'key-12345678',
    });
  });

  it('answers 402 INSUFFICIENT_CREDITS at 0 credits', async () => {
    fake.on('from:pool_members', { data: null });
    fake.on('from:roadshows', { data: roadshowRef() });
    fake.on('rpc:join_roadshow_pool', {
      error: { code: 'P0001', message: 'INSUFFICIENT_CREDITS' },
    });

    const res = await join();
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_CREDITS');
  });

  it('replays a retry with the same key without spending again', async () => {
    let hash = '';
    fake.on('from:roadshows', { data: roadshowRef() });
    fake.on('rpc:join_roadshow_pool', (call) => {
      hash = (call.args[0] as { p_request_hash: string }).p_request_hash;
      return { data: { joined_at: '2026-10-27T10:00:00Z', credits_remaining: 4 } };
    });
    fake.on('from:pool_members', { data: null });
    await join();

    fake.on('from:pool_members', {
      data: {
        capital_interest: 250000,
        idempotency_key: 'key-12345678',
        request_hash: hash,
        created_at: '2026-10-27T10:00:00Z',
        roadshow: { currency: 'INR' },
        roadshow_improvement_votes: poolBody.expectations.map((expectation) => ({ expectation })),
      },
    });
    fake.on('from:users', { data: { credit_balance: 4 } });

    const retry = await join();
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.creditsRemaining).toBe(4);
    expect(fake.callsTo('rpc:join_roadshow_pool')).toHaveLength(1);
  });

  it('rejects joining again with a new key', async () => {
    fake.on('from:pool_members', {
      data: { idempotency_key: 'other-key-1', request_hash: 'x' },
    });
    const res = await join();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_IN_POOL');
  });
});

describe('GET /roadshows/:id/pool-power', () => {
  it('summarises participants, demand and the heat map', async () => {
    fake.on('from:roadshows', { data: roadshowRef() });
    const band = (n: number, members: number, capital: number) =>
      ['BETTER_ROI_IRR', 'SHORTER_LOCK_IN'].map((expectation, i) => ({
        band: n,
        band_min: capital / members,
        band_max: capital / members,
        band_members: members,
        band_capital: capital,
        expectation,
        votes: i === 0 ? members : 0,
      }));
    fake.on('rpc:roadshow_pool_power', { data: [...band(1, 1, 1000), ...band(2, 1, 3000)] });

    const res = await request(app).get(`/api/v1/roadshows/${RS}/pool-power`).set(auth('observer'));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      participants: 2,
      totalCapitalInterest: 4000,
      averageCapitalInterest: 2000,
    });
    expect(res.body.data.improvements[0]).toEqual({
      expectation: 'BETTER_ROI_IRR',
      members: 2,
      percent: 100,
    });
    expect(res.body.data.heatMap.bands).toEqual([
      { band: 1, minCapital: 1000, maxCapital: 1000, members: 1 },
      { band: 2, minCapital: 3000, maxCapital: 3000, members: 1 },
    ]);
  });
});

describe('questions', () => {
  it('lists published questions, Top Asked ordering featured first', async () => {
    fake.on('from:roadshows', { data: roadshowRef() });
    fake.on('from:roadshow_questions', { data: [], count: 0 });

    const res = await request(app)
      .get(`/api/v1/roadshows/${RS}/questions?sort=top&category=EQUITY`)
      .set(auth('observer'));

    expect(res.status).toBe(200);
    const call = fake.callsTo('from:roadshow_questions')[0];
    expect(chainArgs(call, 'order')).toEqual(['featured', { ascending: false }]);
    expect(chainArgs(call, 'in')).toEqual(['category', ['EQUITY']]);
  });

  it('refuses new questions once the roadshow has closed', async () => {
    fake.on('from:roadshows', { data: roadshowRef({ closes_at: '2020-01-01T00:00:00Z' }) });
    const res = await request(app)
      .post(`/api/v1/roadshows/${RS}/questions`)
      .set(auth('prive'))
      .send({ question: 'What is the use of proceeds?' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROADSHOW_CLOSED');
  });
});
