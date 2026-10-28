import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  adminRepository,
  type AdminLearnItem,
  type AdminQuestion,
  type AdminRoadshow,
} from '../../src/modules/admin/admin.repository';
import { filesStorage } from '../../src/modules/files/files.storage';
import type { StaffRole } from '../../src/types/domain';
import { AUTH_HEADER, app, makeUser, signInAs } from '../helpers';
import { asJson, uniqueViolation } from '../helpers/dbErrors';

const ROADSHOW = '7d7d7d7d-0000-4000-8000-000000000001';
const QUESTION = '7d7d7d7d-0000-4000-8000-000000000002';
const ISSUER = '7d7d7d7d-0000-4000-8000-000000000003';
const LEARN = '7d7d7d7d-0000-4000-8000-000000000004';
const NOW = new Date('2026-10-28T09:00:00.000Z');
const LATER = '2026-12-01T00:00:00.000Z';

function asStaff(...roles: StaffRole[]) {
  signInAs(makeUser({ userId: '42' }));
  vi.spyOn(adminRepository, 'staffRoles').mockResolvedValue(roles);
}

const api = {
  get: (path: string) => request(app).get(`/api/v1/admin${path}`).set(AUTH_HEADER),
  post: (path: string, body: object = {}) =>
    request(app).post(`/api/v1/admin${path}`).set(AUTH_HEADER).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(`/api/v1/admin${path}`).set(AUTH_HEADER).send(body),
  delete: (path: string) => request(app).delete(`/api/v1/admin${path}`).set(AUTH_HEADER),
};

const roadshow: AdminRoadshow = {
  id: ROADSHOW,
  slug: 'sovereign-alpha-ipo',
  title: 'Sovereign Alpha IPO roadshow',
  summary: null,
  issuer: { id: ISSUER, name: 'Sovereign Alpha Yield' },
  typeOfIssue: 'IPO',
  instruments: 'Equity shares',
  noOfInstruments: null,
  offerPrice: 325,
  currency: 'INR',
  lockIn: null,
  maturity: null,
  convertibility: null,
  callable: false,
  couponRate: null,
  riskFactors: [],
  opensAt: null,
  closesAt: new Date(LATER),
  poolEnabled: true,
  status: 'DRAFT',
  publishedAt: null,
  isOpen: false,
  financials: [],
  documentCount: 0,
  poolMembers: 0,
  questions: { pending: 0, published: 0, unanswered: 0 },
  createdAt: NOW,
  updatedAt: NOW,
};

const question: AdminQuestion = {
  id: QUESTION,
  category: 'EQUITY',
  question: 'What is the lock-in for anchor investors?',
  status: 'PUBLISHED',
  featured: true,
  moderationNote: null,
  answer: 'Six months.',
  answeredAt: NOW,
  answeredBy: { id: ROADSHOW, name: 'Gita Admin' },
  author: { id: ISSUER, name: 'Ira Investor', tier: 'PRIVE', kycStatus: 'APPROVED' },
  submittedAt: NOW,
  updatedAt: NOW,
};

const learnItem: AdminLearnItem = {
  id: LEARN,
  title: 'Reading an IPO prospectus',
  summary: null,
  format: 'VIDEO',
  category: null,
  access: 'FREE',
  thumbnailUrl: null,
  contentUrl: null,
  durationSeconds: null,
  downloadPath: null,
  ratingAvg: 0,
  ratingCount: 0,
  status: 'DRAFT',
  publishedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const newRoadshow = {
  slug: 'sovereign-alpha-ipo',
  issuerId: ISSUER,
  title: 'Sovereign Alpha IPO roadshow',
  typeOfIssue: 'IPO',
  instruments: 'Equity shares',
  closesAt: LATER,
};

describe('roadshows', () => {
  it('creates a roadshow with its financials and returns it', async () => {
    asStaff('ADMIN');
    const save = vi.spyOn(adminRepository, 'saveRoadshow').mockResolvedValue({ id: ROADSHOW });
    vi.spyOn(adminRepository, 'findRoadshow').mockResolvedValue(roadshow);
    const body = {
      ...newRoadshow,
      status: 'PUBLISHED',
      financials: [{ fiscalYear: 2025, revenue: 1500, netProfit: -4, cashAndEquivalents: 90 }],
    };

    const res = await api.post('/roadshows', body);

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(asJson(roadshow));
    expect(save).toHaveBeenCalledWith('42', null, body, expect.anything());
  });

  it('validates required fields, financial years, status and the window', async () => {
    asStaff('ADMIN');
    const save = vi.spyOn(adminRepository, 'saveRoadshow');

    const missing = await api.post('/roadshows', { slug: 'x-roadshow' });
    const badYear = await api.post('/roadshows', {
      ...newRoadshow,
      financials: [{ fiscalYear: 'FY2025' }],
    });
    const twice = await api.post('/roadshows', {
      ...newRoadshow,
      financials: [{ fiscalYear: 2025 }, { fiscalYear: 2025 }],
    });
    const status = await api.patch(`/roadshows/${ROADSHOW}`, { status: 'LIVE' });
    const window = await api.patch(`/roadshows/${ROADSHOW}`, { opensAt: LATER, closesAt: NOW });
    const coupon = await api.patch(`/roadshows/${ROADSHOW}`, { couponRate: 120 });

    expect(Object.keys(missing.body.error.fields).sort()).toEqual(
      ['closesAt', 'instruments', 'issuerId', 'title', 'typeOfIssue'].sort(),
    );
    expect(badYear.body.error.fields).toHaveProperty(['financials.0.fiscalYear']);
    expect(twice.body.error.fields).toEqual({ financials: 'List each fiscal year once' });
    expect(status.body.error.fields).toHaveProperty('status');
    expect(window.body.error.fields).toEqual({ closesAt: 'Must be after the opening time' });
    expect(coupon.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('reports an unknown issuer and a taken slug as field errors', async () => {
    asStaff('ADMIN');
    vi.spyOn(adminRepository, 'saveRoadshow')
      .mockResolvedValueOnce({ error: 'ISSUER_NOT_FOUND' })
      .mockRejectedValueOnce(uniqueViolation('roadshows_slug_key'));

    const issuer = await api.patch(`/roadshows/${ROADSHOW}`, { issuerId: ISSUER });
    const slug = await api.post('/roadshows', newRoadshow);

    expect(issuer.status).toBe(400);
    expect(issuer.body.error.fields).toEqual({ issuerId: 'Issuer not found' });
    expect(slug.status).toBe(409);
    expect(slug.body.error.code).toBe('SLUG_TAKEN');
  });

  it('lists, reads and archives', async () => {
    asStaff('ANALYST');
    const find = vi
      .spyOn(adminRepository, 'findRoadshows')
      .mockResolvedValue({ items: [roadshow], total: 1 });
    vi.spyOn(adminRepository, 'findRoadshow')
      .mockResolvedValueOnce(roadshow)
      .mockResolvedValueOnce(null);

    const list = await api.get(
      `/roadshows?q=alpha&filter[status]=PUBLISHED,ARCHIVED&filter[issuer]=${ISSUER}`,
    );
    const found = await api.get(`/roadshows/${ROADSHOW}`);
    const missing = await api.get(`/roadshows/${ROADSHOW}`);

    expect(list.body).toEqual({
      data: [asJson(roadshow)],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'alpha',
        filter: { status: ['PUBLISHED', 'ARCHIVED'], issuer: ISSUER },
      }),
    );
    expect(found.body.data.id).toBe(ROADSHOW);
    expect(missing.status).toBe(404);

    asStaff('ADMIN');
    vi.spyOn(adminRepository, 'archiveRoadshow')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect((await api.delete(`/roadshows/${ROADSHOW}`)).status).toBe(204);
    expect((await api.delete(`/roadshows/${ROADSHOW}`)).status).toBe(404);
  });

  it('is written by ADMIN only', async () => {
    asStaff('MODERATOR');

    const res = await api.post('/roadshows', newRoadshow);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROLE_FORBIDDEN');
  });
});

describe('roadshow questions', () => {
  it('lists questions with filters, 404 for an unknown roadshow', async () => {
    asStaff('MODERATOR');
    const find = vi
      .spyOn(adminRepository, 'findQuestions')
      .mockResolvedValueOnce({ items: [question], total: 1 })
      .mockResolvedValueOnce(null);

    const list = await api.get(
      `/roadshows/${ROADSHOW}/questions?filter[answered]=false&filter[category]=GENERAL,DEBT`,
    );
    const missing = await api.get(`/roadshows/${ROADSHOW}/questions`);

    expect(list.body.data).toEqual([asJson(question)]);
    expect(find.mock.calls[0]![1]).toMatchObject({
      filter: { answered: false, category: ['GENERAL', 'DEBT'] },
    });
    expect(missing.status).toBe(404);
  });

  it('publishes the issuer answer and can feature the question', async () => {
    asStaff('MODERATOR');
    const answer = vi.spyOn(adminRepository, 'answerQuestion').mockResolvedValue(question);

    const res = await api.post(`/roadshows/${ROADSHOW}/questions/${QUESTION}/answer`, {
      answer: '  Six months.  ',
      featured: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(asJson(question));
    expect(answer).toHaveBeenCalledWith(
      '42',
      ROADSHOW,
      QUESTION,
      { answer: 'Six months.', featured: true },
      expect.anything(),
    );
  });

  it('validates the answer and maps refusals', async () => {
    asStaff('ADMIN');
    vi.spyOn(adminRepository, 'answerQuestion')
      .mockResolvedValueOnce({ error: 'INVALID_TRANSITION', status: 'REJECTED' })
      .mockResolvedValueOnce({ error: 'OWN_CONTENT' })
      .mockResolvedValueOnce({ error: 'NOT_FOUND' });
    const path = `/roadshows/${ROADSHOW}/questions/${QUESTION}/answer`;

    const empty = await api.post(path, { answer: '   ' });
    const badId = await api.post(`/roadshows/${ROADSHOW}/questions/not-a-uuid/answer`, {
      answer: 'x',
    });
    const rejected = await api.post(path, { answer: 'Yes' });
    const own = await api.post(path, { answer: 'Yes' });
    const missing = await api.post(path, { answer: 'Yes' });

    expect(empty.body.error.fields).toEqual({ answer: 'Write the answer' });
    expect(badId.body.error.fields).toEqual({ questionId: 'Invalid question ID' });
    expect([rejected.status, rejected.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
    expect([own.status, own.body.error.code]).toEqual([403, 'CONFLICT_OF_INTEREST']);
    expect([missing.status, missing.body.error.message]).toEqual([404, 'Question not found']);
  });

  it('is closed to roles without moderation', async () => {
    asStaff('SUPPORT');

    const res = await api.post(`/roadshows/${ROADSHOW}/questions/${QUESTION}/answer`, {
      answer: 'Yes',
    });

    expect(res.body.error.code).toBe('ROLE_FORBIDDEN');
  });

  it('joins the moderation queue as type QUESTION', async () => {
    asStaff('MODERATOR');
    const queue = vi
      .spyOn(adminRepository, 'moderationQueue')
      .mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(adminRepository, 'moderate').mockResolvedValue({ error: 'NOT_FOUND' });

    await api.get('/moderation/queue?filter[type]=QUESTION');
    const decision = await api.post(`/moderation/${QUESTION}/decision`, {
      type: 'QUESTION',
      decision: 'REJECT',
      note: 'Speculative',
    });

    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ filter: { type: ['QUESTION'] } }));
    expect(decision.body.error.message).toBe('Question not found');
  });
});

describe('learn', () => {
  it('creates an item and returns it', async () => {
    asStaff('ADMIN');
    const save = vi.spyOn(adminRepository, 'saveLearn').mockResolvedValue({ id: LEARN });
    vi.spyOn(adminRepository, 'findLearnItem').mockResolvedValue(learnItem);
    const body = { title: 'Reading an IPO prospectus', format: 'VIDEO', access: 'PREMIUM' };

    const res = await api.post('/learn', body);

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(asJson(learnItem));
    expect(save).toHaveBeenCalledWith('42', null, body, expect.anything());
  });

  it('validates format, access, links and paths', async () => {
    asStaff('ADMIN');
    const save = vi.spyOn(adminRepository, 'saveLearn');

    const missing = await api.post('/learn', { summary: 'No title' });
    const format = await api.patch(`/learn/${LEARN}`, { format: 'MEME' });
    const access = await api.patch(`/learn/${LEARN}`, { access: 'GOLD' });
    const link = await api.patch(`/learn/${LEARN}`, { contentUrl: 'not a url' });
    const path = await api.patch(`/learn/${LEARN}`, { downloadPath: '../secret.pdf' });
    const empty = await api.patch(`/learn/${LEARN}`, {});

    expect(Object.keys(missing.body.error.fields).sort()).toEqual(['format', 'title']);
    expect(format.body.error.fields).toHaveProperty('format');
    expect(access.body.error.fields).toHaveProperty('access');
    expect(link.body.error.fields).toHaveProperty('contentUrl');
    expect(path.body.error.fields).toEqual({
      downloadPath: 'Use a path like reports/scorecard.pdf',
    });
    expect(empty.body.error.fields).toEqual({ _: 'Change at least one field' });
    expect(save).not.toHaveBeenCalled();
  });

  it('accepts a report download only once it is in the learn-reports bucket', async () => {
    asStaff('ADMIN');
    const exists = vi
      .spyOn(filesStorage, 'exists')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const save = vi.spyOn(adminRepository, 'saveLearn').mockResolvedValue({ id: LEARN });
    vi.spyOn(adminRepository, 'findLearnItem').mockResolvedValue(learnItem);

    const missing = await api.patch(`/learn/${LEARN}`, { downloadPath: 'reports/ipo-guide.pdf' });
    const uploaded = await api.patch(`/learn/${LEARN}`, { downloadPath: 'reports/ipo-guide.pdf' });

    expect(missing.body.error.fields).toEqual({
      downloadPath: 'No report has been uploaded at this path',
    });
    expect(uploaded.status).toBe(200);
    expect(exists).toHaveBeenCalledWith('learn-reports', 'reports/ipo-guide.pdf');
    expect(save).toHaveBeenCalledOnce();
  });

  it('publishes with a partial update, lists with filters and archives', async () => {
    asStaff('ADMIN');
    const save = vi.spyOn(adminRepository, 'saveLearn').mockResolvedValue({ id: LEARN });
    vi.spyOn(adminRepository, 'findLearnItem').mockResolvedValue({
      ...learnItem,
      status: 'PUBLISHED',
      publishedAt: NOW,
    });
    const find = vi
      .spyOn(adminRepository, 'findLearn')
      .mockResolvedValue({ items: [learnItem], total: 1 });
    vi.spyOn(adminRepository, 'archiveLearn').mockResolvedValue(true);

    const patched = await api.patch(`/learn/${LEARN}`, { status: 'PUBLISHED' });
    await api.get('/learn?filter[format]=VIDEO,REPORT&filter[access]=PREMIUM&filter[status]=DRAFT');
    const archived = await api.delete(`/learn/${LEARN}`);

    expect(patched.body.data.status).toBe('PUBLISHED');
    expect(save).toHaveBeenCalledWith('42', LEARN, { status: 'PUBLISHED' }, expect.anything());
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { format: ['VIDEO', 'REPORT'], access: ['PREMIUM'], status: ['DRAFT'] },
      }),
    );
    expect(archived.status).toBe(204);
  });

  it('is readable by every staff role and written by ADMIN only', async () => {
    vi.spyOn(adminRepository, 'findLearn').mockResolvedValue({ items: [], total: 0 });

    asStaff('ANALYST');
    const read = await api.get('/learn');
    const write = await api.delete(`/learn/${LEARN}`);

    expect(read.status).toBe(200);
    expect(write.body.error.code).toBe('ROLE_FORBIDDEN');
  });
});
