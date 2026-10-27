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
  const { fakeLoadMember } = await import('../helpers/fakeSupabase');
  return { authProvider: { loadMember: fakeLoadMember } };
});

const app = createApp();
const auth = (user: TestUser) => ({ Authorization: `Bearer ${tokenFor(user)}` });
const ITEM = '1e000000-0000-4000-8000-000000000001';
const COMPANY = '8f1c2b9e-0000-4000-8000-00000000000a';

const learnRow = (overrides: Record<string, unknown> = {}) => ({
  id: ITEM,
  title: 'Fund house scorecard',
  summary: null,
  format: 'REPORT',
  category: 'Research',
  access: 'PREMIUM',
  thumbnail_url: null,
  content_url: 'https://example.com/report',
  duration_seconds: null,
  download_path: 'reports/scorecard.pdf',
  rating_avg: 4.5,
  rating_count: 2,
  status: 'PUBLISHED',
  published_at: '2026-10-20T00:00:00Z',
  ...overrides,
});

beforeEach(() => { fake.reset(); });

describe('learn', () => {
  it('locks PREMIUM content for signed-out visitors', async () => {
    fake.on('from:learn_items', { data: learnRow() });
    const res = await request(app).get(`/api/v1/learn/${ITEM}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ locked: true, contentUrl: null, download: null });
  });

  it('gives Full members the content and a signed report download', async () => {
    fake.on('from:learn_items', { data: learnRow() });
    fake.on('from:learn_ratings', { data: { rating: 4 } });
    fake.on('signedUrl:learn-reports', { data: { signedUrl: 'https://signed.example/r' } });

    const res = await request(app).get(`/api/v1/learn/${ITEM}`).set(auth('prive'));

    expect(res.body.data).toMatchObject({
      locked: false,
      contentUrl: 'https://example.com/report',
      download: { url: 'https://signed.example/r', fileName: 'scorecard.pdf' },
      myRating: 4,
    });
  });

  it('does not let Observers rate content they cannot open', async () => {
    fake.on('from:learn_items', { data: learnRow() });
    const res = await request(app)
      .post(`/api/v1/learn/${ITEM}/rating`)
      .set(auth('observer'))
      .send({ rating: 5 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PREMIUM_CONTENT');
  });

  it('upserts a rating and returns the refreshed average', async () => {
    fake.on('from:learn_items', {
      data: learnRow({ access: 'FREE', rating_avg: 4, rating_count: 3 }),
    });
    fake.on('from:learn_ratings', { data: null });

    const res = await request(app)
      .post(`/api/v1/learn/${ITEM}/rating`)
      .set(auth('observer'))
      .send({ rating: 5 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ rating: 5, average: 4, count: 3 });
    expect(chainArgs(fake.callsTo('from:learn_ratings')[0], 'upsert')?.[1]).toEqual({
      onConflict: 'learn_item_id,user_id',
    });
  });

  it('validates the rating', async () => {
    const res = await request(app)
      .post(`/api/v1/learn/${ITEM}/rating`)
      .set(auth('observer'))
      .send({ rating: 6 });
    expect(res.status).toBe(400);
  });
});

describe('saved items', () => {
  it('saves an existing company and returns its summary', async () => {
    fake.on('from:companies', {
      data: [{ id: COMPANY, name: 'Astra Mutuals', asset_class: 'MF', logo_url: null }],
    });
    fake.on('from:saved_items', { data: { created_at: '2026-10-27T10:00:00Z' } });

    const res = await request(app)
      .post('/api/v1/me/saved')
      .set(auth('observer'))
      .send({ type: 'COMPANY', id: COMPANY });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      type: 'COMPANY',
      id: COMPANY,
      savedAt: '2026-10-27T10:00:00Z',
      entity: { name: 'Astra Mutuals', subtitle: 'MF', imageUrl: null },
    });
  });

  it('404s for items that do not exist', async () => {
    fake.on('from:roadshows', { data: [] });
    const res = await request(app)
      .post('/api/v1/me/saved')
      .set(auth('observer'))
      .send({ type: 'ROADSHOW', id: COMPANY });
    expect(res.status).toBe(404);
  });

  it('lists saved items with null entities for removed ones', async () => {
    fake.on('from:saved_items', {
      data: [{ entity_type: 'COMPANY', entity_id: COMPANY, created_at: '2026-10-27T10:00:00Z' }],
      count: 1,
    });
    fake.on('from:companies', { data: [] });

    const res = await request(app).get('/api/v1/me/saved').set(auth('observer'));

    expect(res.body).toEqual({
      data: [{ type: 'COMPANY', id: COMPANY, savedAt: '2026-10-27T10:00:00Z', entity: null }],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
  });

  it('removes a saved item', async () => {
    fake.on('from:saved_items', { data: null });
    const res = await request(app)
      .delete(`/api/v1/me/saved/COMPANY/${COMPANY}`)
      .set(auth('observer'));
    expect(res.status).toBe(204);
  });
});

describe('credits', () => {
  it('returns the balance and ledger page', async () => {
    fake.on('from:credit_ledger', {
      data: [
        {
          id: 7,
          user_id: 'u',
          delta: -1,
          balance_after: 3,
          reason: 'POOL_JOIN',
          ref_type: 'ROADSHOW',
          ref_id: COMPANY,
          note: null,
          created_at: '2026-10-27T10:00:00Z',
        },
      ],
      count: 1,
    });

    const res = await request(app).get('/api/v1/me/credits').set(auth('prive'));

    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBe(3);
    expect(res.body.data.entries[0]).toMatchObject({
      delta: -1,
      reason: 'POOL_JOIN',
      ref: { type: 'ROADSHOW', id: COMPANY },
    });
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
  });
});

describe('notifications and devices', () => {
  it('returns the inbox with the unread badge count', async () => {
    fake.on('from:notifications', { data: [], count: 5 });
    const res = await request(app).get('/api/v1/me/notifications').set(auth('observer'));
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 5, unread: 5 });
  });

  it('registers a push token', async () => {
    fake.on('from:device_tokens', {
      data: { platform: 'IOS', last_seen_at: '2026-10-27T10:00:00Z' },
    });
    const res = await request(app)
      .post('/api/v1/me/devices')
      .set(auth('observer'))
      .send({ token: 'a'.repeat(64), platform: 'IOS' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ platform: 'IOS', registeredAt: '2026-10-27T10:00:00Z' });
  });

  it('requires a signed-in user', async () => {
    expect((await request(app).get('/api/v1/me/notifications')).status).toBe(401);
  });
});
