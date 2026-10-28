import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt, keyedHash } from '../../src/lib/crypto';
import {
  adminRepository,
  type AdminCompany,
  type AdminRepresentationDetail,
  type KycDetailRow,
  type UserDetailRow,
} from '../../src/modules/admin/admin.repository';
import { filesStorage } from '../../src/modules/files/files.storage';
import type { StaffRole } from '../../src/types/domain';
import { AUTH_HEADER, USER_ID, app, makeUser, signInAs } from '../helpers';
import { uniqueViolation } from '../helpers/dbErrors';

const TARGET = '8b8b8b8b-0000-4000-8000-000000000001';
const ITEM = '9c9c9c9c-0000-4000-8000-000000000002';
const NOW = '2026-10-28T09:00:00.000Z';

function asStaff(...roles: StaffRole[]) {
  signInAs(makeUser({ userId: '42', fullName: 'Gita Admin' }));
  vi.spyOn(adminRepository, 'staffRoles').mockResolvedValue(roles);
}

const api = {
  get: (path: string) => request(app).get(`/api/v1/admin${path}`).set(AUTH_HEADER),
  post: (path: string, body: object = {}) =>
    request(app).post(`/api/v1/admin${path}`).set(AUTH_HEADER).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1/admin${path}`).set(AUTH_HEADER).send(body),
  put: (path: string, body: object) =>
    request(app).put(`/api/v1/admin${path}`).set(AUTH_HEADER).send(body),
  delete: (path: string) => request(app).delete(`/api/v1/admin${path}`).set(AUTH_HEADER),
};

function userRow(overrides: Partial<UserDetailRow> = {}): UserDetailRow {
  return {
    id: '7',
    publicId: TARGET,
    emailEnc: encrypt('asha@example.com', 'email'),
    phoneEnc: encrypt('+919876543210', 'phone'),
    name: 'Asha Rao',
    experienceYears: 5,
    jobProfile: 'FOUNDER',
    otherJob: null,
    location: 'Pune',
    tier: 'OBSERVER',
    requestedTier: 'PRIVE',
    kycStatus: 'PENDING',
    status: 'ACTIVE',
    creditBalance: 0,
    roles: [],
    emailVerifiedAt: NOW,
    phoneVerifiedAt: NOW,
    createdAt: NOW,
    lastLoginAt: null,
    deletedAt: null,
    activeSessions: 1,
    activity: { reviews: 0, ratings: 0, signatures: 0, followers: 0, following: 0 },
    kycSubmissions: [],
    tierHistory: [],
    ...overrides,
  };
}

const company: AdminCompany = {
  id: ITEM,
  slug: 'orbit-amc',
  name: 'Orbit AMC',
  assetClass: 'MF',
  country: 'IN',
  logoUrl: null,
  description: null,
  verified: false,
  tags: [],
  reviewCount: 0,
  score: 0,
  pendingReviews: 0,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

function representation(
  overrides: Partial<AdminRepresentationDetail> = {},
): AdminRepresentationDetail {
  return {
    id: ITEM,
    slug: 'fair-exit-loads',
    title: 'Cap exit loads on debt funds',
    description: '',
    asks: [],
    whyItMatters: '',
    category: null,
    country: 'IN',
    tags: [],
    regulators: ['SEBI'],
    goal: 500,
    signatureCount: 12,
    voteCount: 10,
    opensAt: NOW,
    closesAt: '2026-12-01T00:00:00.000Z',
    storedStatus: 'OPEN',
    trackStatus: 'OPEN',
    isPublished: true,
    isOpenForSigning: true,
    documentCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    documents: [],
    history: [],
    ...overrides,
  };
}

const page = <T>(items: T[]) => ({ items, total: items.length });

describe('admin access', () => {
  it('needs a signed-in user', async () => {
    const res = await request(app).get('/api/v1/admin/me');
    expect(res.status).toBe(401);
  });

  it('is closed to members who are not staff, whatever their tier', async () => {
    signInAs(makeUser({ tier: 'PRIVE', kycStatus: 'APPROVED' }));
    vi.spyOn(adminRepository, 'staffRoles').mockResolvedValue([]);

    const res = await api.get('/users');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STAFF_ONLY');
  });

  it('tells the console which roles and permissions the staff member has', async () => {
    asStaff('MODERATOR');

    const res = await api.get('/me');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: USER_ID,
      roles: ['MODERATOR'],
      permissions: ['users.read', 'kyc.read', 'kyc.decide', 'moderation', 'content.read'],
    });
  });

  it.each([
    ['ANALYST', 'patch', '/users/' + TARGET],
    ['MODERATOR', 'get', '/audit-logs'],
    ['SUPPORT', 'post', `/kyc/${ITEM}/approve`],
    ['MODERATOR', 'post', '/companies'],
    ['ANALYST', 'get', '/moderation/queue'],
  ] as const)('stops %s from %s %s', async (role, method, path) => {
    asStaff(role);

    const res = await api[method](path, {});

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROLE_FORBIDDEN');
  });
});

describe('users', () => {
  it('searches by exact email, phone, user ID or part of the name', async () => {
    asStaff('SUPPORT');
    const find = vi.spyOn(adminRepository, 'findUsers').mockResolvedValue(page([]));

    await api.get('/users?q=Asha@Example.com');
    await api.get('/users?q=%2B919876543210');
    await api.get(`/users?q=${TARGET}`);
    const res = await api.get('/users?q=as_ha&filter[tier]=PRIVE,OBSERVER&sort=name&pageSize=5');

    expect(find.mock.calls.map(([search]) => search)).toEqual([
      { emailHash: keyedHash('email', 'asha@example.com') },
      { phoneHash: keyedHash('phone', '+919876543210') },
      { publicId: TARGET },
      { namePattern: '%as\\_ha%' },
    ]);
    expect(find.mock.calls[3]![1]).toMatchObject({
      sort: 'name',
      filter: { tier: ['PRIVE', 'OBSERVER'] },
    });
    expect(res.body).toEqual({ data: [], meta: { page: 1, pageSize: 5, total: 0 } });
  });

  it('shows contact details only to roles allowed to see them', async () => {
    vi.spyOn(adminRepository, 'findUser').mockResolvedValue(userRow());

    asStaff('SUPPORT');
    const support = await api.get(`/users/${TARGET}`);
    asStaff('ANALYST');
    const analyst = await api.get(`/users/${TARGET}`);

    expect(support.body.data.contact).toEqual({
      email: 'asha@example.com',
      phone: '+919876543210',
    });
    expect(analyst.body.data.contact).toBeNull();
    expect(analyst.body.data).not.toHaveProperty('emailEnc');
    expect(analyst.body.data).toMatchObject({ id: TARGET, name: 'Asha Rao', kycStatus: 'PENDING' });
  });

  it('returns 404 for an unknown user', async () => {
    asStaff('ADMIN');
    vi.spyOn(adminRepository, 'findUser').mockResolvedValue(null);

    const res = await api.get(`/users/${TARGET}`);

    expect(res.status).toBe(404);
  });

  it('suspends a user with a reason', async () => {
    asStaff('ADMIN');
    const update = vi.spyOn(adminRepository, 'updateUser').mockResolvedValue({ ok: true });
    vi.spyOn(adminRepository, 'findUser').mockResolvedValue(userRow({ status: 'SUSPENDED' }));

    const res = await api.patch(`/users/${TARGET}`, {
      status: 'SUSPENDED',
      reason: 'Spam reviews',
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'SUSPENDED', contact: null });
    expect(update).toHaveBeenCalledWith(
      '42',
      TARGET,
      { status: 'SUSPENDED' },
      'Spam reviews',
      expect.anything(),
    );
  });

  it('validates changes and maps refusals', async () => {
    asStaff('ADMIN');
    vi.spyOn(adminRepository, 'updateUser').mockResolvedValue({ error: 'KYC_NOT_APPROVED' });

    const nothing = await api.patch(`/users/${TARGET}`, { reason: 'No change' });
    const noReason = await api.patch(`/users/${TARGET}`, { status: 'SUSPENDED' });
    const deleted = await api.patch(`/users/${TARGET}`, { status: 'DELETED', reason: 'Gone' });
    const refused = await api.patch(`/users/${TARGET}`, {
      tier: 'PRIVE',
      reason: 'Manual upgrade',
    });

    expect(nothing.body.error.fields).toEqual({ _: 'Change the tier or the status' });
    expect(noReason.body.error.fields).toEqual({ reason: 'Give a reason' });
    expect(deleted.status).toBe(400);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('KYC_NOT_APPROVED');
  });

  it('sets staff roles and protects the last ADMIN', async () => {
    asStaff('ADMIN');
    const set = vi
      .spyOn(adminRepository, 'setRoles')
      .mockResolvedValueOnce({ roles: ['MODERATOR'] })
      .mockResolvedValueOnce({ error: 'LAST_ADMIN' });

    const ok = await api.put(`/users/${TARGET}/roles`, { roles: ['MODERATOR'] });
    const last = await api.put(`/users/${TARGET}/roles`, { roles: [] });
    const duplicate = await api.put(`/users/${TARGET}/roles`, { roles: ['ADMIN', 'ADMIN'] });
    const unknown = await api.put(`/users/${TARGET}/roles`, { roles: ['OWNER'] });

    expect(ok.body.data).toEqual({ id: TARGET, roles: ['MODERATOR'] });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('LAST_ADMIN');
    expect(duplicate.body.error.fields).toEqual({ roles: 'List each role once' });
    expect(unknown.status).toBe(400);
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('lists the credit ledger with the balance', async () => {
    asStaff('ANALYST');
    vi.spyOn(adminRepository, 'userCredits').mockResolvedValue({ balance: 3, items: [], total: 0 });

    const res = await api.get(`/users/${TARGET}/credits`);

    expect(res.body).toEqual({ data: [], meta: { page: 1, pageSize: 20, total: 0, balance: 3 } });
  });
});

describe('KYC', () => {
  const submission: KycDetailRow = {
    id: ITEM,
    tier: 'PRIVE',
    status: 'PENDING',
    provider: 'MANUAL',
    reference: null,
    reason: null,
    submittedAt: NOW,
    reviewedAt: null,
    reviewer: null,
    user: {
      id: TARGET,
      name: 'Asha Rao',
      tier: 'OBSERVER',
      requestedTier: 'PRIVE',
      kycStatus: 'PENDING',
      status: 'ACTIVE',
      createdAt: NOW,
    },
    consent: { version: '2026-10', acceptedAt: NOW },
    documents: [
      {
        fileId: 'f1',
        documentType: 'ID_PROOF',
        bucket: 'kyc-documents',
        objectKey: `${TARGET}/a.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 10,
        scanStatus: 'CLEAN',
      },
      {
        fileId: 'f2',
        documentType: 'ADDRESS_PROOF',
        bucket: 'kyc-documents',
        objectKey: `${TARGET}/b.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 10,
        scanStatus: 'INFECTED',
      },
    ],
  };

  it('defaults the queue to pending submissions', async () => {
    asStaff('MODERATOR');
    const find = vi.spyOn(adminRepository, 'findKyc').mockResolvedValue(page([]));

    await api.get('/kyc');
    await api.get('/kyc?filter[status]=REJECTED&filter[tier]=INSTITUTIONAL');

    expect(find.mock.calls.map(([query]) => query.filter)).toEqual([
      undefined,
      { status: ['REJECTED'], tier: ['INSTITUTIONAL'] },
    ]);
  });

  it('links clean documents for 5 minutes and never infected ones', async () => {
    asStaff('SUPPORT');
    vi.spyOn(adminRepository, 'findKycSubmission').mockResolvedValue(submission);
    const link = vi.spyOn(filesStorage, 'createDownloadUrl').mockResolvedValue('https://signed/a');

    const res = await api.get(`/kyc/${ITEM}`);

    expect(res.status).toBe(200);
    expect(res.body.data.documents).toEqual([
      {
        fileId: 'f1',
        documentType: 'ID_PROOF',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        scanStatus: 'CLEAN',
        downloadUrl: 'https://signed/a',
      },
      {
        fileId: 'f2',
        documentType: 'ADDRESS_PROOF',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        scanStatus: 'INFECTED',
        downloadUrl: null,
      },
    ]);
    expect(link).toHaveBeenCalledOnce();
    expect(link).toHaveBeenCalledWith('kyc-documents', `${TARGET}/a.pdf`, 300);
  });

  it('approves and rejects with a reason', async () => {
    asStaff('MODERATOR');
    const decide = vi
      .spyOn(adminRepository, 'decideKyc')
      .mockResolvedValueOnce({ status: 'APPROVED', tier: 'PRIVE', kycStatus: 'APPROVED' })
      .mockResolvedValueOnce({ status: 'REJECTED', tier: 'OBSERVER', kycStatus: 'REJECTED' });

    const approved = await api.post(`/kyc/${ITEM}/approve`);
    const rejected = await api.post(`/kyc/${ITEM}/reject`, { reason: 'ID photo is blurred' });
    const noReason = await api.post(`/kyc/${ITEM}/reject`, {});

    expect(approved.body.data).toEqual({
      id: ITEM,
      status: 'APPROVED',
      tier: 'PRIVE',
      kycStatus: 'APPROVED',
    });
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', reason: 'ID photo is blurred' });
    expect(noReason.body.error.fields).toEqual({ reason: 'Tell the user why' });
    expect(decide.mock.calls.map((call) => call.slice(0, 4))).toEqual([
      ['42', ITEM, 'APPROVE', null],
      ['42', ITEM, 'REJECT', 'ID photo is blurred'],
    ]);
  });

  it.each([
    [{ error: 'ALREADY_DECIDED', status: 'APPROVED' }, 409, 'KYC_ALREADY_DECIDED'],
    [{ error: 'OWN_SUBMISSION' }, 403, 'CONFLICT_OF_INTEREST'],
    [{ error: 'DOCUMENT_INFECTED' }, 409, 'DOCUMENT_INFECTED'],
    [{ error: 'NOT_FOUND' }, 404, 'NOT_FOUND'],
  ])('maps %o to %i %s', async (result, status, code) => {
    asStaff('ADMIN');
    vi.spyOn(adminRepository, 'decideKyc').mockResolvedValue(result);

    const res = await api.post(`/kyc/${ITEM}/approve`);

    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });
});

describe('moderation', () => {
  it('requires a note for every decision except approval', async () => {
    asStaff('MODERATOR');
    const moderate = vi.spyOn(adminRepository, 'moderate').mockResolvedValue({
      type: 'REVIEW',
      id: ITEM,
      previousStatus: 'PENDING_MODERATION',
      status: 'PUBLISHED',
    });

    const approved = await api.post(`/moderation/${ITEM}/decision`, {
      type: 'REVIEW',
      decision: 'APPROVE',
    });
    const noNote = await api.post(`/moderation/${ITEM}/decision`, {
      type: 'RATING',
      decision: 'REJECT',
    });

    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('PUBLISHED');
    expect(noNote.body.error.fields).toEqual({ note: 'Explain the decision to the author' });
    expect(moderate).toHaveBeenCalledOnce();
  });

  it('refuses decisions that do not fit the current status, and your own content', async () => {
    asStaff('MODERATOR');
    vi.spyOn(adminRepository, 'moderate')
      .mockResolvedValueOnce({ error: 'INVALID_TRANSITION', status: 'PUBLISHED' })
      .mockResolvedValueOnce({ error: 'OWN_CONTENT' });
    const body = { type: 'REVIEW', decision: 'REQUEST_CHANGES', note: 'Add evidence' };

    const invalid = await api.post(`/moderation/${ITEM}/decision`, body);
    const own = await api.post(`/moderation/${ITEM}/decision`, body);

    expect(invalid.status).toBe(409);
    expect(invalid.body.error).toMatchObject({
      code: 'INVALID_TRANSITION',
      message: expect.stringContaining('PUBLISHED'),
    });
    expect(own.body.error.code).toBe('CONFLICT_OF_INTEREST');
  });

  it('shows one item with links to its evidence, and needs its type', async () => {
    asStaff('MODERATOR');
    vi.spyOn(adminRepository, 'moderationItem').mockResolvedValue({
      type: 'REVIEW',
      id: ITEM,
      receiptNo: 'GIG-RV-2026-000001',
      status: 'PENDING_MODERATION',
      submittedAt: NOW,
      publishedAt: null,
      moderationNote: null,
      author: { id: TARGET, name: 'Asha Rao', tier: 'PRIVE', kycStatus: 'APPROVED' },
      subject: { type: 'COMPANY', id: ITEM, name: 'Astra Mutuals' },
      content: {},
      evidence: [{ path: `${TARGET}/s.pdf`, docType: 'STATEMENT' }],
      history: [],
    });
    vi.spyOn(filesStorage, 'createDownloadUrl').mockResolvedValue('https://signed/s');

    const res = await api.get(`/moderation/${ITEM}?type=REVIEW`);
    const noType = await api.get(`/moderation/${ITEM}`);

    expect(res.body.data.evidence).toEqual([
      { path: `${TARGET}/s.pdf`, docType: 'STATEMENT', downloadUrl: 'https://signed/s' },
    ]);
    expect(noType.status).toBe(400);
  });

  it('defaults the queue to pending items', async () => {
    asStaff('MODERATOR');
    const queue = vi.spyOn(adminRepository, 'moderationQueue').mockResolvedValue(page([]));

    await api.get('/moderation/queue?filter[type]=RATING');

    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ filter: { type: ['RATING'] } }));
  });
});

describe('content', () => {
  it('creates a company and returns it', async () => {
    asStaff('ADMIN');
    const save = vi.spyOn(adminRepository, 'saveCompany').mockResolvedValue({ id: ITEM });
    vi.spyOn(adminRepository, 'findCompany').mockResolvedValue(company);

    const res = await api.post('/companies', {
      slug: 'orbit-amc',
      name: 'Orbit AMC',
      assetClass: 'MF',
      country: 'IN',
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(company);
    expect(save).toHaveBeenCalledWith(
      '42',
      null,
      {
        slug: 'orbit-amc',
        name: 'Orbit AMC',
        assetClass: 'MF',
        country: 'IN',
        verified: false,
        tags: [],
      },
      expect.anything(),
    );
  });

  it('validates companies and reports a taken slug', async () => {
    asStaff('ADMIN');
    vi.spyOn(adminRepository, 'saveCompany').mockRejectedValue(
      uniqueViolation('companies_slug_key'),
    );

    const badSlug = await api.post('/companies', {
      slug: 'Orbit AMC',
      name: 'Orbit AMC',
      assetClass: 'MF',
      country: 'IN',
    });
    const empty = await api.patch(`/companies/${ITEM}`, {});
    const taken = await api.post('/companies', {
      slug: 'astra-mutuals',
      name: 'Copy',
      assetClass: 'MF',
      country: 'IN',
    });

    expect(badSlug.body.error.fields.slug).toBe('Use lowercase letters, digits and single hyphens');
    expect(empty.body.error.fields).toEqual({ _: 'Change at least one field' });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatchObject({
      code: 'SLUG_TAKEN',
      fields: { slug: 'Already in use' },
    });
  });

  it('soft-deletes, and returns 404 for what is already gone', async () => {
    asStaff('ADMIN');
    vi.spyOn(adminRepository, 'deleteIssuer')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    expect((await api.delete(`/issuers/${ITEM}`)).status).toBe(204);
    expect((await api.delete(`/issuers/${ITEM}`)).status).toBe(404);
  });

  it('checks issuer ranges and petition windows', async () => {
    asStaff('ADMIN');
    const issuer = { slug: 'delta', name: 'Delta', instrument: 'Bonds', assetType: 'Bonds' };

    const prices = await api.post('/issuers', { ...issuer, priceMin: 120, priceMax: 100 });
    const dates = await api.patch(`/issuers/${ITEM}`, {
      openDate: '2026-05-10',
      closeDate: '2026-05-01',
    });
    const window = await api.post('/representations', {
      slug: 'fair-exit-loads',
      title: 'Cap exit loads',
      country: 'IN',
      goal: 500,
      opensAt: '2026-11-10T00:00:00Z',
      closesAt: '2026-11-01T00:00:00Z',
    });

    expect(prices.body.error.fields).toEqual({ priceMax: 'Must be at least the minimum price' });
    expect(dates.body.error.fields).toEqual({ closeDate: 'Must be on or after the open date' });
    expect(window.body.error.fields).toEqual({ closesAt: 'Must be after the opening time' });
  });
});

describe('representation track', () => {
  const key = `${ITEM}/aaaaaaaa-0000-4000-8000-000000000001.pdf`;
  const pack = {
    objectKey: key,
    title: 'Petition pack',
    documentType: 'SUBMISSION_PACK',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
  };

  beforeEach(() => {
    vi.spyOn(adminRepository, 'findRepresentation').mockResolvedValue(representation());
  });

  it('hands out an upload URL in the petition folder', async () => {
    asStaff('ADMIN');
    vi.spyOn(filesStorage, 'createUploadUrl').mockResolvedValue('https://upload/x');

    const res = await api.post(`/representations/${ITEM}/documents/upload-url`, {
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      uploadUrl: 'https://upload/x',
      method: 'PUT',
      contentType: 'application/pdf',
    });
    expect(res.body.data.objectKey).toMatch(new RegExp(`^${ITEM}/[0-9a-f-]{36}\\.pdf$`));
  });

  it('advances the track with a document once it is uploaded', async () => {
    asStaff('ADMIN');
    vi.spyOn(filesStorage, 'exists').mockResolvedValue(true);
    const change = vi
      .spyOn(adminRepository, 'changeRepresentationStatus')
      .mockResolvedValue({ previousStatus: 'CLOSED', status: 'SUBMITTED_TO_REGULATOR' });

    const res = await api.post(`/representations/${ITEM}/status`, {
      status: 'SUBMITTED_TO_REGULATOR',
      note: 'Filed with SEBI',
      documents: [pack],
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      previousStatus: 'CLOSED',
      status: 'SUBMITTED_TO_REGULATOR',
      representation: { id: ITEM },
    });
    expect(change).toHaveBeenCalledWith(
      '42',
      ITEM,
      { status: 'SUBMITTED_TO_REGULATOR', note: 'Filed with SEBI', documents: [pack] },
      expect.anything(),
    );
  });

  it('refuses documents that were never uploaded and statuses staff do not set', async () => {
    asStaff('ADMIN');
    vi.spyOn(filesStorage, 'exists').mockResolvedValue(false);
    const change = vi.spyOn(adminRepository, 'changeRepresentationStatus');

    const missing = await api.post(`/representations/${ITEM}/status`, {
      status: 'UNDER_REVIEW',
      documents: [pack],
    });
    const closed = await api.post(`/representations/${ITEM}/status`, { status: 'CLOSED' });

    expect(missing.body.error.fields).toEqual({
      'documents.0.objectKey': 'File has not been uploaded yet',
    });
    expect(closed.body.error.fields).toEqual({
      status: 'Choose a status from Under Review onwards',
    });
    expect(change).not.toHaveBeenCalled();
  });

  it('maps a backwards step to 409', async () => {
    asStaff('ADMIN');
    vi.spyOn(adminRepository, 'changeRepresentationStatus').mockResolvedValue({
      error: 'INVALID_TRANSITION',
      status: 'RESOLVED',
    });

    const res = await api.post(`/representations/${ITEM}/status`, { status: 'UNDER_REVIEW' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });
});

describe('credits', () => {
  const body = { userId: TARGET, delta: 5, reason: 'Welcome bonus' };
  const grant = {
    entry: {
      id: ITEM,
      delta: 5,
      balanceAfter: 5,
      reason: 'Welcome bonus',
      refType: 'ADMIN_GRANT',
      createdAt: NOW,
    },
    balance: 5,
  };

  it('needs an Idempotency-Key', async () => {
    asStaff('ADMIN');

    const res = await api.post('/credits/grant', body);

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toHaveProperty('Idempotency-Key');
  });

  it('grants, and replays a retry with the same key', async () => {
    asStaff('ADMIN');
    const call = vi
      .spyOn(adminRepository, 'grantCredits')
      .mockResolvedValueOnce({ ...grant, replayed: false })
      .mockResolvedValueOnce({ ...grant, replayed: true });
    const send = () => api.post('/credits/grant', body).set('Idempotency-Key', 'grant-0001');

    const first = await send();
    const retry = await send();

    expect(first.status).toBe(201);
    expect(first.body.data).toEqual({ userId: TARGET, ...grant });
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(call.mock.calls[0]![1]).toEqual({
      ...body,
      idempotencyKey: 'grant-0001',
      requestHash: expect.any(String),
    });
  });

  it('validates the amount and maps an overdraft', async () => {
    asStaff('ADMIN');
    vi.spyOn(adminRepository, 'grantCredits').mockResolvedValue({
      error: 'INSUFFICIENT_CREDITS',
      balance: 2,
    });
    const send = (b: object) => api.post('/credits/grant', b).set('Idempotency-Key', 'grant-0002');

    const zero = await send({ ...body, delta: 0 });
    const tooMany = await send({ ...body, delta: 5000 });
    const overdraft = await send({ ...body, delta: -5 });

    expect(zero.body.error.fields).toEqual({ delta: 'Grant or revoke at least 1 credit' });
    expect(tooMany.status).toBe(400);
    expect(overdraft.status).toBe(409);
    expect(overdraft.body.error).toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      message: 'The user has only 2 credits',
    });
  });
});

describe('audit logs', () => {
  it('passes filters through and rejects malformed action names', async () => {
    asStaff('ADMIN');
    const logs = vi.spyOn(adminRepository, 'auditLogs').mockResolvedValue(page([]));

    const ok = await api.get(
      `/audit-logs?filter[action]=admin.*,auth.login.failed&filter[user]=${TARGET}`,
    );
    const bad = await api.get('/audit-logs?filter[action]=DROP TABLE');

    expect(ok.status).toBe(200);
    expect(logs).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { action: ['admin.*', 'auth.login.failed'], user: TARGET },
      }),
    );
    expect(bad.status).toBe(400);
  });
});
