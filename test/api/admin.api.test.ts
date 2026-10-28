import request from 'supertest';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createApp } from '../../src/app';
import { encrypt, keyedHash } from '../../src/lib/crypto';
import { dbTransport } from '../../src/lib/db';
import { filesStorage } from '../../src/modules/files/files.storage';
import { chainArgs, fake, TEST_USERS, tokenFor } from '../helpers/fakeSupabase';

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

// The fake sign-in's test users, given staff roles below (internal user ids '1' to '4').
const STAFF = {
  admin: 'observer',
  moderator: 'prive',
  analyst: 'privePending',
  member: 'institutional',
} as const;
type Who = keyof typeof STAFF;
const as = (who: Who) => ({ Authorization: `Bearer ${tokenFor(STAFF[who])}` });

const MEMBER_ID = TEST_USERS.institutional.id;
const ITEM_ID = '9a000000-0000-4000-8000-000000000001';
const COMPANY_ID = '8f1c2b9e-0000-4000-8000-00000000000a';
const ISSUER_ID = '1e000000-0000-4000-8000-000000000001';
const NOW = '2026-10-28T09:00:00.000Z';

const userRef = {
  id: MEMBER_ID,
  name: 'Asha Rao',
  tier: 'PRIVE',
  kycStatus: 'APPROVED',
  status: 'ACTIVE',
};

// app_* database functions, answered per test. callDb still checks each argument list and result
// against src/lib/dbFunctions.ts, so these stubs must look like what the database returns.
type RpcHandler = (args: Record<string, unknown>) => unknown;
let rpc: Record<string, RpcHandler>;
let roles: Record<string, string[]>;
let rpcSpy: MockInstance<typeof dbTransport.rpc>;

beforeEach(() => {
  fake.reset();
  roles = { '1': ['ADMIN'], '2': ['MODERATOR'], '3': ['ANALYST'], '4': [] };
  rpc = {};
  rpcSpy = vi.spyOn(dbTransport, 'rpc').mockImplementation((fn, args) => {
    if (fn === 'app_staff_roles') return Promise.resolve(roles[String(args['p_user_id'])] ?? []);
    const handler = rpc[fn];
    if (!handler) return Promise.reject(new Error(`No rpc stub for ${fn}`));
    return Promise.resolve(handler(args));
  });
  vi.spyOn(filesStorage, 'exists').mockResolvedValue(true);
});

const rpcArgs = (fn: string) =>
  rpcSpy.mock.calls.filter(([name]) => name === fn).map(([, args]) => args);

// ---------------------------------------------------------------------------------------------

describe('staff access', () => {
  it('needs a signed-in staff member', async () => {
    expect((await request(app).get('/api/v1/admin/me')).status).toBe(401);
    const res = await request(app).get('/api/v1/admin/me').set(as('member'));
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: 'FORBIDDEN', message: 'Staff access required' });
  });

  it('describes the staff member and is never cached', async () => {
    const res = await request(app).get('/api/v1/admin/me').set(as('moderator'));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toEqual({
      id: TEST_USERS.prive.id,
      name: 'Shreya Mehta',
      roles: ['MODERATOR'],
      permissions: [
        'moderation.read',
        'moderation.decide',
        'content.read',
        'representations.track',
        'questions.answer',
      ],
    });
  });

  it.each([
    ['moderator', 'get', '/api/v1/admin/users'],
    ['moderator', 'post', '/api/v1/admin/credits/grant'],
    ['moderator', 'post', '/api/v1/admin/companies'],
    ['analyst', 'post', `/api/v1/admin/moderation/${ITEM_ID}/decision`],
    ['analyst', 'get', '/api/v1/admin/audit-logs'],
    ['analyst', 'get', '/api/v1/admin/kyc'],
  ] as const)('refuses %s: %s %s', async (who, method, path) => {
    const res = await request(app)[method](path).set(as(who)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('picks up role changes on the next request', async () => {
    roles['2'] = [];
    expect((await request(app).get('/api/v1/admin/me').set(as('moderator'))).status).toBe(403);
  });
});

describe('users', () => {
  it('looks members up by the blind index of an exact email', async () => {
    rpc['app_admin_find_users'] = () => ({ items: [], total: 0 });
    const res = await request(app)
      .get('/api/v1/admin/users?q=Asha@Example.com&filter[tier]=PRIVE')
      .set(as('admin'));

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 0 });
    expect(rpcArgs('app_admin_find_users')[0]).toMatchObject({
      p_email_hash: keyedHash('email', 'asha@example.com'),
      p_q_pattern: null,
      p_tiers: ['PRIVE'],
      p_staff_only: false,
      p_limit: 20,
      p_offset: 0,
    });
  });

  it('shows contact details decrypted, never the ciphertext', async () => {
    rpc['app_admin_get_user'] = () => ({
      id: MEMBER_ID,
      emailEnc: encrypt('asha@example.com', 'email'),
      phoneEnc: encrypt('+919876543210', 'phone'),
      name: 'Asha Rao',
      experienceYears: 5,
      jobProfileCode: 'FOUNDER',
      otherJob: null,
      location: 'Pune',
      tier: 'PRIVE',
      requestedTier: null,
      kycStatus: 'APPROVED',
      status: 'ACTIVE',
      creditBalance: 3,
      roles: [],
      createdAt: NOW,
      lastLoginAt: null,
      tierSelectedAt: NOW,
      activeSessions: 1,
      kyc: null,
      activity: {
        reviews: 2,
        ratings: 1,
        signatures: 0,
        poolMemberships: 0,
        followers: 4,
        following: 1,
      },
      tierHistory: [],
    });

    const res = await request(app).get(`/api/v1/admin/users/${MEMBER_ID}`).set(as('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      email: 'asha@example.com',
      phone: '+919876543210',
      permissions: [],
    });
    expect(res.body.data).not.toHaveProperty('emailEnc');
  });

  it('needs a reason and a change, and maps refusals', async () => {
    const patch = (body: object) =>
      request(app).patch(`/api/v1/admin/users/${MEMBER_ID}`).set(as('admin')).send(body);

    expect((await patch({ tier: 'PRIVE' })).body.error.fields).toEqual({ reason: 'Give a reason' });
    expect((await patch({ reason: 'Nothing to change' })).status).toBe(400);
    expect((await patch({ status: 'DELETED', reason: 'Delete them' })).status).toBe(400);

    rpc['app_admin_update_user'] = () => ({ error: 'SELF_ACTION' });
    const res = await patch({ status: 'SUSPENDED', reason: 'Fraud investigation' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SELF_ACTION');
  });

  it('replaces staff roles', async () => {
    rpc['app_admin_set_roles'] = (args) => ({ ok: true, roles: args['p_roles'] });
    const res = await request(app)
      .put(`/api/v1/admin/users/${MEMBER_ID}/roles`)
      .set(as('admin'))
      .send({ roles: ['SUPPORT'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: MEMBER_ID,
      roles: ['SUPPORT'],
      permissions: ['users.read', 'kyc.review', 'content.read'],
    });

    const bad = await request(app)
      .put(`/api/v1/admin/users/${MEMBER_ID}/roles`)
      .set(as('admin'))
      .send({ roles: ['ROOT'] });
    expect(bad.status).toBe(400);
  });
});

describe('KYC', () => {
  it('lists the pending queue by default', async () => {
    rpc['app_admin_kyc_queue'] = () => ({ items: [], total: 0 });
    await request(app).get('/api/v1/admin/kyc').set(as('admin'));
    expect(rpcArgs('app_admin_kyc_queue')[0]).toMatchObject({
      p_statuses: ['PENDING'],
      p_oldest_first: true,
    });
  });

  it('approves, and reports a second decision as a conflict', async () => {
    rpc['app_admin_kyc_decide'] = () => ({ ok: true, status: 'APPROVED', user: userRef });
    const res = await request(app).post(`/api/v1/admin/kyc/${ITEM_ID}/approve`).set(as('admin'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: ITEM_ID, status: 'APPROVED', user: userRef });
    expect(rpcArgs('app_admin_kyc_decide')[0]).toMatchObject({
      p_actor_id: '1',
      p_decision: 'APPROVE',
      p_reason: null,
    });

    rpc['app_admin_kyc_decide'] = () => ({ error: 'ALREADY_DECIDED', status: 'REJECTED' });
    const again = await request(app).post(`/api/v1/admin/kyc/${ITEM_ID}/approve`).set(as('admin'));
    expect(again.status).toBe(409);
    expect(again.body.error).toEqual({
      code: 'KYC_ALREADY_DECIDED',
      message: 'This submission is already rejected',
    });
  });

  it('needs a reason to reject', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/kyc/${ITEM_ID}/reject`)
      .set(as('admin'))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ reason: 'Give a reason' });
  });
});

describe('moderation', () => {
  const reviewItem = {
    type: 'REVIEW',
    id: ITEM_ID,
    status: 'PENDING_MODERATION',
    note: null,
    createdAt: NOW,
    author: userRef,
    subject: { type: 'COMPANY', id: COMPANY_ID, name: 'Astra Mutuals' },
    content: {
      receiptNo: 'GIG-RV-2026-000042',
      country: 'IN',
      assetClass: 'MF',
      productScheme: 'Bluechip',
      investmentYear: 2024,
      investmentStatus: 'CURRENTLY_INVESTED',
      sentiment: 'Negative',
      detailedReview: null,
      mixedReview: null,
      negativeDescription: 'Redemption took 21 days to settle.',
      reinvestStatus: null,
      metrics: {
        transparency: 2,
        responsiveness: 1,
        easeOfProcess: 2,
        trustworthiness: 2,
        overallSatisfaction: 2,
      },
      resolutionStatus: 'CLOSED_UNRESOLVED',
      followUpNote: null,
      displayMode: 'INITIALS',
      authorName: 'Asha Rao',
      allowContact: false,
      tags: [{ type: 'CONCERN', code: 'DELAY_IN_RESPONSE' }],
      evidence: [{ path: `${MEMBER_ID}/statement.pdf`, docType: 'STATEMENT' }],
    },
  };

  it('queues pending items by default', async () => {
    rpc['app_admin_moderation_queue'] = () => ({ items: [reviewItem], total: 1 });
    const res = await request(app)
      .get('/api/v1/admin/moderation/queue?filter[type]=REVIEW')
      .set(as('analyst'));
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ type: 'REVIEW', content: { sentiment: 'Negative' } });
    expect(rpcArgs('app_admin_moderation_queue')[0]).toMatchObject({
      p_types: ['REVIEW'],
      p_statuses: ['PENDING'],
    });
  });

  it('shows one review with download links for its evidence', async () => {
    rpc['app_admin_moderation_item'] = () => reviewItem;
    fake.on('signedUrl:review-evidence', {
      data: { signedUrl: 'https://signed.example/statement' },
    });

    const res = await request(app)
      .get(`/api/v1/admin/moderation/${ITEM_ID}?type=REVIEW`)
      .set(as('moderator'));

    expect(res.status).toBe(200);
    expect(res.body.data.content.evidence).toEqual([
      {
        path: `${MEMBER_ID}/statement.pdf`,
        docType: 'STATEMENT',
        download: { url: 'https://signed.example/statement', expiresAt: expect.any(String) },
      },
    ]);
    expect(
      (await request(app).get(`/api/v1/admin/moderation/${ITEM_ID}`).set(as('moderator'))).status,
    ).toBe(400);
  });

  it('checks the decision fits the item and that the author is told why', async () => {
    const decide = (body: object) =>
      request(app)
        .post(`/api/v1/admin/moderation/${ITEM_ID}/decision`)
        .set(as('moderator'))
        .send(body);

    expect(
      (await decide({ type: 'QUESTION', decision: 'REQUEST_CHANGES', note: 'Rephrase' })).body.error
        .fields,
    ).toEqual({
      decision: 'REQUEST_CHANGES does not apply to a question',
    });
    expect((await decide({ type: 'REVIEW', decision: 'REJECT' })).body.error.fields).toEqual({
      note: 'Tell the author why',
    });

    rpc['app_admin_moderate'] = () => ({ error: 'INVALID_TRANSITION', status: 'PUBLISHED' });
    const conflict = await decide({ type: 'REVIEW', decision: 'APPROVE' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('INVALID_TRANSITION');

    rpc['app_admin_moderate'] = () => ({
      ok: true,
      type: 'REVIEW',
      id: ITEM_ID,
      status: 'PUBLISHED',
      previousStatus: 'PENDING_MODERATION',
    });
    const ok = await decide({ type: 'REVIEW', decision: 'APPROVE' });
    expect(ok.body.data).toEqual({
      type: 'REVIEW',
      id: ITEM_ID,
      decision: 'APPROVE',
      status: 'PUBLISHED',
      previousStatus: 'PENDING_MODERATION',
    });
  });
});

describe('POST /admin/credits/grant', () => {
  const grant = (body: object, key?: string) => {
    const req = request(app).post('/api/v1/admin/credits/grant').set(as('admin'));
    return (key ? req.set('Idempotency-Key', key) : req).send(body);
  };
  const body = { userId: MEMBER_ID, delta: 5, note: 'Launch credits' };
  const entry = {
    id: 7,
    userId: MEMBER_ID,
    delta: 5,
    balanceAfter: 5,
    reason: 'ADMIN_GRANT',
    note: 'Launch credits',
    createdAt: NOW,
  };

  it('needs an Idempotency-Key and a non-zero whole delta', async () => {
    expect((await grant(body)).status).toBe(400);
    expect((await grant({ ...body, delta: 0 }, 'grant-key-0001')).body.error.fields).toEqual({
      delta: 'Delta cannot be 0',
    });
    expect((await grant({ ...body, delta: 1.5 }, 'grant-key-0001')).status).toBe(400);
  });

  it('marks replays and maps a revoke past zero', async () => {
    rpc['app_admin_credit_change'] = () => ({ ok: true, entry, replayed: true });
    const res = await grant(body, 'grant-key-0001');
    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(res.body.data).toEqual(entry);

    rpc['app_admin_credit_change'] = () => ({ error: 'INSUFFICIENT_CREDITS' });
    const revoke = await grant({ ...body, delta: -50 }, 'grant-key-0002');
    expect(revoke.status).toBe(409);
    expect(revoke.body.error.code).toBe('INSUFFICIENT_CREDITS');
  });
});

describe('GET /admin/audit-logs', () => {
  it('matches an action prefix literally and checks the date range', async () => {
    rpc['app_admin_audit_logs'] = () => ({ items: [], total: 0 });
    await request(app)
      .get('/api/v1/admin/audit-logs?filter[actionPrefix]=admin.kyc_')
      .set(as('admin'));
    expect(rpcArgs('app_admin_audit_logs')[0]).toMatchObject({ p_action_prefix: 'admin.kyc\\_%' });

    const res = await request(app)
      .get(
        '/api/v1/admin/audit-logs?filter[from]=2026-10-28T00:00:00Z&filter[to]=2026-10-01T00:00:00Z',
      )
      .set(as('admin'));
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ 'filter.to': 'Must be after from' });
  });
});

describe('POST /admin/uploads', () => {
  it('gives the right staff a signed upload URL for each kind of document', async () => {
    vi.spyOn(filesStorage, 'createUploadUrl').mockResolvedValue('https://upload.example/x');
    const res = await request(app)
      .post('/api/v1/admin/uploads')
      .set(as('moderator'))
      .send({ target: 'REPRESENTATION_DOCUMENT', mimeType: 'application/pdf', sizeBytes: 1024 });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      bucket: 'representation-documents',
      uploadUrl: 'https://upload.example/x',
      method: 'PUT',
    });
    expect(res.body.data.path).toMatch(/^staff\/[0-9a-f-]{36}\.pdf$/);

    const roadshowDoc = await request(app)
      .post('/api/v1/admin/uploads')
      .set(as('moderator'))
      .send({ target: 'ROADSHOW_DOCUMENT', mimeType: 'application/pdf', sizeBytes: 1024 });
    expect(roadshowDoc.status).toBe(403);
  });

  it("enforces each bucket's types and size", async () => {
    const upload = (body: object) =>
      request(app).post('/api/v1/admin/uploads').set(as('admin')).send(body);
    expect(
      (await upload({ target: 'LEARN_REPORT', mimeType: 'image/png', sizeBytes: 10 })).body.error
        .fields,
    ).toEqual({
      mimeType: 'This document must be a PDF',
    });
    expect(
      (
        await upload({
          target: 'REPRESENTATION_DOCUMENT',
          mimeType: 'image/png',
          sizeBytes: 30 * 1024 * 1024,
        })
      ).body.error.fields,
    ).toEqual({
      sizeBytes: 'At most 25 MB',
    });
  });
});

describe('companies', () => {
  const companyRow = (overrides: Record<string, unknown> = {}) => ({
    id: COMPANY_ID,
    slug: 'astra-mutuals-india',
    name: 'Astra Mutuals (India)',
    asset_class: 'MF',
    country: 'IN',
    logo_url: null,
    description: null,
    verified: false,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    company_tags: [
      { tag: 'IPO', sort_order: 1 },
      { tag: 'ETF', sort_order: 0 },
    ],
    ...overrides,
  });

  it('creates a company with a slug from its name and its tags in order', async () => {
    fake.on('from:companies', (call) =>
      call.chain.some((c) => c.method === 'insert')
        ? { data: { id: COMPANY_ID } }
        : { data: companyRow() },
    );
    fake.on('from:company_tags', { data: null });

    const res = await request(app)
      .post('/api/v1/admin/companies')
      .set(as('admin'))
      .send({
        name: 'Astra Mutuals (India)',
        assetClass: 'MF',
        country: 'IN',
        tags: ['ETF', 'IPO'],
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      id: COMPANY_ID,
      assetClass: 'MF',
      tags: ['ETF', 'IPO'],
      deletedAt: null,
    });
    const insert = fake
      .callsTo('from:companies')
      .find((c) => c.chain.some((m) => m.method === 'insert'));
    expect(chainArgs(insert, 'insert')?.[0]).toMatchObject({
      slug: 'astra-mutuals-india',
      verified: false,
    });
    const tags = fake
      .callsTo('from:company_tags')
      .find((c) => c.chain.some((m) => m.method === 'insert'));
    expect(chainArgs(tags, 'insert')?.[0]).toEqual([
      { company_id: COMPANY_ID, tag: 'ETF', sort_order: 0 },
      { company_id: COMPANY_ID, tag: 'IPO', sort_order: 1 },
    ]);
  });

  it('reports a taken slug, an empty update and a missing company', async () => {
    fake.on('from:companies', {
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "companies_slug_key"',
      },
    });
    const taken = await request(app)
      .post('/api/v1/admin/companies')
      .set(as('admin'))
      .send({ name: 'Astra', assetClass: 'MF', country: 'IN' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('SLUG_TAKEN');

    expect(
      (await request(app).patch(`/api/v1/admin/companies/${COMPANY_ID}`).set(as('admin')).send({}))
        .status,
    ).toBe(400);

    fake.on('from:companies', { data: [] });
    expect(
      (await request(app).delete(`/api/v1/admin/companies/${COMPANY_ID}`).set(as('admin'))).status,
    ).toBe(404);
  });

  it('lets read-only staff list companies, deleted ones on request', async () => {
    fake.on('from:companies', { data: [companyRow({ deleted_at: NOW })], count: 1 });
    const res = await request(app).get('/api/v1/admin/companies?state=DELETED').set(as('analyst'));
    expect(res.status).toBe(200);
    expect(res.body.data[0].deletedAt).toBe(NOW);
    expect(chainArgs(fake.callsTo('from:companies')[0], 'not')).toEqual(['deleted_at', 'is', null]);
  });
});

describe('content validation', () => {
  it('checks issuer date and price ranges', async () => {
    const res = await request(app)
      .post('/api/v1/admin/issuers')
      .set(as('admin'))
      .send({
        name: 'Meridian',
        instrument: 'NCD',
        assetType: 'Bonds',
        openDate: '2026-11-10',
        closeDate: '2026-11-01',
        priceMin: 100,
        priceMax: 90,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({
      closeDate: 'Must be on or after the open date',
      priceMax: 'Must be at least the minimum price',
    });
  });

  it('needs an existing issuer for a roadshow', async () => {
    fake.on('from:issuers', { data: null });
    const res = await request(app)
      .post('/api/v1/admin/roadshows')
      .set(as('admin'))
      .send({
        issuerId: ISSUER_ID,
        title: 'Meridian Green Bonds',
        typeOfIssue: 'Public issue',
        instruments: 'NCD',
        closesAt: '2026-12-01T00:00:00Z',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ issuerId: 'Unknown issuer' });
  });

  it('refuses duplicate fiscal years', async () => {
    const res = await request(app)
      .put(`/api/v1/admin/roadshows/${ITEM_ID}/financials`)
      .set(as('admin'))
      .send({
        years: [
          { fiscalYear: 2025, revenue: 10 },
          { fiscalYear: 2025, revenue: 11 },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ years: 'Each fiscal year can be given once' });
  });

  it('needs a learn report to be uploaded before it is attached', async () => {
    vi.spyOn(filesStorage, 'exists').mockResolvedValue(false);
    const res = await request(app)
      .post('/api/v1/admin/learn')
      .set(as('admin'))
      .send({
        title: 'Reading a prospectus',
        format: 'REPORT',
        downloadPath: `staff/${ITEM_ID}.pdf`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ downloadPath: 'File has not been uploaded yet' });
  });

  it('lets staff set only the statuses after the signing window', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/representations/${ITEM_ID}/status`)
      .set(as('moderator'))
      .send({ status: 'CLOSING_SOON' });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toHaveProperty('status');

    const path = await request(app)
      .post(`/api/v1/admin/representations/${ITEM_ID}/documents`)
      .set(as('moderator'))
      .send({
        documents: [
          {
            title: 'Pack',
            documentType: 'EVIDENCE',
            path: '../../etc/passwd',
            mimeType: 'application/pdf',
            sizeBytes: 10,
          },
        ],
      });
    expect(path.status).toBe(400);
    expect(path.body.error.fields).toHaveProperty(['documents.0.path']);
  });
});
