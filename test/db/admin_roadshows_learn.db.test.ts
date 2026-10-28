// Admin roadshows, roadshow questions and learn content against the real migrations: the admin
// repository runs against PGlite through callDb, which checks every argument and result against
// src/lib/dbFunctions.ts. The tables are the Roadshows and Learn modules' own.

import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseError, dbTransport, isUniqueViolationOf } from '../../src/lib/db';
import type { ClientContext } from '../../src/middleware/requestContext';
import { adminRepository, isDbError } from '../../src/modules/admin/admin.repository';
import { callFunction, createTestDatabase, createUser, dbError } from './pglite';

vi.mock('../../src/lib/audit', async (importOriginal) => importOriginal());

const STAFF = 'aeaeaeae-0000-4000-8000-0000000000a1';
const INVESTOR = 'aeaeaeae-0000-4000-8000-0000000000b2';
const CTX: ClientContext = {
  ip: '10.0.0.7',
  userAgent: 'vitest',
  appVersion: 'admin-1',
  requestId: 'req-rs',
};
const PAGE = { page: 1, pageSize: 20 };
const DAY = 86_400_000;
const TITLE = 'Sovereign Alpha IPO roadshow';

let db: PGlite;
let staff: string;
let issuerId: string;

async function one<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  const { rows } = await db.query<T>(query, params);
  if (!rows[0]) throw new Error(`no row for: ${query}`);
  return rows[0];
}

function ok<T extends object>(result: T): Exclude<T, { error: string }> {
  if (isDbError(result)) throw new Error(`unexpected error ${JSON.stringify(result)}`);
  return result as Exclude<T, { error: string }>;
}

async function lastAudit(action: string) {
  return one<{ actor_user_id: string; metadata: Record<string, unknown> }>(
    `select actor_user_id::text, metadata from app.audit_logs where action = $1 order by id desc limit 1`,
    [action],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  staff = await createUser(db, STAFF);
  const investor = await createUser(db, INVESTOR);
  await db.query(
    `insert into app.user_profiles (user_id, name) values ($1, 'Gita Admin'), ($2, 'Ira Investor')`,
    [staff, investor],
  );
  ({ id: issuerId } = await one<{ id: string }>(
    `select id from public.issuers where slug = 'sovereign-alpha-yield'`,
  ));
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.spyOn(dbTransport, 'rpc').mockImplementation((fn, args) =>
    callFunction(db, fn, args, (code, message) => new DatabaseError(code, message)),
  );
});

describe('roadshows', () => {
  let id: string;

  it('creates a draft roadshow with its financials', async () => {
    ({ id } = ok(
      await adminRepository.saveRoadshow(
        staff,
        null,
        {
          slug: 'sovereign-alpha-ipo',
          issuerId,
          title: 'Sovereign Alpha IPO roadshow',
          typeOfIssue: 'IPO',
          instruments: 'Equity shares',
          offerPrice: 325,
          couponRate: null,
          riskFactors: ['Customer concentration', 'Regulatory approvals pending'],
          closesAt: new Date(Date.now() + 30 * DAY).toISOString(),
          poolEnabled: true,
          financials: [
            { fiscalYear: 2024, revenue: 1200.5, netProfit: -40 },
            {
              fiscalYear: 2025,
              revenue: 1500,
              netProfit: 85.25,
              eps: 4.1234,
              cashAndEquivalents: 90,
            },
          ],
        },
        CTX,
      ),
    ));

    expect(await adminRepository.findRoadshow(id)).toMatchObject({
      slug: 'sovereign-alpha-ipo',
      issuer: { id: issuerId, name: 'Sovereign Alpha Yield' },
      currency: 'INR',
      offerPrice: 325,
      callable: false,
      poolEnabled: true,
      status: 'DRAFT',
      publishedAt: null,
      opensAt: null,
      isOpen: false,
      riskFactors: ['Customer concentration', 'Regulatory approvals pending'],
      financials: [
        expect.objectContaining({
          fiscalYear: 2025,
          revenue: 1500,
          netProfit: 85.25,
          eps: 4.1234,
          cashAndEquivalents: 90,
        }),
        expect.objectContaining({ fiscalYear: 2024, netProfit: -40, ebitda: null }),
      ],
      documentCount: 0,
      poolMembers: 0,
      questions: { pending: 0, published: 0, unanswered: 0 },
    });
    expect((await lastAudit('admin.roadshow.created')).actor_user_id).toBe(staff);
  });

  it('publishes it (keeping the first publication time) and replaces the financials', async () => {
    await adminRepository.saveRoadshow(staff, id, { status: 'PUBLISHED' }, CTX);
    const first = (await adminRepository.findRoadshow(id))!.publishedAt;
    expect(first).toBeInstanceOf(Date);
    await adminRepository.saveRoadshow(
      staff,
      id,
      { status: 'PUBLISHED', financials: [{ fiscalYear: 2026, revenue: 1700 }] },
      CTX,
    );

    const roadshow = await adminRepository.findRoadshow(id);
    expect(roadshow).toMatchObject({ status: 'PUBLISHED', publishedAt: first, isOpen: true });
    expect(roadshow!.financials.map((f) => f.fiscalYear)).toEqual([2026]);
  });

  it('lists with filters, and refuses an unknown issuer, a taken slug and a closing time before opening', async () => {
    // The seed has roadshows too, so these lists are narrowed to this one by its title.
    const published = await adminRepository.findRoadshows({
      ...PAGE,
      q: TITLE,
      filter: { status: ['PUBLISHED'], issuer: issuerId },
    });
    expect(published.items.map((r) => r.id)).toEqual([id]);
    expect(
      (await adminRepository.findRoadshows({ ...PAGE, q: TITLE, filter: { open: true } })).total,
    ).toBe(1);
    expect(
      (await adminRepository.findRoadshows({ ...PAGE, q: TITLE, filter: { open: false } })).total,
    ).toBe(0);

    expect(await adminRepository.saveRoadshow(staff, id, { issuerId: randomUUID() }, CTX)).toEqual({
      error: 'ISSUER_NOT_FOUND',
    });
    const taken = await dbError(
      adminRepository.saveRoadshow(
        staff,
        null,
        {
          slug: 'sovereign-alpha-ipo',
          issuerId,
          title: 'Copy roadshow',
          typeOfIssue: 'IPO',
          instruments: 'Equity',
          closesAt: new Date(Date.now() + DAY).toISOString(),
        },
        CTX,
      ),
    );
    expect(isUniqueViolationOf(taken, 'roadshows_slug_key')).toBe(true);
    const window = await dbError(
      adminRepository.saveRoadshow(
        staff,
        id,
        {
          opensAt: new Date().toISOString(),
          closesAt: new Date(Date.now() - 2 * DAY).toISOString(),
        },
        CTX,
      ),
    );
    expect(window).toMatchObject({ code: '23514' });
  });

  describe('questions', () => {
    let pending: string;
    let published: string;
    let rejected: string;

    beforeAll(async () => {
      const ask = async (question: string, status = 'PENDING_MODERATION', category = 'EQUITY') =>
        (
          await one<{ id: string }>(
            `insert into public.roadshow_questions (roadshow_id, user_id, category, question, status)
             values ($1, $2, $4, $3, $5) returning id`,
            [id, INVESTOR, question, category, status],
          )
        ).id;
      pending = await ask('What is the lock-in for anchor investors?');
      published = await ask('How will the proceeds be used?', 'PUBLISHED', 'DEBT');
      rejected = await ask('Is this a guaranteed return??', 'REJECTED');
    });

    it('lists questions, oldest first, with filters', async () => {
      const all = await adminRepository.findQuestions(id, PAGE);
      expect(all?.items.map((q) => q.id)).toEqual([pending, published, rejected]);
      expect(all?.items[0]).toMatchObject({
        category: 'EQUITY',
        status: 'PENDING_MODERATION',
        featured: false,
        answer: null,
        answeredBy: null,
        author: { id: INVESTOR, name: 'Ira Investor' },
      });

      const debt = await adminRepository.findQuestions(id, {
        ...PAGE,
        filter: { category: ['DEBT'] },
      });
      expect(debt?.items.map((q) => q.id)).toEqual([published]);
      expect(await adminRepository.findQuestions(randomUUID(), PAGE)).toBeNull();
      expect((await adminRepository.findRoadshow(id))?.questions).toEqual({
        pending: 1,
        published: 1,
        unanswered: 2,
      });
    });

    it('publishes the answer with the question, features it and notifies the asker once', async () => {
      const answered = ok(
        await adminRepository.answerQuestion(
          staff,
          id,
          pending,
          { answer: 'Six months for anchor investors.', featured: true },
          CTX,
        ),
      );
      expect(answered).toMatchObject({
        id: pending,
        status: 'PUBLISHED',
        featured: true,
        answer: 'Six months for anchor investors.',
        answeredBy: { id: STAFF, name: 'Gita Admin' },
      });
      expect((await lastAudit('admin.roadshow.question_answered')).metadata).toEqual({
        roadshow: id,
        question: pending,
        replacedAnswer: false,
      });

      // Replacing the answer keeps the feature flag and does not notify again.
      const replaced = ok(
        await adminRepository.answerQuestion(
          staff,
          id,
          pending,
          { answer: 'Six months, per the offer document.' },
          CTX,
        ),
      );
      expect(replaced.featured).toBe(true);
      expect((await lastAudit('admin.roadshow.question_answered')).metadata['replacedAnswer']).toBe(
        true,
      );
      expect(
        await one(
          `select count(*)::int as n from public.notifications where user_id = $1 and type = 'ROADSHOW'`,
          [INVESTOR],
        ),
      ).toEqual({ n: 1 });

      const unanswered = await adminRepository.findQuestions(id, {
        ...PAGE,
        filter: { answered: false },
      });
      expect(unanswered?.items.map((q) => q.id)).toEqual([published, rejected]);
    });

    it('refuses rejected questions, your own question, and a question of another roadshow', async () => {
      expect(
        await adminRepository.answerQuestion(staff, id, rejected, { answer: 'No.' }, CTX),
      ).toEqual({
        error: 'INVALID_TRANSITION',
        status: 'REJECTED',
      });
      const investorId = (
        await one<{ id: string }>(`select id::text from app.users where public_id = $1`, [INVESTOR])
      ).id;
      expect(
        await adminRepository.answerQuestion(
          investorId,
          id,
          published,
          { answer: 'Self answer' },
          CTX,
        ),
      ).toEqual({
        error: 'OWN_CONTENT',
      });
      expect(
        await adminRepository.answerQuestion(
          staff,
          randomUUID(),
          published,
          { answer: 'Wrong roadshow' },
          CTX,
        ),
      ).toEqual({
        error: 'NOT_FOUND',
      });
    });

    it('queues pending questions for moderation; REMOVE rejects, REQUEST_CHANGES does not apply', async () => {
      const fresh = (
        await one<{ id: string }>(
          `insert into public.roadshow_questions (roadshow_id, user_id, category, question)
           values ($1, $2, 'CRYPTO', 'Will the issuer hold crypto reserves?') returning id`,
          [id, INVESTOR],
        )
      ).id;

      const queue = await adminRepository.moderationQueue({
        ...PAGE,
        filter: { type: ['QUESTION'] },
      });
      expect(queue.items).toEqual([
        expect.objectContaining({
          type: 'QUESTION',
          id: fresh,
          receiptNo: null,
          author: expect.objectContaining({ id: INVESTOR, name: 'Ira Investor' }),
          subject: { type: 'ROADSHOW', id, name: 'Sovereign Alpha IPO roadshow' },
          summary: {
            category: 'CRYPTO',
            excerpt: 'Will the issuer hold crypto reserves?',
            answered: false,
          },
        }),
      ]);
      expect(await adminRepository.moderationItem('QUESTION', fresh)).toMatchObject({
        content: {
          category: 'CRYPTO',
          question: 'Will the issuer hold crypto reserves?',
          answer: null,
        },
      });

      expect(
        await adminRepository.moderate(
          staff,
          fresh,
          { type: 'QUESTION', decision: 'REQUEST_CHANGES', note: 'Rephrase' },
          CTX,
        ),
      ).toEqual({ error: 'INVALID_TRANSITION', status: 'PENDING_MODERATION' });
      expect(
        await adminRepository.moderate(
          staff,
          fresh,
          { type: 'QUESTION', decision: 'APPROVE' },
          CTX,
        ),
      ).toMatchObject({
        status: 'PUBLISHED',
      });
      expect(
        await adminRepository.moderate(
          staff,
          fresh,
          { type: 'QUESTION', decision: 'REMOVE', note: 'Speculative' },
          CTX,
        ),
      ).toEqual({ type: 'QUESTION', id: fresh, previousStatus: 'PUBLISHED', status: 'REJECTED' });
      expect(
        await one(`select status, moderation_note from public.roadshow_questions where id = $1`, [
          fresh,
        ]),
      ).toEqual({
        status: 'REJECTED',
        moderation_note: 'Speculative',
      });
    });
  });

  it('archives a roadshow instead of deleting it', async () => {
    expect(await adminRepository.archiveRoadshow(staff, id, CTX)).toBe(true);
    expect(await adminRepository.archiveRoadshow(staff, id, CTX)).toBe(false);
    expect((await adminRepository.findRoadshows({ ...PAGE, q: TITLE })).total).toBe(0);
    expect(
      (await adminRepository.findRoadshows({ ...PAGE, q: TITLE, filter: { status: ['ARCHIVED'] } }))
        .total,
    ).toBe(1);
    // Its questions stay.
    expect((await adminRepository.findQuestions(id, PAGE))?.total).toBe(4);
  });
});

describe('learn', () => {
  let id: string;

  it('creates a draft with defaults', async () => {
    ({ id } = ok(
      await adminRepository.saveLearn(
        staff,
        null,
        { title: 'Reading an IPO prospectus', format: 'VIDEO', category: 'IPO basics' },
        CTX,
      ),
    ));
    expect(await adminRepository.findLearnItem(id)).toMatchObject({
      format: 'VIDEO',
      access: 'FREE',
      status: 'DRAFT',
      category: 'IPO basics',
      contentUrl: null,
      downloadPath: null,
      ratingAvg: 0,
      ratingCount: 0,
      publishedAt: null,
    });
    expect((await lastAudit('admin.learn.created')).metadata).toMatchObject({ learn: id });
  });

  it('updates only the fields sent, gates and publishes it', async () => {
    await adminRepository.saveLearn(
      staff,
      id,
      {
        access: 'PREMIUM',
        contentUrl: 'https://cdn.example.com/v/ipo.mp4',
        downloadPath: 'reports/ipo-guide.pdf',
        durationSeconds: 540,
        status: 'PUBLISHED',
      },
      CTX,
    );
    expect(await adminRepository.findLearnItem(id)).toMatchObject({
      title: 'Reading an IPO prospectus',
      access: 'PREMIUM',
      downloadPath: 'reports/ipo-guide.pdf',
      durationSeconds: 540,
      status: 'PUBLISHED',
      publishedAt: expect.any(Date),
    });

    // The seed has learn items too, so these lists are narrowed to this one by its title.
    const premium = await adminRepository.findLearn({
      ...PAGE,
      q: 'prospectus',
      filter: { access: ['PREMIUM'], status: ['PUBLISHED'] },
    });
    expect(premium.items.map((l) => l.id)).toEqual([id]);
    expect(
      (
        await adminRepository.findLearn({
          ...PAGE,
          q: 'prospectus',
          filter: { format: ['REPORT'] },
        })
      ).total,
    ).toBe(0);
  });

  it('archives instead of deleting, and keeps ratings', async () => {
    await db.query(
      `insert into public.learn_ratings (learn_item_id, user_id, rating) values ($1, $2, 4)`,
      [id, INVESTOR],
    );

    expect(await adminRepository.archiveLearn(staff, id, CTX)).toBe(true);
    expect(await adminRepository.findLearn({ ...PAGE, q: 'prospectus' })).toEqual({
      items: [],
      total: 0,
    });
    expect(await adminRepository.findLearnItem(id)).toMatchObject({
      status: 'ARCHIVED',
      ratingCount: 1,
    });
    expect(await adminRepository.saveLearn(staff, randomUUID(), { title: 'Gone' }, CTX)).toEqual({
      error: 'NOT_FOUND',
    });
  });
});
