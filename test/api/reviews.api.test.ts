import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import {
  TEST_USERS,
  allChainArgs,
  chainArgs,
  fake,
  tokenFor,
  type FakeCall,
  type TestUser,
} from '../helpers/fakeSupabase';
import {
  COMPANY_A,
  EVIDENCE_PATH,
  EVIDENCE_PATH_2,
  REVIEW_ID,
  negativeBody,
  ownReviewRow,
  positiveBody,
  reviewFeedRow,
} from '../helpers/fixtures';

vi.mock('../../src/lib/supabase', async () => {
  const { fake } = await import('../helpers/fakeSupabase');
  return { supabaseAdmin: fake.client, supabaseForUser: () => fake.client };
});

const app = createApp();
const auth = (user: TestUser) => ({ Authorization: `Bearer ${tokenFor(user)}` });
let keySeq = 0;
const newKey = () => `test-key-${Date.now()}-${++keySeq}`;

/** Reviews created during a test, by Idempotency-Key (reviews.idempotency_key / request_hash). */
const createdByKey = new Map<string, { id: string; request_hash: string }>();

const eqValue = (call: FakeCall, column: string) =>
  allChainArgs(call, 'eq').find(([c]) => c === column)?.[1] as string | undefined;

interface PrimeOptions {
  /** Paths that exist in the evidence bucket (default: all). */
  inStorage?: (path: string) => boolean;
  /** Paths already attached to another review. */
  attached?: string[];
  /** Overrides for the receipt row read back after submission. */
  review?: Record<string, unknown>;
}

/** Everything a submission touches. */
function primeSubmission(options: PrimeOptions = {}) {
  fake.on('from:companies', { count: 1 });
  fake.on('exists:review-evidence', (call) => ({
    data: options.inStorage ? options.inStorage(call.args[0] as string) : true,
  }));
  fake.on('from:review_attachments', {
    data: (options.attached ?? []).map((storage_path) => ({ storage_path })),
  });
  fake.on('rpc:submit_review', (call) => {
    const args = call.args[0] as { p_idempotency_key: string; p_request_hash: string };
    createdByKey.set(args.p_idempotency_key, { id: REVIEW_ID, request_hash: args.p_request_hash });
    return {
      data: {
        id: REVIEW_ID,
        receipt_no: 'GIG-RV-2026-000042',
        status: 'PENDING_MODERATION',
        created_at: '2026-10-27T10:00:00Z',
      },
    };
  });
  fake.on('from:reviews', (call) => {
    const key = eqValue(call, 'idempotency_key');
    if (key !== undefined) return { data: createdByKey.get(key) ?? null };
    return { data: ownReviewRow(options.review) };
  });
}

const submit = (body: object, user: TestUser = 'prive', key: string | null = newKey()) => {
  const req = request(app).post('/api/v1/reviews').set(auth(user));
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};

beforeEach(() => {
  fake.reset();
  createdByKey.clear();
});

// ---------------------------------------------------------------------------------------------
describe('POST /api/v1/reviews: access', () => {
  it('requires sign-in', async () => {
    const res = await request(app).post('/api/v1/reviews').send(positiveBody);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an invalid token', async () => {
    const res = await request(app)
      .post('/api/v1/reviews')
      .set('Authorization', 'Bearer forged')
      .send(positiveBody);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid or expired access token');
  });

  it.each(['observer', 'institutional'] as const)('is not open to %s members', async (user) => {
    const res = await submit(positiveBody, user);
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: 'FORBIDDEN', message: 'Prive membership required' });
  });

  it('tells a Prive member without approved KYC to finish KYC', async () => {
    const res = await submit(positiveBody, 'privePending');
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: 'KYC_REQUIRED', message: 'KYC verification required' });
  });
});

describe('POST /api/v1/reviews: Idempotency-Key', () => {
  it('is required', async () => {
    const res = await submit(positiveBody, 'prive', null);
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({
      'Idempotency-Key': 'Send a unique key per submission, e.g. a UUID',
    });
  });

  it('must be 8-128 safe characters', async () => {
    expect((await submit(positiveBody, 'prive', 'short')).status).toBe(400);
    expect((await submit(positiveBody, 'prive', 'has spaces in it')).status).toBe(400);
  });

  it('is saved with the review', async () => {
    primeSubmission();
    const key = newKey();
    await submit(positiveBody, 'prive', key).expect(201);
    const args = fake.callsTo('rpc:submit_review')[0]?.args[0] as Record<string, unknown>;
    expect(args.p_idempotency_key).toBe(key);
    expect(args.p_request_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same review for a retry with the same key and body', async () => {
    primeSubmission();
    const key = newKey();
    const first = await submit(positiveBody, 'prive', key).expect(201);
    const retry = await submit(positiveBody, 'prive', key).expect(201);

    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(retry.body).toEqual(first.body);
    expect(fake.callsTo('rpc:submit_review')).toHaveLength(1);
  });

  it('refuses the same key with a different body', async () => {
    primeSubmission();
    const key = newKey();
    await submit(positiveBody, 'prive', key).expect(201);
    const res = await submit({ ...positiveBody, productScheme: 'Other' }, 'prive', key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(fake.callsTo('rpc:submit_review')).toHaveLength(1);
  });

  it('can be reused after a request that failed validation', async () => {
    primeSubmission();
    const key = newKey();
    await submit({ ...positiveBody, detailedReview: 'short' }, 'prive', key).expect(400);
    await submit(positiveBody, 'prive', key).expect(201);
  });

  it('returns the existing review when a concurrent retry created it first', async () => {
    primeSubmission();
    const key = newKey();
    fake.on('rpc:submit_review', (call) => {
      // The other request inserted the review between our lookup and our insert.
      const args = call.args[0] as { p_request_hash: string };
      createdByKey.set(key, { id: REVIEW_ID, request_hash: args.p_request_hash });
      return {
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "reviews_idempotency_key_idx"',
        },
      };
    });
    const res = await submit(positiveBody, 'prive', key).expect(201);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(res.body.data.id).toBe(REVIEW_ID);
  });
});

describe('POST /api/v1/reviews: validation', () => {
  it('returns field errors the app can show', async () => {
    const res = await submit({
      ...positiveBody,
      appreciations: [],
      detailedReview: 'short',
      metrics: { ...positiveBody.metrics, transparency: 0 },
      declarations: { ...positiveBody.declarations, genuine: false },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields).toEqual({
      appreciations: 'Select at least one appreciation',
      detailedReview: 'Review must be at least 10 characters',
      'metrics.transparency': 'Rate all 5 metrics',
      'declarations.genuine': 'Confirm this review reflects your genuine experience',
    });
    expect(fake.callsTo('rpc:submit_review')).toHaveLength(0);
  });

  it('rejects option codes that are not in the app lists', async () => {
    const res = await submit({
      ...negativeBody,
      concerns: ['DELAY_IN_RESPONSE', 'UNKNOWN_CONCERN'],
      contactStatus: ['NOT_A_STATUS'],
      evidence: [{ path: EVIDENCE_PATH, docType: 'PHOTO' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({
      'concerns.1': 'Unknown option',
      'contactStatus.0': 'Unknown option',
      'evidence.0.docType': 'Unknown option',
    });
  });

  it('rejects an unknown company', async () => {
    primeSubmission();
    fake.on('from:companies', { count: 0 });
    const res = await submit(positiveBody);
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ companyId: 'Company not found' });
  });
});

describe('POST /api/v1/reviews: evidence', () => {
  it("rejects a file in another user's folder without touching storage", async () => {
    primeSubmission();
    const res = await submit({
      ...negativeBody,
      evidence: [{ path: `${TEST_USERS.observer.id}/statement.pdf`, docType: 'STATEMENT' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ 'evidence.0.path': 'File not found' });
    expect(fake.callsTo('exists:review-evidence')).toHaveLength(0);
  });

  it('rejects a file that is not in storage yet', async () => {
    primeSubmission({ inStorage: (path) => path === EVIDENCE_PATH });
    const res = await submit({
      ...negativeBody,
      evidence: [
        { path: EVIDENCE_PATH, docType: 'STATEMENT' },
        { path: EVIDENCE_PATH_2, docType: 'EMAIL' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ 'evidence.1.path': 'File has not been uploaded yet' });
    expect(
      fake
        .callsTo('exists:review-evidence')
        .map((c) => c.args[0])
        .sort(),
    ).toEqual([EVIDENCE_PATH, EVIDENCE_PATH_2].sort());
  });

  it('rejects a file already attached to another review', async () => {
    primeSubmission({ attached: [EVIDENCE_PATH] });
    const res = await submit(negativeBody);
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({
      'evidence.0.path': 'File is already attached to another review',
    });
    expect(chainArgs(fake.callsTo('from:review_attachments')[0], 'in')).toEqual([
      'storage_path',
      [EVIDENCE_PATH],
    ]);
  });

  it('rejects the same file twice in one review', async () => {
    primeSubmission();
    const res = await submit({
      ...negativeBody,
      evidence: [
        { path: EVIDENCE_PATH, docType: 'STATEMENT' },
        { path: EVIDENCE_PATH, docType: 'EMAIL' },
      ],
    });
    expect(res.body.error.fields).toEqual({ evidence: 'Each file can be attached once' });
  });

  it('maps a database evidence rejection to a field error', async () => {
    primeSubmission();
    fake.on('rpc:submit_review', { error: { code: 'P0001', message: 'EVIDENCE_INVALID' } });
    const res = await submit(negativeBody);
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({
      evidence: 'One or more files are invalid or already attached',
    });
  });
});

describe('POST /api/v1/reviews: success', () => {
  it('creates a positive review and returns the receipt', async () => {
    primeSubmission({
      review: {
        sentiment: 'Positive',
        detailed_review: 'Payouts always arrived on time.',
        negative_description: null,
        reinvest_status: 'YES',
        investment_year: null,
        review_tags: [
          { tag_type: 'APPRECIATION', code: 'TIMELY_PAYOUTS' },
          { tag_type: 'APPRECIATION', code: 'DIGITAL_EXPERIENCE' },
        ],
        review_attachments: [],
      },
    });

    const res = await submit(positiveBody).expect(201);

    expect(res.body.data).toMatchObject({
      detail: 'OWNER',
      id: REVIEW_ID,
      receiptNo: 'GIG-RV-2026-000042',
      status: 'PENDING_MODERATION',
      reviewer: { name: 'Shreya Mehta', displayName: 'S. M.', tier: 'PRIVE', kycVerified: true },
      company: { id: COMPANY_A, name: 'Astra Mutuals', assetClass: 'MF' },
      sentiment: 'Positive',
      investmentYear: null,
      appreciations: ['DIGITAL_EXPERIENCE', 'TIMELY_PAYOUTS'],
      evidence: [],
    });

    const args = fake.callsTo('rpc:submit_review')[0]?.args[0] as Record<string, unknown>;
    expect(args).toEqual({
      p_user_id: TEST_USERS.prive.id,
      p_idempotency_key: expect.any(String),
      p_request_hash: expect.any(String),
      p_author_name: 'Shreya Mehta',
      p_company_id: COMPANY_A,
      p_country: 'IN',
      p_asset_class: 'MF',
      p_product_scheme: 'Bluechip',
      p_investment_year: null, // "OLDER"
      p_investment_status: 'CURRENTLY_INVESTED',
      p_sentiment: 'Positive',
      p_detailed_review: 'Payouts always arrived on time.',
      p_mixed_review: null,
      p_negative_description: null,
      p_reinvest_status: 'YES',
      p_appreciations: ['TIMELY_PAYOUTS', 'DIGITAL_EXPERIENCE'],
      p_concerns: [],
      p_contact_statuses: [],
      p_evidence_paths: [],
      p_evidence_doc_types: [],
      p_m_transparency: 4,
      p_m_responsiveness: 5,
      p_m_ease_of_process: 4,
      p_m_trustworthiness: 4,
      p_m_overall_satisfaction: 5,
      p_resolution_status: 'RESOLVED',
      p_follow_up_note: null, // empty note stored as null
      p_display_mode: 'INITIALS',
      p_allow_contact: false,
      p_declarations_version: '2026-10',
    });
  });

  it('creates a negative review with evidence', async () => {
    primeSubmission();
    const res = await submit(negativeBody).expect(201);

    expect(res.body.data).toMatchObject({
      sentiment: 'Negative',
      concerns: ['DELAY_IN_RESPONSE', 'MIS_SELLING'],
      contactStatus: ['CONTACTED_NO_RESPONSE'],
      evidence: [{ path: EVIDENCE_PATH, docType: 'STATEMENT', fileName: 'statement.pdf' }],
      metrics: {
        transparency: 2,
        responsiveness: 1,
        easeOfProcess: 2,
        trustworthiness: 2,
        overallSatisfaction: 2,
      },
      avgRating: 1.8,
      timeline: [
        {
          type: 'SUBMITTED',
          from: null,
          to: 'PENDING_MODERATION',
          note: null,
          at: '2026-10-27T10:00:00Z',
        },
      ],
    });
    expect(fake.callsTo('rpc:submit_review')[0]?.args[0]).toMatchObject({
      p_sentiment: 'Negative',
      p_detailed_review: null,
      p_negative_description: 'Redemption took 21 days to settle.',
      p_concerns: ['DELAY_IN_RESPONSE'],
      p_contact_statuses: ['CONTACTED_NO_RESPONSE'],
      p_evidence_paths: [EVIDENCE_PATH],
      p_evidence_doc_types: ['STATEMENT'],
      p_display_mode: 'FULL_NAME',
    });
  });

  it('returns 409 for a second active review of the same product', async () => {
    primeSubmission();
    fake.on('rpc:submit_review', {
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "reviews_one_active_per_product_idx"',
      },
    });
    const res = await submit(positiveBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      fields: { productScheme: 'You already have an active review for this product' },
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /api/v1/reviews/me', () => {
  it('requires sign-in', async () => {
    expect((await request(app).get('/api/v1/reviews/me')).status).toBe(401);
  });

  it("lists the caller's reviews, newest first", async () => {
    fake.on('from:reviews', { data: [ownReviewRow()], count: 1 });
    const res = await request(app).get('/api/v1/reviews/me').set(auth('observer')).expect(200);

    expect(res.body).toEqual({
      data: [
        {
          id: REVIEW_ID,
          receiptNo: 'GIG-RV-2026-000042',
          status: 'PENDING_MODERATION',
          company: { id: COMPANY_A, name: 'Astra Mutuals' },
          sentiment: 'Negative',
          avgRating: 1.8,
          resolutionStatus: 'CLOSED_UNRESOLVED',
          createdAt: '2026-10-27T10:00:00Z',
          updatedAt: '2026-10-27T10:00:00Z',
        },
      ],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    const call = fake.callsTo('from:reviews')[0];
    expect(allChainArgs(call, 'eq')).toEqual([['user_id', TEST_USERS.observer.id]]);
    expect(allChainArgs(call, 'is')).toEqual([['deleted_at', null]]);
    expect(chainArgs(call, 'order')).toEqual(['created_at', { ascending: false }]);
  });

  it('filters by status', async () => {
    fake.on('from:reviews', { data: [], count: 0 });
    await request(app)
      .get('/api/v1/reviews/me?status=PUBLISHED,REJECTED')
      .set(auth('prive'))
      .expect(200);
    expect(chainArgs(fake.callsTo('from:reviews')[0], 'in')).toEqual([
      'status',
      ['PUBLISHED', 'REJECTED'],
    ]);
    expect(
      (await request(app).get('/api/v1/reviews/me?status=DRAFT').set(auth('prive'))).status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /api/v1/reviews/:id', () => {
  it('requires sign-in', async () => {
    expect((await request(app).get(`/api/v1/reviews/${REVIEW_ID}`)).status).toBe(401);
  });

  it('gives the reviewer the full receipt with evidence and timeline', async () => {
    fake.on('from:reviews', { data: ownReviewRow() });
    const res = await request(app)
      .get(`/api/v1/reviews/${REVIEW_ID}`)
      .set(auth('prive'))
      .expect(200);

    expect(res.body.data).toMatchObject({
      detail: 'OWNER',
      receiptNo: 'GIG-RV-2026-000042',
      moderationNote: null,
      allowContact: false,
      displayMode: 'INITIALS',
      evidence: [{ path: EVIDENCE_PATH, docType: 'STATEMENT', fileName: 'statement.pdf' }],
      timeline: [{ type: 'SUBMITTED' }],
    });
    const call = fake.callsTo('from:reviews')[0];
    expect(allChainArgs(call, 'eq')).toEqual([
      ['id', REVIEW_ID],
      ['user_id', TEST_USERS.prive.id],
    ]);
    expect(chainArgs(call, 'order')).toEqual([
      'created_at',
      { referencedTable: 'review_versions', ascending: true },
    ]);
  });

  it("shows another user's published review at the viewer's access level", async () => {
    fake.on('from:reviews', { data: null });
    fake.on('from:review_feed', { data: reviewFeedRow() });

    const observer = await request(app)
      .get(`/api/v1/reviews/${REVIEW_ID}`)
      .set(auth('observer'))
      .expect(200);
    expect(observer.body.data.detail).toBe('SUMMARY');
    expect(observer.body.data).not.toHaveProperty('metrics');

    const inst = await request(app)
      .get(`/api/v1/reviews/${REVIEW_ID}`)
      .set(auth('institutional'))
      .expect(200);
    expect(inst.body.data.detail).toBe('FULL');
    expect(inst.body.data).not.toHaveProperty('receiptNo');
  });

  it('returns 404 for a review that is neither yours nor published', async () => {
    fake.on('from:reviews', { data: null });
    fake.on('from:review_feed', { data: null });
    const res = await request(app).get(`/api/v1/reviews/${REVIEW_ID}`).set(auth('prive'));
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: 'Review not found' });
  });

  it('rejects an id that is not a UUID', async () => {
    expect((await request(app).get('/api/v1/reviews/r1').set(auth('prive'))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
describe('PATCH /api/v1/reviews/:id/resolution', () => {
  const url = `/api/v1/reviews/${REVIEW_ID}/resolution`;
  const updated = {
    data: {
      id: REVIEW_ID,
      resolution_status: 'RESOLVED',
      follow_up_note: 'Refund received',
      updated_at: '2026-10-28T09:00:00Z',
    },
  };

  it('requires sign-in and verified Prive membership', async () => {
    expect((await request(app).patch(url).send({ resolutionStatus: 'RESOLVED' })).status).toBe(401);
    expect(
      (await request(app).patch(url).set(auth('observer')).send({ resolutionStatus: 'RESOLVED' }))
        .status,
    ).toBe(403);
    const pending = await request(app)
      .patch(url)
      .set(auth('privePending'))
      .send({ resolutionStatus: 'RESOLVED' });
    expect(pending.body.error.code).toBe('KYC_REQUIRED');
  });

  it('updates status and note and returns the result', async () => {
    fake.on('rpc:update_review_resolution', updated);
    const res = await request(app)
      .patch(url)
      .set(auth('prive'))
      .send({ resolutionStatus: 'RESOLVED', followUpNote: 'Refund received' })
      .expect(200);

    expect(res.body.data).toEqual({
      id: REVIEW_ID,
      resolutionStatus: 'RESOLVED',
      followUpNote: 'Refund received',
      updatedAt: '2026-10-28T09:00:00Z',
    });
    expect(fake.callsTo('rpc:update_review_resolution')[0]?.args[0]).toEqual({
      p_user_id: TEST_USERS.prive.id,
      p_review_id: REVIEW_ID,
      p_resolution_status: 'RESOLVED',
      p_follow_up_note: 'Refund received',
      p_update_note: true,
    });
  });

  it('keeps the note when it is omitted and clears it when null', async () => {
    fake.on('rpc:update_review_resolution', updated);
    await request(app)
      .patch(url)
      .set(auth('prive'))
      .send({ resolutionStatus: 'RESOLVED' })
      .expect(200);
    await request(app)
      .patch(url)
      .set(auth('prive'))
      .send({ resolutionStatus: 'RESOLVED', followUpNote: null })
      .expect(200);

    const [omitted, cleared] = fake.callsTo('rpc:update_review_resolution').map((c) => c.args[0]);
    expect(omitted).toMatchObject({ p_follow_up_note: null, p_update_note: false });
    expect(cleared).toMatchObject({ p_follow_up_note: null, p_update_note: true });
  });

  it("returns 404 when the review is not the caller's or is no longer active", async () => {
    fake.on('rpc:update_review_resolution', {
      error: { code: 'P0001', message: 'REVIEW_NOT_FOUND' },
    });
    const res = await request(app)
      .patch(url)
      .set(auth('prive'))
      .send({ resolutionStatus: 'RESOLVED' });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Review not found');
  });

  it('validates the body', async () => {
    const res = await request(app)
      .patch(url)
      .set(auth('prive'))
      .send({ resolutionStatus: 'UNRESOLVED', followUpNote: 'x'.repeat(401) });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.fields).sort()).toEqual(['followUpNote', 'resolutionStatus']);
  });
});
