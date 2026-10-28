// The admin module against the real migrations and seed: its services run against PGlite, calling
// the same app_admin_* functions they call through supabase-js, so every rule below is the
// database's own (state checks, transactions, notifications, audit entries) and every result
// passes the shapes declared in src/lib/dbFunctions.ts.

import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt, keyedHash } from '../../src/lib/crypto';
import { callDb, DatabaseError, dbTransport } from '../../src/lib/db';
import type { Member } from '../../src/lib/membership';
import type { ClientContext } from '../../src/middleware/requestContext';
import { listAuditLogs } from '../../src/modules/admin/audit.service';
import { changeCredits } from '../../src/modules/admin/credits.service';
import {
  decideKyc,
  getKycSubmission,
  listKycSubmissions,
} from '../../src/modules/admin/kyc.service';
import { decideModeration, listModerationQueue } from '../../src/modules/admin/moderation.service';
import * as representations from '../../src/modules/admin/representations.service';
import { answerQuestion } from '../../src/modules/admin/roadshows.service';
import { getUser, listUsers, setRoles, updateUser } from '../../src/modules/admin/users.service';
import { filesStorage } from '../../src/modules/files/files.storage';
import { callFunction, createTestDatabase } from './pglite';

// The real audit log (test/setup.ts stubs it), so audit entries written by the API are checked too.
vi.mock('../../src/lib/audit', async (importOriginal) => importOriginal());
vi.mock('../../src/lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/storage')>()),
  createSignedDownload: () =>
    Promise.resolve({ url: 'https://signed.example/file', expiresAt: '2026-10-28T10:05:00Z' }),
}));

const CTX: ClientContext = {
  ip: '10.0.0.9',
  userAgent: 'vitest',
  appVersion: null,
  requestId: 'req-admin',
};
const PAGE = { page: 1, pageSize: 20 };

let db: PGlite;

async function rows<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  return (await db.query<T>(query, params)).rows;
}

async function one<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  const [row] = await rows<T>(query, params);
  if (!row) throw new Error(`no row for: ${query}`);
  return row;
}

interface TestAccount {
  id: string;
  publicId: string;
  member: Member;
}

/** An account with a profile name and, optionally, real encrypted contact details. */
async function account(
  name: string,
  contact?: { email: string; phone: string },
): Promise<TestAccount> {
  const publicId = randomUUID();
  const { id } = await one<{ id: string }>(
    `insert into app.users (public_id, email_enc, email_hash, phone_country_code, phone_enc, phone_hash,
                            password_hash, email_verified_at, phone_verified_at)
     values ($1, $2, $3, '+91', $4, $5, 'x', now(), now()) returning id::text`,
    [
      publicId,
      contact ? encrypt(contact.email, 'email') : 'x',
      contact ? keyedHash('email', contact.email) : `e:${publicId}`,
      contact ? encrypt(contact.phone, 'phone') : 'x',
      contact ? keyedHash('phone', contact.phone) : `p:${publicId}`,
    ],
  );
  await db.query(`insert into app.user_profiles (user_id, name) values ($1, $2)`, [id, name]);
  return {
    id,
    publicId,
    member: {
      userId: id,
      userPublicId: publicId,
      sessionId: '0',
      sessionPublicId: randomUUID(),
      tier: 'OBSERVER',
      requestedTier: null,
      kycStatus: 'NOT_STARTED',
      fullName: name,
    },
  };
}

async function grantRole(user: TestAccount, role: string) {
  await db.query(`insert into app.user_roles (user_id, role) values ($1, $2)`, [user.id, role]);
}

const notifications = (user: TestAccount, type: string) =>
  rows<{ title: string; body: string; data: Record<string, unknown> }>(
    `select title, body, data from public.notifications where user_id = $1 and type = $2 order by created_at`,
    [user.publicId, type],
  );

const auditEntries = (action: string) =>
  rows<{ actor_user_id: string; metadata: Record<string, unknown> }>(
    `select actor_user_id::text, metadata from app.audit_logs where action = $1 order by id`,
    [action],
  );

let admin: TestAccount;
let moderator: TestAccount;
let asha: TestAccount;
let ravi: TestAccount;

beforeAll(async () => {
  db = await createTestDatabase();
  admin = await account('Grace Admin');
  moderator = await account('Moe Moderator');
  asha = await account('Asha Rao', { email: 'asha@example.com', phone: '+919876543210' });
  ravi = await account('Ravi Kumar');
  await grantRole(admin, 'ADMIN');
  await grantRole(moderator, 'MODERATOR');
});

afterAll(async () => {
  await db.close();
});

// callDb runs as in production (arguments and results checked against src/lib/dbFunctions.ts);
// only its transport is swapped, so the app_* functions run in PGlite instead of through supabase-js.
beforeEach(() => {
  vi.spyOn(dbTransport, 'rpc').mockImplementation((fn, args) =>
    callFunction(db, fn, args, (code, message) => new DatabaseError(code, message)),
  );
  vi.spyOn(filesStorage, 'exists').mockResolvedValue(true);
});

// ---------------------------------------------------------------------------------------------

describe('staff roles', () => {
  it('lists the roles of active staff only', async () => {
    expect(await callDb('app_staff_roles', { p_user_id: admin.id })).toEqual(['ADMIN']);
    expect(await callDb('app_staff_roles', { p_user_id: asha.id })).toEqual([]);
  });

  it('replaces roles, audits the change and refuses changing your own', async () => {
    const staff = await account('Sunil Support');
    const result = await setRoles(admin.member, staff.publicId, ['SUPPORT', 'ANALYST'], CTX);
    expect(result.roles).toEqual(['ANALYST', 'SUPPORT']);
    expect(result.permissions).toContain('kyc.review');

    await setRoles(admin.member, staff.publicId, ['SUPPORT'], CTX);
    expect(await callDb('app_staff_roles', { p_user_id: staff.id })).toEqual(['SUPPORT']);
    const [first, second] = await auditEntries('admin.user.roles_changed');
    expect(first).toMatchObject({
      actor_user_id: admin.id,
      metadata: { from: [], to: ['ANALYST', 'SUPPORT'] },
    });
    expect(second?.metadata).toMatchObject({ to: ['SUPPORT'] });

    await expect(setRoles(admin.member, admin.publicId, [], CTX)).rejects.toMatchObject({
      status: 409,
      code: 'SELF_ACTION',
    });
  });

  it('suspending a staff member ends their staff access and sessions at once', async () => {
    const staff = await account('Temp Moderator');
    await grantRole(staff, 'MODERATOR');
    await db.query(
      `insert into app.user_sessions (public_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
       values ($1, $2, $3, now() + interval '1 day', now() + interval '1 day')`,
      [randomUUID(), staff.id, `hash:${randomUUID()}`],
    );

    const user = await updateUser(
      admin.member,
      staff.publicId,
      { status: 'SUSPENDED', reason: 'Left the company' },
      CTX,
    );

    expect(user.status).toBe('SUSPENDED');
    expect(await callDb('app_staff_roles', { p_user_id: staff.id })).toEqual([]);
    expect(
      await one(`select revoked_reason from app.user_sessions where user_id = $1`, [staff.id]),
    ).toEqual({
      revoked_reason: 'ADMIN',
    });
    expect((await auditEntries('admin.user.suspended')).at(-1)?.metadata).toMatchObject({
      user: staff.publicId,
      reason: 'Left the company',
    });
  });
});

describe('users', () => {
  it('finds members by exact email, phone (with or without the country code) or part of a name', async () => {
    for (const q of [
      'asha@example.com',
      'ASHA@example.com',
      '+919876543210',
      '9876543210',
      'sha r',
    ]) {
      const { items } = await listUsers({ ...PAGE, q });
      expect(
        items.map((u) => u.id),
        q,
      ).toEqual([asha.publicId]);
    }
    const staff = await listUsers({ ...PAGE, filter: { staff: true } });
    expect(staff.items.map((u) => u.id)).toEqual(
      expect.arrayContaining([admin.publicId, moderator.publicId]),
    );
    expect(staff.items.map((u) => u.id)).not.toContain(asha.publicId);
  });

  it('shows one account with decrypted contact details and records the view', async () => {
    const user = await getUser(admin.member, asha.publicId, CTX);
    expect(user).toMatchObject({
      id: asha.publicId,
      name: 'Asha Rao',
      email: 'asha@example.com',
      phone: '+919876543210',
      roles: [],
      activity: { reviews: 0, ratings: 0, signatures: 0 },
    });
    expect(user).not.toHaveProperty('emailEnc');
    expect((await auditEntries('admin.user.viewed')).at(-1)).toMatchObject({
      actor_user_id: admin.id,
      metadata: { user: asha.publicId },
    });
  });

  it('changes the tier with history and an inbox message', async () => {
    const member = await account('Tier Member');
    await db.query(`update app.users set requested_tier = 'PRIVE' where id = $1`, [member.id]);

    const user = await updateUser(
      admin.member,
      member.publicId,
      { tier: 'PRIVE', reason: 'Verified offline' },
      CTX,
    );

    expect(user).toMatchObject({ tier: 'PRIVE' });
    expect(await one(`select requested_tier from app.users where id = $1`, [member.id])).toEqual({
      requested_tier: null,
    });
    expect(
      await one(`select from_tier, to_tier, reason from app.tier_history where user_id = $1`, [
        member.id,
      ]),
    ).toEqual({
      from_tier: 'OBSERVER',
      to_tier: 'PRIVE',
      reason: 'ADMIN_CHANGED',
    });
    expect(await notifications(member, 'SYSTEM')).toHaveLength(1);
  });

  it('refuses unknown users and changes to your own account', async () => {
    await expect(
      updateUser(admin.member, randomUUID(), { tier: 'PRIVE', reason: 'n/a n/a' }, CTX),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updateUser(
        admin.member,
        admin.publicId,
        { status: 'SUSPENDED', reason: 'testing self' },
        CTX,
      ),
    ).rejects.toMatchObject({
      code: 'SELF_ACTION',
    });
  });
});

describe('KYC decisions', () => {
  async function submitKyc(user: TestAccount, tier: 'PRIVE' | 'INSTITUTIONAL') {
    await db.query(`update app.users set requested_tier = $2 where id = $1`, [user.id, tier]);
    const file = await callDb('app_create_file', {
      p_owner_id: user.id,
      p_purpose: 'KYC_DOCUMENT',
      p_bucket: 'kyc-documents',
      p_object_key: `${user.publicId}/${randomUUID()}.pdf`,
      p_mime_type: 'application/pdf',
      p_size_bytes: 2048,
    });
    return callDb('app_kyc_submit', {
      p_user_id: user.id,
      p_tier: tier,
      p_documents: [{ fileId: file.id, documentType: 'ID_PROOF' }],
      p_consent_version: '2026-10',
      p_ctx: CTX,
    });
  }

  it('queues pending submissions and shows one with its documents', async () => {
    const member = await account('Queue Member');
    const id = await submitKyc(member, 'PRIVE');

    const { items } = await listKycSubmissions({ ...PAGE, sort: 'oldest' });
    expect(items.find((s) => s.id === id)).toMatchObject({
      status: 'PENDING',
      tier: 'PRIVE',
      documentCount: 1,
    });

    const submission = await getKycSubmission(admin.member, id, CTX);
    expect(submission).toMatchObject({
      user: { id: member.publicId, requestedTier: 'PRIVE' },
      consent: { version: '2026-10' },
      documents: [
        {
          documentType: 'ID_PROOF',
          scanStatus: 'PENDING',
          download: { url: 'https://signed.example/file' },
        },
      ],
    });
    expect((await auditEntries('admin.kyc.viewed')).at(-1)?.metadata).toEqual({
      submission: id,
      user: member.publicId,
    });
  });

  it('approval grants the submitted tier, tells the member and can happen once', async () => {
    const member = await account('Approve Member');
    const id = await submitKyc(member, 'PRIVE');

    const result = await decideKyc(admin.member, id, { decision: 'APPROVE' }, CTX);

    expect(result).toMatchObject({
      status: 'APPROVED',
      user: { tier: 'PRIVE', kycStatus: 'APPROVED' },
    });
    expect(
      await one(`select tier, kyc_status, requested_tier from app.users where id = $1`, [
        member.id,
      ]),
    ).toEqual({
      tier: 'PRIVE',
      kyc_status: 'APPROVED',
      requested_tier: null,
    });
    expect(
      await one(
        `select reviewer_id::text, reviewed_at is not null as reviewed from app.kyc_submissions where public_id = $1`,
        [id],
      ),
    ).toEqual({
      reviewer_id: admin.id,
      reviewed: true,
    });
    expect(await notifications(member, 'KYC')).toEqual([
      expect.objectContaining({
        title: 'Verification approved',
        data: { kycSubmissionId: id, tier: 'PRIVE' },
      }),
    ]);
    await expect(
      decideKyc(admin.member, id, { decision: 'REJECT', reason: 'Too late now' }, CTX),
    ).rejects.toMatchObject({
      status: 409,
      code: 'KYC_ALREADY_DECIDED',
    });
  });

  it('rejection keeps the requested tier so the member can submit again', async () => {
    const member = await account('Reject Member');
    const id = await submitKyc(member, 'INSTITUTIONAL');

    await decideKyc(
      admin.member,
      id,
      { decision: 'REJECT', reason: 'The ID proof is unreadable' },
      CTX,
    );

    expect(
      await one(`select tier, kyc_status, requested_tier from app.users where id = $1`, [
        member.id,
      ]),
    ).toEqual({
      tier: 'OBSERVER',
      kyc_status: 'REJECTED',
      requested_tier: 'INSTITUTIONAL',
    });
    expect(await callDb('app_kyc_latest', { p_user_id: member.id })).toMatchObject({
      status: 'REJECTED',
      reason: 'The ID proof is unreadable',
    });
    expect((await notifications(member, 'KYC'))[0]?.body).toContain('The ID proof is unreadable');
  });

  it('staff cannot decide their own submission', async () => {
    const id = await submitKyc(moderator, 'PRIVE');
    await expect(
      decideKyc(moderator.member, id, { decision: 'APPROVE' }, CTX),
    ).rejects.toMatchObject({ code: 'SELF_ACTION' });
  });
});

describe('moderation', () => {
  let companyId: string;
  let issuerId: string;
  let roadshowId: string;

  beforeAll(async () => {
    companyId = (await one<{ id: string }>(`select id from public.companies order by slug limit 1`))
      .id;
    issuerId = (await one<{ id: string }>(`select id from public.issuers order by slug limit 1`))
      .id;
    roadshowId = (
      await one<{ id: string }>(
        `insert into public.roadshows (slug, issuer_id, title, type_of_issue, instruments, closes_at, status, published_at)
         values ('admin-test-roadshow', $1, 'Admin Test Roadshow', 'IPO', 'Equity', now() + interval '30 days', 'PUBLISHED', now())
         returning id`,
        [issuerId],
      )
    ).id;
  });

  async function review(author: TestAccount, scheme = randomUUID()) {
    return (
      await one<{ id: string }>(
        `insert into public.reviews (user_id, company_id, author_name, country, asset_class, product_scheme,
           investment_status, sentiment, detailed_review, reinvest_status, m_transparency, m_responsiveness,
           m_ease_of_process, m_trustworthiness, m_overall_satisfaction, resolution_status, declarations_version)
         values ($1, $2, 'Asha Rao', 'IN', 'MF', $3, 'CURRENTLY_INVESTED', 'Positive',
           'Payouts always arrived on time.', 'YES', 4, 4, 4, 4, 5, 'RESOLVED', '2026-10')
         returning id`,
        [author.publicId, companyId, scheme],
      )
    ).id;
  }

  const reviewCount = async () =>
    (
      await one<{ n: number }>(
        `select coalesce((select review_count from public.company_stats where company_id = $1), 0) as n`,
        [companyId],
      )
    ).n;

  it('queues pending items of every type, oldest first, with their content', async () => {
    const reviewId = await review(asha);
    const { items } = await listModerationQueue({ ...PAGE, filter: { type: ['REVIEW'] } });
    const item = items.find((i) => i.id === reviewId);
    expect(item).toMatchObject({
      type: 'REVIEW',
      status: 'PENDING_MODERATION',
      author: { id: asha.publicId, name: 'Asha Rao' },
      subject: { type: 'COMPANY', id: companyId },
      content: {
        sentiment: 'Positive',
        metrics: { overallSatisfaction: 5 },
        tags: [],
        evidence: [],
      },
    });
  });

  it('publishing a review counts it, records who did it and tells the author; removing it un-counts it', async () => {
    const reviewId = await review(asha);
    const before = await reviewCount();

    const result = await decideModeration(
      moderator.member,
      reviewId,
      { type: 'REVIEW', decision: 'APPROVE' },
      CTX,
    );

    expect(result).toEqual({
      type: 'REVIEW',
      id: reviewId,
      decision: 'APPROVE',
      status: 'PUBLISHED',
      previousStatus: 'PENDING_MODERATION',
    });
    expect(await reviewCount()).toBe(before + 1);
    expect(
      await one(`select published_at is not null as published from public.reviews where id = $1`, [
        reviewId,
      ]),
    ).toEqual({ published: true });
    expect(
      await one(
        `select change_type, from_value, to_value, actor_id from public.review_versions where review_id = $1 and change_type = 'PUBLISHED'`,
        [reviewId],
      ),
    ).toEqual({
      change_type: 'PUBLISHED',
      from_value: 'PENDING_MODERATION',
      to_value: 'PUBLISHED',
      actor_id: moderator.publicId,
    });
    expect((await notifications(asha, 'REVIEW')).at(-1)).toMatchObject({
      title: 'Your review is live',
      data: { reviewId },
    });

    await decideModeration(
      moderator.member,
      reviewId,
      { type: 'REVIEW', decision: 'REMOVE', note: 'Defamatory claim' },
      CTX,
    );
    expect(await reviewCount()).toBe(before);
    expect(
      await one(`select status, moderation_note from public.reviews where id = $1`, [reviewId]),
    ).toEqual({
      status: 'REMOVED',
      moderation_note: 'Defamatory claim',
    });
    expect((await notifications(asha, 'REVIEW')).at(-1)?.body).toContain(
      'Note from GIG: Defamatory claim',
    );
  });

  it('refuses decisions that do not fit the current status, and moderating your own content', async () => {
    const reviewId = await review(asha);
    await expect(
      decideModeration(
        moderator.member,
        reviewId,
        { type: 'REVIEW', decision: 'REMOVE', note: 'x' },
        CTX,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });

    const own = await review(moderator);
    await expect(
      decideModeration(moderator.member, own, { type: 'REVIEW', decision: 'APPROVE' }, CTX),
    ).rejects.toMatchObject({
      code: 'SELF_ACTION',
    });
    await expect(
      decideModeration(
        moderator.member,
        randomUUID(),
        { type: 'RATING', decision: 'APPROVE' },
        CTX,
      ),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('requesting changes sends the review back; it can then be approved', async () => {
    const reviewId = await review(asha);
    await decideModeration(
      moderator.member,
      reviewId,
      { type: 'REVIEW', decision: 'REQUEST_CHANGES', note: 'Add evidence' },
      CTX,
    );
    expect(
      (await one<{ status: string }>(`select status from public.reviews where id = $1`, [reviewId]))
        .status,
    ).toBe('CHANGES_REQUESTED');
    await decideModeration(
      moderator.member,
      reviewId,
      { type: 'REVIEW', decision: 'APPROVE' },
      CTX,
    );
    expect(
      (await one<{ status: string }>(`select status from public.reviews where id = $1`, [reviewId]))
        .status,
    ).toBe('PUBLISHED');
  });

  it('publishing a rating counts it in the issuer stats', async () => {
    const { public_id: ratingId } = await one<{ public_id: string }>(
      `insert into app.issuer_ratings (issuer_id, user_id, overall_score) values ($1, $2, 4) returning public_id`,
      [issuerId, asha.id],
    );
    const { items } = await listModerationQueue({ ...PAGE, filter: { type: ['RATING'] } });
    expect(items.find((i) => i.id === ratingId)).toMatchObject({
      type: 'RATING',
      content: { overallScore: 4 },
    });

    await decideModeration(
      moderator.member,
      ratingId,
      { type: 'RATING', decision: 'APPROVE' },
      CTX,
    );

    expect(
      await one(`select rating_count from app.issuer_stats where issuer_id = $1`, [issuerId]),
    ).toEqual({ rating_count: 1 });
    expect(await notifications(asha, 'RATING')).toHaveLength(1);
  });

  it('approves roadshow questions and offers; a takedown rejects them', async () => {
    const { id: questionId } = await one<{ id: string }>(
      `insert into public.roadshow_questions (roadshow_id, user_id, question) values ($1, $2, 'What is the lock-in period?') returning id`,
      [roadshowId, asha.publicId],
    );
    const { id: offerId } = await one<{ id: string }>(
      `insert into public.roadshow_offers (roadshow_id, user_id, currency, offer_price) values ($1, $2, 'INR', 101.5) returning id`,
      [roadshowId, ravi.publicId],
    );
    const pending = await listModerationQueue({ ...PAGE, filter: { type: ['QUESTION', 'OFFER'] } });
    expect(pending.items.map((i) => i.id)).toEqual(expect.arrayContaining([questionId, offerId]));

    await decideModeration(
      moderator.member,
      questionId,
      { type: 'QUESTION', decision: 'APPROVE' },
      CTX,
    );
    await decideModeration(moderator.member, offerId, { type: 'OFFER', decision: 'APPROVE' }, CTX);
    const removed = await decideModeration(
      moderator.member,
      offerId,
      { type: 'OFFER', decision: 'REMOVE', note: 'Terms withdrawn' },
      CTX,
    );

    expect(removed.status).toBe('REJECTED');
    expect(
      await one(`select status from public.roadshow_questions where id = $1`, [questionId]),
    ).toEqual({ status: 'PUBLISHED' });
    expect((await notifications(ravi, 'ROADSHOW')).map((n) => n.title)).toEqual([
      'Your offer is live',
      'Your offer was removed',
    ]);
    const after = await listModerationQueue({ ...PAGE, filter: { type: ['QUESTION', 'OFFER'] } });
    expect(after.items.map((i) => i.id)).not.toEqual(expect.arrayContaining([questionId]));
  });

  it('answering a question publishes it and tells the asker once; rejected questions stay unanswered', async () => {
    const { id: questionId } = await one<{ id: string }>(
      `insert into public.roadshow_questions (roadshow_id, user_id, question) values ($1, $2, 'How will the funds be used?') returning id`,
      [roadshowId, ravi.publicId],
    );

    const answered = await answerQuestion(
      moderator.member,
      roadshowId,
      questionId,
      { answer: 'Capex and debt repayment.', featured: true },
      CTX,
    );
    await answerQuestion(
      moderator.member,
      roadshowId,
      questionId,
      { answer: 'Capex (60%) and debt repayment (40%).' },
      CTX,
    );

    expect(answered).toMatchObject({
      status: 'PUBLISHED',
      featured: true,
      answer: 'Capex and debt repayment.',
    });
    expect(
      await one(`select answer, featured from public.roadshow_questions where id = $1`, [
        questionId,
      ]),
    ).toEqual({
      answer: 'Capex (60%) and debt repayment (40%).',
      featured: true,
    });
    expect(
      (await notifications(ravi, 'ROADSHOW')).filter(
        (n) => n.title === 'Your question was answered',
      ),
    ).toHaveLength(1);

    const { id: rejected } = await one<{ id: string }>(
      `insert into public.roadshow_questions (roadshow_id, user_id, question, status) values ($1, $2, 'Spam spam spam spam', 'REJECTED') returning id`,
      [roadshowId, ravi.publicId],
    );
    await expect(
      answerQuestion(moderator.member, roadshowId, rejected, { answer: 'No' }, CTX),
    ).rejects.toMatchObject({
      code: 'QUESTION_REJECTED',
    });
    await expect(
      answerQuestion(moderator.member, randomUUID(), questionId, { answer: 'No' }, CTX),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('representations', () => {
  const doc = (title: string) => ({
    title,
    documentType: 'SUBMISSION_PACK' as const,
    path: `staff/${randomUUID()}.pdf`,
    mimeType: 'application/pdf' as const,
    sizeBytes: 4096,
  });

  async function sign(representationId: string, signer: TestAccount) {
    const file = await callDb('app_create_file', {
      p_owner_id: signer.id,
      p_purpose: 'SIGNATURE',
      p_bucket: 'signatures',
      p_object_key: `${signer.publicId}/${randomUUID()}.png`,
      p_mime_type: 'image/png',
      p_size_bytes: 512,
    });
    const code = `GIG-${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}`;
    return (
      await one<{ public_id: string }>(
        `insert into app.representation_signatures (signature_code, representation_id, user_id, display_mode,
           signer_name, signature_file_id, signer_tier, weight, consent_version)
         select $1, r.id, $2, 'INITIALS', 'Asha Rao', $3, 'PRIVE', 1, '2026-10'
         from app.representations r where r.public_id = $4
         returning public_id`,
        [code, signer.id, file.id, representationId],
      )
    ).public_id;
  }

  const create = (overrides: Record<string, unknown> = {}) =>
    representations.createRepresentation(
      admin.member,
      {
        title: 'Faster mutual fund redemptions',
        description: 'T+1 redemption for all open-ended funds.',
        asks: ['T+1 settlement'],
        whyItMatters: '',
        category: 'Mutual Funds',
        country: 'IN',
        tags: ['redemption'],
        regulators: ['SEBI'],
        goal: 100,
        closesAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        ...overrides,
      },
      CTX,
    );

  it('creates a petition with a slug from its title and validates the signing window', async () => {
    const petition = await create();
    expect(petition).toMatchObject({
      slug: 'faster-mutual-fund-redemptions',
      trackStatus: 'OPEN',
      effectiveStatus: 'OPEN',
      isOpenForSigning: true,
      history: [{ toStatus: 'OPEN' }],
    });

    await expect(create()).rejects.toMatchObject({ status: 409, code: 'SLUG_TAKEN' });
    await expect(
      representations.updateRepresentation(
        admin.member,
        petition.id,
        { closesAt: '2020-01-01T00:00:00Z' },
        CTX,
      ),
    ).rejects.toMatchObject({ status: 400, fields: { closesAt: expect.any(String) } });

    const updated = await representations.updateRepresentation(
      admin.member,
      petition.id,
      { goal: 250, category: null },
      CTX,
    );
    expect(updated).toMatchObject({
      goal: 250,
      category: null,
      title: 'Faster mutual fund redemptions',
    });
  });

  it('advances the track forward only, with note, actor and documents, and tells every signer', async () => {
    const petition = await create({ slug: 'track-forward' });
    await sign(petition.id, asha);

    const pack = doc('Submission pack');
    const result = await representations.changeRepresentationStatus(
      moderator.member,
      petition.id,
      { status: 'SUBMITTED_TO_REGULATOR', note: 'Filed with SEBI', documents: [pack] },
      CTX,
    );

    expect(result).toMatchObject({
      trackStatus: 'SUBMITTED_TO_REGULATOR',
      previousStatus: 'OPEN',
      documents: [
        {
          title: 'Submission pack',
          documentType: 'SUBMISSION_PACK',
          objectKey: pack.path,
          statusHistoryId: expect.any(Number),
        },
      ],
    });
    const detail = await representations.getRepresentation(petition.id);
    expect(detail.isOpenForSigning).toBe(false);
    expect(detail.history.at(-1)).toMatchObject({
      fromStatus: 'OPEN',
      toStatus: 'SUBMITTED_TO_REGULATOR',
      note: 'Filed with SEBI',
      actor: { id: moderator.publicId },
    });
    expect(detail.documents[0]?.statusHistoryId).toBe(detail.history.at(-1)?.id);
    expect((await notifications(asha, 'REPRESENTATION')).at(-1)).toMatchObject({
      title: 'Petition update',
      data: { representationId: petition.id, trackStatus: 'SUBMITTED_TO_REGULATOR' },
    });

    await expect(
      representations.changeRepresentationStatus(
        moderator.member,
        petition.id,
        { status: 'UNDER_REVIEW', documents: [] },
        CTX,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
  });

  it('refuses documents that were never uploaded', async () => {
    const petition = await create({ slug: 'missing-upload' });
    vi.spyOn(filesStorage, 'exists').mockResolvedValue(false);
    await expect(
      representations.addRepresentationDocuments(
        moderator.member,
        petition.id,
        [doc('Evidence')],
        CTX,
      ),
    ).rejects.toMatchObject({
      status: 400,
      fields: { 'documents.0.path': 'File has not been uploaded yet' },
    });
  });

  it('lists signers with their identity and removes a signature so it stops counting', async () => {
    const petition = await create({ slug: 'remove-signature' });
    const signature = await sign(petition.id, ravi);
    expect((await representations.getRepresentation(petition.id)).signatureCount).toBe(1);

    const { items } = await representations.listSignatures(petition.id, {
      ...PAGE,
      includeRemoved: false,
    });
    expect(items).toEqual([
      expect.objectContaining({
        id: signature,
        status: 'VALID',
        user: expect.objectContaining({ id: ravi.publicId }),
      }),
    ]);

    await representations.removeSignature(
      moderator.member,
      petition.id,
      signature,
      'Duplicate account',
      CTX,
    );

    expect((await representations.getRepresentation(petition.id)).signatureCount).toBe(0);
    expect(
      (await representations.listSignatures(petition.id, { ...PAGE, includeRemoved: false })).items,
    ).toEqual([]);
    expect((await notifications(ravi, 'REPRESENTATION')).at(-1)?.body).toContain(
      'Duplicate account',
    );
    await expect(
      representations.removeSignature(
        moderator.member,
        petition.id,
        signature,
        'Again please',
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_REMOVED' });
  });

  it('soft-deletes a petition: hidden from the default list, still readable, deleted once', async () => {
    const petition = await create({ slug: 'to-delete' });
    await representations.deleteRepresentation(admin.member, petition.id, CTX);

    expect((await representations.getRepresentation(petition.id)).deletedAt).toBeInstanceOf(Date);
    const active = await representations.listRepresentations({ ...PAGE, state: 'ACTIVE' });
    const all = await representations.listRepresentations({
      ...PAGE,
      state: 'ALL',
      q: 'to-delete',
    });
    expect(active.items.map((r) => r.id)).not.toContain(petition.id);
    expect(all.items.map((r) => r.id)).toContain(petition.id);
    await expect(
      representations.deleteRepresentation(admin.member, petition.id, CTX),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('credits', () => {
  const balance = async (user: TestAccount) =>
    (
      await one<{ credit_balance: number }>(`select credit_balance from app.users where id = $1`, [
        user.id,
      ])
    ).credit_balance;

  it('grants credits once per Idempotency-Key, and tells the member', async () => {
    const member = await account('Credit Member');
    const body = { userId: member.publicId, delta: 5, note: 'Launch credits' };

    const first = await changeCredits(admin.member, body, 'grant-key-0001', CTX);
    const retry = await changeCredits(admin.member, body, 'grant-key-0001', CTX);

    expect(first).toMatchObject({
      replayed: false,
      entry: { delta: 5, balanceAfter: 5, reason: 'ADMIN_GRANT', note: 'Launch credits' },
    });
    expect(retry).toEqual({ ...first, replayed: true });
    expect(await balance(member)).toBe(5);
    expect(await notifications(member, 'CREDITS')).toHaveLength(1);
    expect((await auditEntries('admin.credits.granted')).at(-1)).toMatchObject({
      actor_user_id: admin.id,
      metadata: { user: member.publicId, delta: 5, balanceAfter: 5 },
    });

    await expect(
      changeCredits(admin.member, { ...body, delta: 6 }, 'grant-key-0001', CTX),
    ).rejects.toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('revokes credits but never below zero', async () => {
    const member = await account('Revoke Member');
    await changeCredits(
      admin.member,
      { userId: member.publicId, delta: 3, note: 'Grant' },
      'revoke-key-001',
      CTX,
    );

    await expect(
      changeCredits(
        admin.member,
        { userId: member.publicId, delta: -4, note: 'Too many' },
        'revoke-key-002',
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    const revoked = await changeCredits(
      admin.member,
      { userId: member.publicId, delta: -2, note: 'Correction' },
      'revoke-key-003',
      CTX,
    );

    expect(revoked.entry).toMatchObject({ delta: -2, balanceAfter: 1, reason: 'ADMIN_REVOKE' });
    expect(await balance(member)).toBe(1);
  });

  it('refuses unknown members and granting yourself credits', async () => {
    await expect(
      changeCredits(
        admin.member,
        { userId: randomUUID(), delta: 1, note: 'n/a' },
        'unknown-key-01',
        CTX,
      ),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      changeCredits(
        admin.member,
        { userId: admin.publicId, delta: 1, note: 'Me' },
        'self-key-0001',
        CTX,
      ),
    ).rejects.toMatchObject({
      code: 'SELF_ACTION',
    });
  });
});

describe('audit trail', () => {
  it('filters by action prefix and actor, newest first, naming the actor', async () => {
    const member = await account('Audit Member');
    await changeCredits(
      admin.member,
      { userId: member.publicId, delta: 1, note: 'One' },
      'audit-key-0001',
      CTX,
    );
    await changeCredits(
      admin.member,
      { userId: member.publicId, delta: 2, note: 'Two' },
      'audit-key-0002',
      CTX,
    );

    const { items, meta } = await listAuditLogs({
      ...PAGE,
      filter: { actionPrefix: 'admin.credits.', actorId: admin.publicId },
    });

    expect(meta.total).toBeGreaterThanOrEqual(2);
    expect(items.every((e) => e.action.startsWith('admin.credits.'))).toBe(true);
    expect(items[0]).toMatchObject({
      action: 'admin.credits.granted',
      actor: { id: admin.publicId, name: 'Grace Admin' },
      ip: '10.0.0.9',
      requestId: 'req-admin',
      metadata: { delta: 2 },
    });

    const none = await listAuditLogs({
      ...PAGE,
      filter: { actionPrefix: 'admin.credits.', actorId: moderator.publicId },
    });
    expect(none.items).toEqual([]);
  });
});
