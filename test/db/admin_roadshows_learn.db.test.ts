// Admin roadshows, roadshow questions and learn content against the real migrations: the admin
// repository runs against PGlite, calling the same app_admin_* functions as through supabase-js.

import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isUniqueViolationOf } from '../../src/lib/db';
import type { ClientContext } from '../../src/middleware/requestContext';
import { adminRepository, isDbError } from '../../src/modules/admin/admin.repository';
import { createTestDatabase, createUser, dbError } from './pglite';

const holder = vi.hoisted(() => ({ db: undefined as PGlite | undefined }));

vi.mock('../../src/lib/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/db')>();
  const { callFunction } = await import('./pglite');
  return {
    ...original,
    callDb: (fn: string, args: Record<string, unknown> = {}) =>
      callFunction(
        holder.db!,
        fn,
        args,
        (code, message) => new original.DatabaseError(code, message),
      ),
  };
});

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

let db: PGlite;
let staff: string;
let investor: string;
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
  holder.db = db;
  staff = await createUser(db, STAFF);
  investor = await createUser(db, INVESTOR);
  await db.query(
    `insert into app.user_profiles (user_id, name) values ($1, 'Gita Admin'), ($2, 'Ira Investor')`,
    [staff, investor],
  );
  ({ id: issuerId } = await one<{ id: string }>(
    `select id from public.issuers where slug = 'sovereign-alpha-yield'`,
  ));
});

afterAll(async () => {
  await db?.close();
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
            { fiscalYear: 'FY2024', revenue: 1200.5, netProfit: -40, roePct: -3.2 },
            { fiscalYear: 'FY2025', revenue: 1500, netProfit: 85.25, eps: 4.1234 },
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
      isPublished: false,
      publishedAt: null,
      isOpen: false,
      riskFactors: ['Customer concentration', 'Regulatory approvals pending'],
      financials: [
        expect.objectContaining({
          fiscalYear: 'FY2025',
          revenue: 1500,
          netProfit: 85.25,
          eps: 4.1234,
        }),
        expect.objectContaining({
          fiscalYear: 'FY2024',
          netProfit: -40,
          roePct: -3.2,
          ebitda: null,
        }),
      ],
      questions: { pending: 0, published: 0, unanswered: 0 },
    });
    expect((await lastAudit('admin.roadshow.created')).actor_user_id).toBe(staff);
  });

  it('publishes it, keeps the first publication time, and replaces the financials', async () => {
    await adminRepository.saveRoadshow(staff, id, { published: true }, CTX);
    const first = (await adminRepository.findRoadshow(id))!.publishedAt;
    await adminRepository.saveRoadshow(
      staff,
      id,
      { published: true, financials: [{ fiscalYear: 'FY2026', revenue: 1700 }] },
      CTX,
    );

    const roadshow = await adminRepository.findRoadshow(id);
    expect(roadshow).toMatchObject({
      isPublished: true,
      publishedAt: first,
      isOpen: true,
      title: 'Sovereign Alpha IPO roadshow',
    });
    expect(roadshow!.financials.map((f) => f.fiscalYear)).toEqual(['FY2026']);

    await adminRepository.saveRoadshow(staff, id, { published: false }, CTX);
    expect(await adminRepository.findRoadshow(id)).toMatchObject({
      isPublished: false,
      publishedAt: null,
    });
    await adminRepository.saveRoadshow(staff, id, { published: true }, CTX);
  });

  it('lists with filters, and refuses an unknown issuer, a taken slug and a closing time before opening', async () => {
    const published = await adminRepository.findRoadshows({
      ...PAGE,
      filter: { published: true, issuer: issuerId },
    });
    expect(published.items.map((r) => r.id)).toEqual([id]);
    expect((await adminRepository.findRoadshows({ ...PAGE, filter: { open: false } })).total).toBe(
      0,
    );

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
          closesAt: new Date(Date.now() - 2 * DAY).toISOString(),
          opensAt: new Date().toISOString(),
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
          await one<{ public_id: string }>(
            `insert into app.roadshow_questions (roadshow_id, user_id, category, question, status)
             select r.id, $2, $4, $3, $5 from app.roadshows r where r.public_id = $1
             returning public_id`,
            [id, investor, question, category, status],
          )
        ).public_id;
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

    it('publishes the answer, and the question with it', async () => {
      const answered = ok(
        await adminRepository.answerQuestion(
          staff,
          id,
          pending,
          'Six months for anchor investors.',
          CTX,
        ),
      );
      expect(answered).toMatchObject({
        id: pending,
        status: 'PUBLISHED',
        answer: 'Six months for anchor investors.',
        answeredBy: { id: STAFF, name: 'Gita Admin' },
      });
      expect(answered.publishedAt).not.toBeNull();
      expect((await lastAudit('admin.roadshow.question_answered')).metadata).toEqual({
        roadshow: id,
        question: pending,
        replacedAnswer: false,
      });

      ok(
        await adminRepository.answerQuestion(
          staff,
          id,
          pending,
          'Six months, per the offer document.',
          CTX,
        ),
      );
      expect((await lastAudit('admin.roadshow.question_answered')).metadata.replacedAnswer).toBe(
        true,
      );

      const unanswered = await adminRepository.findQuestions(id, {
        ...PAGE,
        filter: { answered: false },
      });
      expect(unanswered?.items.map((q) => q.id)).toEqual([published, rejected]);
    });

    it('refuses rejected questions, your own question, and a question of another roadshow', async () => {
      expect(await adminRepository.answerQuestion(staff, id, rejected, 'No.', CTX)).toEqual({
        error: 'INVALID_TRANSITION',
        status: 'REJECTED',
      });
      expect(
        await adminRepository.answerQuestion(investor, id, published, 'Self answer', CTX),
      ).toEqual({
        error: 'OWN_CONTENT',
      });
      expect(
        await adminRepository.answerQuestion(staff, randomUUID(), published, 'Wrong roadshow', CTX),
      ).toEqual({
        error: 'NOT_FOUND',
      });
    });

    it('queues pending questions for moderation next to reviews and ratings', async () => {
      const fresh = (
        await one<{ public_id: string }>(
          `insert into app.roadshow_questions (roadshow_id, user_id, category, question)
           select r.id, $2, 'CRYPTO', 'Will the issuer hold crypto reserves?' from app.roadshows r
           where r.public_id = $1 returning public_id`,
          [id, investor],
        )
      ).public_id;

      const queue = await adminRepository.moderationQueue({
        ...PAGE,
        filter: { type: ['QUESTION'] },
      });
      expect(queue.items).toEqual([
        expect.objectContaining({
          type: 'QUESTION',
          id: fresh,
          receiptNo: null,
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
          { type: 'QUESTION', decision: 'REJECT', note: 'Speculative' },
          CTX,
        ),
      ).toEqual({
        type: 'QUESTION',
        id: fresh,
        previousStatus: 'PENDING_MODERATION',
        status: 'REJECTED',
      });
      expect(
        await one(`select moderation_note from app.roadshow_questions where public_id = $1`, [
          fresh,
        ]),
      ).toEqual({
        moderation_note: 'Speculative',
      });
    });
  });

  it('soft-deletes a roadshow', async () => {
    expect(await adminRepository.deleteRoadshow(staff, id, CTX)).toBe(true);
    expect(await adminRepository.deleteRoadshow(staff, id, CTX)).toBe(false);
    expect(await adminRepository.saveRoadshow(staff, id, { title: 'Gone roadshow' }, CTX)).toEqual({
      error: 'NOT_FOUND',
    });
    expect((await adminRepository.findRoadshows(PAGE)).total).toBe(0);
    expect(
      (await adminRepository.findRoadshows({ ...PAGE, filter: { deleted: true } })).total,
    ).toBe(1);
  });
});

describe('learn', () => {
  let id: string;

  it('creates a draft with defaults', async () => {
    ({ id } = ok(
      await adminRepository.saveLearn(
        staff,
        null,
        {
          slug: 'reading-an-ipo-prospectus',
          title: 'Reading an IPO prospectus',
          contentType: 'VIDEO',
          tags: ['IPO', 'Basics'],
        },
        CTX,
      ),
    ));
    expect(await adminRepository.findLearnItem(id)).toMatchObject({
      contentType: 'VIDEO',
      minTier: 'OBSERVER',
      downloadable: false,
      featured: false,
      tags: ['IPO', 'Basics'],
      summary: '',
      mediaUrl: null,
      isPublished: false,
    });
    expect((await lastAudit('admin.learn.created')).metadata).toMatchObject({ learn: id });
  });

  it('updates only the fields sent, gates and publishes it', async () => {
    await adminRepository.saveLearn(
      staff,
      id,
      {
        minTier: 'PRIVE',
        downloadable: true,
        mediaUrl: 'https://cdn.example.com/v/ipo.mp4',
        durationSeconds: 540,
        published: true,
      },
      CTX,
    );
    expect(await adminRepository.findLearnItem(id)).toMatchObject({
      title: 'Reading an IPO prospectus',
      minTier: 'PRIVE',
      downloadable: true,
      durationSeconds: 540,
      isPublished: true,
    });

    const prive = await adminRepository.findLearn({
      ...PAGE,
      filter: { minTier: ['PRIVE'], published: true },
    });
    expect(prive.items.map((l) => l.id)).toEqual([id]);
    expect(
      (
        await adminRepository.findLearn({
          ...PAGE,
          q: 'prospectus',
          filter: { contentType: ['REPORT'] },
        })
      ).total,
    ).toBe(0);
  });

  it('refuses unknown content types at the database too, and soft-deletes', async () => {
    const error = await dbError(
      adminRepository.saveLearn(staff, id, { contentType: 'MEME' as never }, CTX),
    );
    expect(error).toMatchObject({ code: '23514' });

    expect(await adminRepository.deleteLearn(staff, id, CTX)).toBe(true);
    expect(await adminRepository.findLearn(PAGE)).toEqual({ items: [], total: 0 });
    expect(await adminRepository.saveLearn(staff, id, { title: 'Gone' }, CTX)).toEqual({
      error: 'NOT_FOUND',
    });
  });
});
