// Admin against the real migrations and seed: the API's admin repository runs against PGlite,
// calling the same app_admin_* database functions it calls through supabase-js.

import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { callDb, isUniqueViolationOf } from '../../src/lib/db';
import type { ClientContext } from '../../src/middleware/requestContext';
import { adminRepository, isDbError } from '../../src/modules/admin/admin.repository';
import type { RepresentationDocumentType } from '../../src/types/domain';
import { createTestDatabase, createUser, dbError } from './pglite';

const holder = vi.hoisted(() => ({ db: undefined as PGlite | undefined }));

// callDb runs the app_* database functions directly in PGlite, as supabase-js does in production.
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

const ADMIN = 'adadadad-0000-4000-8000-0000000000a1';
const MOD = 'adadadad-0000-4000-8000-0000000000b2';
const ALICE = 'adadadad-0000-4000-8000-0000000000c3';
const BOB = 'adadadad-0000-4000-8000-0000000000d4';

const CTX: ClientContext = {
  ip: '10.0.0.9',
  userAgent: 'vitest',
  appVersion: 'admin-1',
  requestId: 'req-admin',
};
const PAGE = { page: 1, pageSize: 20 };

let db: PGlite;
let admin: string;
let mod: string;
let alice: string;
let bob: string;

async function rows<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  return (await db.query<T>(query, params)).rows;
}

async function one<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  const [row] = await rows<T>(query, params);
  if (!row) throw new Error(`no row for: ${query}`);
  return row;
}

async function makeUser(publicId: string, name: string): Promise<string> {
  const id = await createUser(db, publicId);
  await db.query('insert into app.user_profiles (user_id, name) values ($1, $2)', [id, name]);
  return id;
}

async function lastAudit(action: string) {
  return one<{ actor_user_id: string; metadata: Record<string, unknown>; request_id: string }>(
    `select actor_user_id::text, metadata, request_id from app.audit_logs
     where action = $1 order by id desc limit 1`,
    [action],
  );
}

/** A value from a { error } result, failing the test otherwise. */
function ok<T extends object>(result: T): Exclude<T, { error: string }> {
  if (isDbError(result)) throw new Error(`unexpected error ${JSON.stringify(result)}`);
  return result as Exclude<T, { error: string }>;
}

beforeAll(async () => {
  db = await createTestDatabase();
  holder.db = db;
  admin = await makeUser(ADMIN, 'Gita Admin');
  mod = await makeUser(MOD, 'Manoj Moderator');
  alice = await makeUser(ALICE, 'Alice Investor');
  bob = await makeUser(BOB, 'Bob Investor');
  // The first ADMIN is created in SQL (see README); everyone else through the API.
  await db.query(`insert into app.user_roles (user_id, role) values ($1, 'ADMIN')`, [admin]);
});

afterAll(async () => {
  await db?.close();
});

describe('staff roles', () => {
  it('returns the roles of active staff and nothing for everyone else', async () => {
    expect(await adminRepository.staffRoles(admin)).toEqual(['ADMIN']);
    expect(await adminRepository.staffRoles(alice)).toEqual([]);
  });

  it('sets roles, audits the change, and refuses to drop the last or your own ADMIN', async () => {
    expect(ok(await adminRepository.setRoles(admin, MOD, ['MODERATOR', 'SUPPORT'], CTX))).toEqual({
      roles: ['MODERATOR', 'SUPPORT'],
    });
    expect(await adminRepository.staffRoles(mod)).toEqual(['MODERATOR', 'SUPPORT']);
    expect((await lastAudit('admin.user.roles_updated')).metadata).toMatchObject({
      user: MOD,
      from: [],
      to: ['MODERATOR', 'SUPPORT'],
    });

    expect(await adminRepository.setRoles(admin, ADMIN, ['SUPPORT'], CTX)).toEqual({
      error: 'SELF_CHANGE',
    });
    // Only reachable for a caller who is not ADMIN; the API never lets one through, the database checks anyway.
    expect(await adminRepository.setRoles(mod, ADMIN, [], CTX)).toEqual({ error: 'LAST_ADMIN' });
    expect(await adminRepository.setRoles(admin, randomUUID(), [], CTX)).toEqual({
      error: 'NOT_FOUND',
    });
    expect(await adminRepository.staffRoles(admin)).toEqual(['ADMIN']);
  });

  it('gives a suspended staff member no roles', async () => {
    await db.query(`update app.users set status = 'SUSPENDED' where id = $1`, [mod]);
    expect(await adminRepository.staffRoles(mod)).toEqual([]);
    await db.query(`update app.users set status = 'ACTIVE' where id = $1`, [mod]);
  });
});

describe('users', () => {
  it('searches by name, email hash, public id, tier and role', async () => {
    const byName = await adminRepository.findUsers(
      { namePattern: '%investor%' },
      { ...PAGE, sort: 'name' },
    );
    expect(byName.items.map((u) => u.id)).toEqual([ALICE, BOB]);
    expect(byName.total).toBe(2);

    // createUser stores the public id as the email and phone hash.
    const byEmail = await adminRepository.findUsers(
      { emailHash: BOB },
      { ...PAGE, sort: '-createdAt' },
    );
    expect(byEmail.items).toEqual([
      expect.objectContaining({ id: BOB, name: 'Bob Investor', roles: [] }),
    ]);

    const byId = await adminRepository.findUsers(
      { publicId: ALICE },
      { ...PAGE, sort: '-createdAt' },
    );
    expect(byId.items.map((u) => u.id)).toEqual([ALICE]);

    const staff = await adminRepository.findUsers(
      {},
      { ...PAGE, sort: '-createdAt', filter: { role: ['ADMIN'] } },
    );
    expect(staff.items.map((u) => u.id)).toEqual([ADMIN]);
  });

  it('returns the full detail of one user', async () => {
    const user = await adminRepository.findUser(ALICE);
    expect(user).toMatchObject({
      id: alice,
      publicId: ALICE,
      name: 'Alice Investor',
      tier: 'OBSERVER',
      status: 'ACTIVE',
      creditBalance: 0,
      roles: [],
      activity: { reviews: 0, ratings: 0, signatures: 0, followers: 0, following: 0 },
      kycSubmissions: [],
      tierHistory: [],
    });
    expect(await adminRepository.findUser(randomUUID())).toBeNull();
  });

  it('suspends a user, signs them out everywhere, and reactivates them', async () => {
    await db.query(
      `insert into app.user_sessions (public_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
       values ($1, $2, 'h-bob', now() + interval '1 day', now() + interval '2 days')`,
      [randomUUID(), bob],
    );

    expect(
      await adminRepository.updateUser(admin, BOB, { status: 'SUSPENDED' }, 'Spam reviews', CTX),
    ).toEqual({ ok: true });
    expect(await one(`select status from app.users where id = $1`, [bob])).toEqual({
      status: 'SUSPENDED',
    });
    expect(
      await one(`select revoked_reason from app.user_sessions where user_id = $1`, [bob]),
    ).toEqual({
      revoked_reason: 'ADMIN',
    });
    expect(await lastAudit('admin.user.updated')).toMatchObject({
      actor_user_id: admin,
      request_id: 'req-admin',
      metadata: {
        user: BOB,
        reason: 'Spam reviews',
        changes: { status: { from: 'ACTIVE', to: 'SUSPENDED' } },
      },
    });

    await adminRepository.updateUser(admin, BOB, { status: 'ACTIVE' }, 'Appeal accepted', CTX);
    expect(await one(`select status from app.users where id = $1`, [bob])).toEqual({
      status: 'ACTIVE',
    });
  });

  it('refuses a verified tier without approved KYC, and staff changing their own status', async () => {
    expect(await adminRepository.updateUser(admin, BOB, { tier: 'PRIVE' }, 'Upgrade', CTX)).toEqual(
      {
        error: 'KYC_NOT_APPROVED',
      },
    );
    expect(
      await adminRepository.updateUser(admin, ADMIN, { status: 'SUSPENDED' }, 'Oops', CTX),
    ).toEqual({
      error: 'SELF_CHANGE',
    });
    expect(
      await adminRepository.updateUser(admin, randomUUID(), { status: 'ACTIVE' }, 'x', CTX),
    ).toEqual({
      error: 'NOT_FOUND',
    });
  });
});

describe('KYC', () => {
  /** Requests a tier for the user and submits one uploaded document, as the KYC module does. */
  async function submitKyc(
    userId: string,
    tier: 'PRIVE' | 'INSTITUTIONAL',
    scan = 'CLEAN',
  ): Promise<string> {
    await db.query(
      `update app.users set requested_tier = $2, kyc_status = 'NOT_STARTED' where id = $1`,
      [userId, tier],
    );
    const file = await callDb<{ id: string }>('app_create_file', {
      p_owner_id: userId,
      p_purpose: 'KYC_DOCUMENT',
      p_bucket: 'kyc-documents',
      p_object_key: `${userId}/${randomUUID()}.pdf`,
      p_mime_type: 'application/pdf',
      p_size_bytes: 2048,
    });
    await db.query(`update app.files set scan_status = $2 where id = $1`, [file.id, scan]);
    return callDb('app_kyc_submit', {
      p_user_id: userId,
      p_tier: tier,
      p_documents: [{ fileId: file.id, documentType: 'ID_PROOF' }],
      p_consent_version: '2026-10',
      p_ctx: CTX,
    });
  }

  it('lists the pending queue and shows a submission with its documents and consent', async () => {
    const id = await submitKyc(alice, 'PRIVE');

    const queue = await adminRepository.findKyc(PAGE);
    expect(queue.items).toEqual([
      expect.objectContaining({
        id,
        tier: 'PRIVE',
        status: 'PENDING',
        documentCount: 1,
        user: expect.objectContaining({ id: ALICE, name: 'Alice Investor', kycStatus: 'PENDING' }),
      }),
    ]);

    const detail = await adminRepository.findKycSubmission(id);
    expect(detail).toMatchObject({
      id,
      status: 'PENDING',
      reviewer: null,
      consent: { version: '2026-10' },
      user: { id: ALICE, requestedTier: 'PRIVE' },
      documents: [
        expect.objectContaining({
          documentType: 'ID_PROOF',
          bucket: 'kyc-documents',
          scanStatus: 'CLEAN',
        }),
      ],
    });
  });

  it('approves: grants the tier, clears the request, records the history and audits', async () => {
    const [pending] = (await adminRepository.findKyc(PAGE)).items;

    expect(await adminRepository.decideKyc(mod, pending!.id, 'APPROVE', null, CTX)).toEqual({
      status: 'APPROVED',
      tier: 'PRIVE',
      kycStatus: 'APPROVED',
    });
    expect(
      await one(`select tier, requested_tier, kyc_status from app.users where id = $1`, [alice]),
    ).toEqual({
      tier: 'PRIVE',
      requested_tier: null,
      kyc_status: 'APPROVED',
    });
    expect(
      await one(`select reason from app.tier_history where user_id = $1 order by id desc limit 1`, [
        alice,
      ]),
    ).toEqual({
      reason: 'KYC_APPROVED',
    });
    expect((await adminRepository.findKycSubmission(pending!.id))?.reviewer).toEqual({
      id: MOD,
      name: 'Manoj Moderator',
    });
    expect((await lastAudit('admin.kyc.approved')).metadata).toMatchObject({
      user: ALICE,
      tier: 'PRIVE',
    });

    expect(await adminRepository.decideKyc(admin, pending!.id, 'REJECT', 'Late', CTX)).toEqual({
      error: 'ALREADY_DECIDED',
      status: 'APPROVED',
    });
  });

  it('rejects with the reason the user sees, keeping their tier', async () => {
    const id = await submitKyc(bob, 'INSTITUTIONAL');

    expect(
      await adminRepository.decideKyc(admin, id, 'REJECT', 'Authorisation letter missing', CTX),
    ).toEqual({
      status: 'REJECTED',
      tier: 'OBSERVER',
      kycStatus: 'REJECTED',
    });
    expect(await callDb('app_kyc_latest', { p_user_id: bob })).toMatchObject({
      status: 'REJECTED',
      reason: 'Authorisation letter missing',
    });
    expect(await one(`select tier, requested_tier from app.users where id = $1`, [bob])).toEqual({
      tier: 'OBSERVER',
      requested_tier: 'INSTITUTIONAL',
    });
  });

  it('refuses your own submission and one with an infected document', async () => {
    const own = await submitKyc(mod, 'PRIVE');
    expect(await adminRepository.decideKyc(mod, own, 'APPROVE', null, CTX)).toEqual({
      error: 'OWN_SUBMISSION',
    });

    const infected = await submitKyc(bob, 'INSTITUTIONAL', 'INFECTED');
    expect(await adminRepository.decideKyc(admin, infected, 'APPROVE', null, CTX)).toEqual({
      error: 'DOCUMENT_INFECTED',
    });
    expect(await adminRepository.decideKyc(admin, randomUUID(), 'APPROVE', null, CTX)).toEqual({
      error: 'NOT_FOUND',
    });
  });
});

describe('moderation', () => {
  let companyId: string;
  let issuerId: string;
  let reviewId: string;
  let ratingId: string;

  beforeAll(async () => {
    ({ id: companyId } = await one<{ id: string }>(
      `select id from public.companies where slug = 'astra-mutuals'`,
    ));
    ({ id: issuerId } = await one<{ id: string }>(
      `select id from public.issuers where slug = 'sovereign-alpha-yield'`,
    ));
    ({ id: reviewId } = await one<{ id: string }>(
      `insert into public.reviews (user_id, company_id, author_name, country, asset_class, investment_status,
         sentiment, detailed_review, reinvest_status, m_transparency, m_responsiveness, m_ease_of_process,
         m_trustworthiness, m_overall_satisfaction, resolution_status, declarations_version)
       values ($1, $2, 'Alice Investor', 'IN', 'MF', 'CURRENTLY_INVESTED', 'Positive',
         'Payouts always arrived on time.', 'YES', 4, 5, 4, 4, 5, 'RESOLVED', '2026-10')
       returning id`,
      [ALICE, companyId],
    ));
    ({ public_id: ratingId } = await one<{ public_id: string }>(
      `insert into app.issuer_ratings (issuer_id, user_id, overall_score) values ($1, $2, 4) returning public_id`,
      [issuerId, alice],
    ));
  });

  it('queues pending reviews and ratings together, oldest first', async () => {
    const queue = await adminRepository.moderationQueue(PAGE);
    expect(queue.items.map((i) => [i.type, i.id])).toEqual([
      ['REVIEW', reviewId],
      ['RATING', ratingId],
    ]);
    expect(queue.items[0]).toMatchObject({
      status: 'PENDING_MODERATION',
      author: { id: ALICE, name: 'Alice Investor', tier: 'PRIVE' },
      subject: { type: 'COMPANY', id: companyId, name: 'Astra Mutuals' },
      summary: {
        sentiment: 'Positive',
        overallScore: 5,
        excerpt: 'Payouts always arrived on time.',
        evidenceCount: 0,
      },
    });

    const ratingsOnly = await adminRepository.moderationQueue({
      ...PAGE,
      filter: { type: ['RATING'] },
    });
    expect(ratingsOnly.items.map((i) => i.id)).toEqual([ratingId]);
  });

  it('shows the full item', async () => {
    expect(await adminRepository.moderationItem('REVIEW', reviewId)).toMatchObject({
      type: 'REVIEW',
      content: { sentiment: 'Positive', metrics: { overallSatisfaction: 5 }, appreciations: [] },
      evidence: [],
    });
    expect(await adminRepository.moderationItem('RATING', ratingId)).toMatchObject({
      type: 'RATING',
      content: { overallScore: 4, factors: [], riskFactors: [] },
    });
    expect(await adminRepository.moderationItem('RATING', reviewId)).toBeNull();
  });

  it('publishes a review: timeline entry by the moderator, company stats recomputed', async () => {
    expect(
      await adminRepository.moderate(mod, reviewId, { type: 'REVIEW', decision: 'APPROVE' }, CTX),
    ).toEqual({
      type: 'REVIEW',
      id: reviewId,
      previousStatus: 'PENDING_MODERATION',
      status: 'PUBLISHED',
    });
    const review = await one<{ status: string; published_at: Date | null }>(
      `select status, published_at from public.reviews where id = $1`,
      [reviewId],
    );
    expect(review.status).toBe('PUBLISHED');
    expect(review.published_at).not.toBeNull();
    expect(
      await one(
        `select change_type, from_value, to_value, actor_id from public.review_versions
                 where review_id = $1 order by id desc limit 1`,
        [reviewId],
      ),
    ).toEqual({
      change_type: 'PUBLISHED',
      from_value: 'PENDING_MODERATION',
      to_value: 'PUBLISHED',
      actor_id: MOD,
    });
    expect(
      await one(`select review_count from public.company_stats where company_id = $1`, [companyId]),
    ).toEqual({
      review_count: 1,
    });
  });

  it('takes a published review down and refuses decisions that do not fit the status', async () => {
    expect(
      await adminRepository.moderate(
        mod,
        reviewId,
        { type: 'REVIEW', decision: 'REQUEST_CHANGES', note: 'Too late' },
        CTX,
      ),
    ).toEqual({ error: 'INVALID_TRANSITION', status: 'PUBLISHED' });

    const removed = await adminRepository.moderate(
      mod,
      reviewId,
      { type: 'REVIEW', decision: 'REMOVE', note: 'Court order' },
      CTX,
    );
    expect(ok(removed).status).toBe('REMOVED');
    expect(
      await one(`select review_count from public.company_stats where company_id = $1`, [companyId]),
    ).toEqual({
      review_count: 0,
    });
    expect((await lastAudit('admin.moderation.decided')).metadata).toMatchObject({
      type: 'REVIEW',
      decision: 'REMOVE',
      from: 'PUBLISHED',
      to: 'REMOVED',
    });
  });

  it('moderates ratings, but never your own content', async () => {
    expect(
      await adminRepository.moderate(alice, ratingId, { type: 'RATING', decision: 'APPROVE' }, CTX),
    ).toEqual({
      error: 'OWN_CONTENT',
    });
    expect(
      await adminRepository.moderate(
        mod,
        ratingId,
        { type: 'RATING', decision: 'REQUEST_CHANGES', note: 'Add risks' },
        CTX,
      ),
    ).toMatchObject({ status: 'CHANGES_REQUESTED' });
    expect(
      await adminRepository.moderate(mod, ratingId, { type: 'RATING', decision: 'APPROVE' }, CTX),
    ).toMatchObject({
      previousStatus: 'CHANGES_REQUESTED',
      status: 'PUBLISHED',
    });
    expect(
      await one(`select rating_count from app.issuer_stats where issuer_id = $1`, [issuerId]),
    ).toEqual({
      rating_count: 1,
    });
    expect(
      await adminRepository.moderate(
        mod,
        randomUUID(),
        { type: 'RATING', decision: 'APPROVE' },
        CTX,
      ),
    ).toEqual({
      error: 'NOT_FOUND',
    });
  });
});

describe('companies and issuers', () => {
  it('creates, updates only the given fields, and soft-deletes a company', async () => {
    const { id } = ok(
      await adminRepository.saveCompany(
        admin,
        null,
        {
          slug: 'orbit-amc',
          name: 'Orbit AMC',
          assetClass: 'MF',
          country: 'AE',
          verified: true,
          tags: ['ETF', 'Debt'],
        },
        CTX,
      ),
    );
    expect(await adminRepository.findCompany(id)).toMatchObject({
      slug: 'orbit-amc',
      country: 'AE',
      logoUrl: null,
      verified: true,
      tags: ['ETF', 'Debt'],
      reviewCount: 0,
      deletedAt: null,
    });

    await adminRepository.saveCompany(
      admin,
      id,
      { name: 'Orbit Asset Management', tags: ['Debt'] },
      CTX,
    );
    expect(await adminRepository.findCompany(id)).toMatchObject({
      name: 'Orbit Asset Management',
      slug: 'orbit-amc',
      verified: true,
      tags: ['Debt'],
    });
    expect((await lastAudit('admin.company.updated')).metadata).toEqual({
      company: id,
      fields: ['name', 'tags'],
    });

    expect(await adminRepository.deleteCompany(admin, id, CTX)).toBe(true);
    expect(await adminRepository.deleteCompany(admin, id, CTX)).toBe(false);
    expect(await adminRepository.saveCompany(admin, id, { name: 'Gone' }, CTX)).toEqual({
      error: 'NOT_FOUND',
    });
    const visible = await adminRepository.findCompanies({ ...PAGE, q: 'orbit' });
    const all = await adminRepository.findCompanies({
      ...PAGE,
      q: 'orbit',
      filter: { deleted: true },
    });
    expect([visible.total, all.total]).toEqual([0, 1]);
  });

  it('raises a named unique violation for a duplicate slug', async () => {
    const error = await dbError(
      adminRepository.saveCompany(
        admin,
        null,
        { slug: 'astra-mutuals', name: 'Copy', assetClass: 'MF', country: 'IN' },
        CTX,
      ),
    );
    expect(isUniqueViolationOf(error, 'companies_slug_key')).toBe(true);
  });

  it('creates and edits issuers; stored values still have to fit the range checks', async () => {
    const { id } = ok(
      await adminRepository.saveIssuer(
        admin,
        null,
        {
          slug: 'delta-green-bonds',
          name: 'Delta Green Bonds',
          instrument: 'Green Bonds',
          assetType: 'Bonds',
          priceMin: 100,
          priceMax: 120,
        },
        CTX,
      ),
    );
    expect(await adminRepository.findIssuer(id)).toMatchObject({
      currency: 'INR',
      lotUnit: 'shares',
      isListed: false,
      priceMin: 100,
      priceMax: 120,
      ratingCount: 0,
    });

    const error = await dbError(adminRepository.saveIssuer(admin, id, { priceMax: 90 }, CTX));
    expect(error).toMatchObject({ code: '23514' });

    await adminRepository.saveIssuer(
      admin,
      id,
      { isListed: true, exchange: 'NSE', tags: ['Green'] },
      CTX,
    );
    expect(await adminRepository.findIssuer(id)).toMatchObject({
      isListed: true,
      exchange: 'NSE',
      tags: ['Green'],
    });
    expect(await adminRepository.deleteIssuer(admin, id, CTX)).toBe(true);
    expect(await callDb('app_find_issuer', { p_id: id })).toBeNull();
  });
});

describe('representations', () => {
  let id: string;
  const doc = (key: string, documentType: RepresentationDocumentType = 'SUBMISSION_PACK') => ({
    objectKey: key,
    title: 'Petition pack',
    documentType,
    mimeType: 'application/pdf' as const,
    sizeBytes: 4096,
  });

  it('creates a petition that starts its timeline and shows in the app', async () => {
    const opensAt = new Date(Date.now() - 86_400_000).toISOString();
    const closesAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    ({ id } = ok(
      await adminRepository.saveRepresentation(
        admin,
        null,
        {
          slug: 'fair-exit-loads',
          title: 'Cap exit loads on debt funds',
          country: 'IN',
          goal: 500,
          asks: ['Cap exit loads at 1%'],
          regulators: ['SEBI'],
          opensAt,
          closesAt,
        },
        CTX,
      ),
    ));

    expect(await adminRepository.findRepresentation(id)).toMatchObject({
      slug: 'fair-exit-loads',
      storedStatus: 'OPEN',
      trackStatus: 'OPEN',
      isPublished: true,
      isOpenForSigning: true,
      asks: ['Cap exit loads at 1%'],
      tags: [],
      documents: [],
      history: [expect.objectContaining({ fromStatus: null, toStatus: 'OPEN', actor: null })],
    });
    expect(await callDb('app_find_representation', { p_id: id })).toMatchObject({
      trackStatus: 'OPEN',
    });
  });

  it('refuses statuses that are not forward steps set by staff, and documents outside the petition folder', async () => {
    const change = (status: string, documents: unknown[] = []) =>
      adminRepository.changeRepresentationStatus(
        admin,
        id,
        { status: status as never, note: null, documents: documents as never },
        CTX,
      );

    expect(await change('CLOSED')).toEqual({ error: 'INVALID_TRANSITION', status: 'OPEN' });
    expect(await change('UNDER_REVIEW', [doc(`${randomUUID()}/${randomUUID()}.pdf`)])).toEqual({
      error: 'DOCUMENT_INVALID',
    });
    expect((await adminRepository.findRepresentation(id))?.storedStatus).toBe('OPEN');
  });

  it('moves the track forward with a note, the staff member and the documents of that step', async () => {
    const key = `${id}/${randomUUID()}.pdf`;
    expect(
      await adminRepository.changeRepresentationStatus(
        admin,
        id,
        { status: 'SUBMITTED_TO_REGULATOR', note: 'Filed with SEBI', documents: [doc(key)] },
        CTX,
      ),
    ).toEqual({ previousStatus: 'OPEN', status: 'SUBMITTED_TO_REGULATOR' });

    const detail = await adminRepository.findRepresentation(id);
    expect(detail).toMatchObject({
      storedStatus: 'SUBMITTED_TO_REGULATOR',
      isOpenForSigning: false,
      documentCount: 1,
    });
    const [document] = detail!.documents;
    expect(document).toMatchObject({
      objectKey: key,
      documentType: 'SUBMISSION_PACK',
      scanStatus: 'PENDING',
    });
    expect(detail!.history.at(-1)).toEqual(
      expect.objectContaining({
        fromStatus: 'OPEN',
        toStatus: 'SUBMITTED_TO_REGULATOR',
        note: 'Filed with SEBI',
        actor: { id: ADMIN, name: 'Gita Admin' },
        documentIds: [document!.id],
      }),
    );
    // The public timeline shows the step with its document.
    const internal = await one<{ id: string }>(
      `select id::text from app.representations where public_id = $1`,
      [id],
    );
    expect(
      await callDb('app_representation_history', { p_representation_id: internal.id }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toStatus: 'SUBMITTED_TO_REGULATOR',
          documents: [expect.anything()],
        }),
      ]),
    );

    expect(
      await adminRepository.changeRepresentationStatus(
        admin,
        id,
        { status: 'UNDER_REVIEW', note: null, documents: [] },
        CTX,
      ),
    ).toEqual({ error: 'INVALID_TRANSITION', status: 'SUBMITTED_TO_REGULATOR' });
  });

  it('attaches evidence outside the track, and never the same file twice', async () => {
    const key = `${id}/${randomUUID()}.png`;
    expect(
      await adminRepository.addRepresentationDocuments(admin, id, [doc(key, 'EVIDENCE')], CTX),
    ).toEqual({ ok: true });
    const internal = await one<{ id: string }>(
      `select id::text from app.representations where public_id = $1`,
      [id],
    );
    expect(
      await callDb('app_representation_evidence', { p_representation_id: internal.id }),
    ).toEqual([expect.objectContaining({ documentType: 'EVIDENCE' })]);

    const error = await dbError(
      adminRepository.addRepresentationDocuments(admin, id, [doc(key, 'EVIDENCE')], CTX),
    );
    expect(isUniqueViolationOf(error, 'representation_documents_object_key_key')).toBe(true);
  });

  it('soft-deletes a petition', async () => {
    expect(await adminRepository.deleteRepresentation(admin, id, CTX)).toBe(true);
    expect(await callDb('app_find_representation', { p_id: id })).toBeNull();
    expect((await adminRepository.findRepresentation(id))?.deletedAt).not.toBeNull();
  });
});

describe('credits', () => {
  const grant = (delta: number, key: string, hash = `hash-${key}`, userId = BOB) =>
    adminRepository.grantCredits(
      admin,
      { userId, delta, reason: 'Welcome bonus', idempotencyKey: key, requestHash: hash },
      CTX,
    );

  it('grants credits once per Idempotency-Key and keeps the ledger append-only', async () => {
    expect(ok(await grant(5, 'grant-key-1'))).toMatchObject({
      replayed: false,
      balance: 5,
      entry: { delta: 5, balanceAfter: 5, refType: 'ADMIN_GRANT', reason: 'Welcome bonus' },
    });
    expect(ok(await grant(5, 'grant-key-1'))).toMatchObject({ replayed: true, balance: 5 });
    expect(await grant(7, 'grant-key-1', 'other-hash')).toEqual({ error: 'IDEMPOTENCY_CONFLICT' });
    expect(
      await one(`select count(*)::int as n from app.credit_ledger where user_id = $1`, [bob]),
    ).toEqual({ n: 1 });

    const error = await dbError(db.query(`update app.credit_ledger set delta = 50`));
    expect(error.message).toContain('append-only');
  });

  it('revokes credits but never below zero, and never for yourself', async () => {
    expect(await grant(-10, 'revoke-key-1')).toEqual({ error: 'INSUFFICIENT_CREDITS', balance: 5 });
    expect(ok(await grant(-2, 'revoke-key-2'))).toMatchObject({
      balance: 3,
      entry: { refType: 'ADMIN_REVOKE' },
    });
    expect(await grant(1, 'self-key-1', 'h', ADMIN)).toEqual({ error: 'SELF_CHANGE' });
    expect(await grant(1, 'missing-key-1', 'h', randomUUID())).toEqual({ error: 'NOT_FOUND' });

    const credits = await adminRepository.userCredits(BOB, PAGE);
    expect(credits).toMatchObject({ balance: 3, total: 2 });
    expect(credits!.items.map((e) => e.delta)).toEqual([-2, 5]);
    expect(credits!.items[0]!.actor).toEqual({ id: ADMIN, name: 'Gita Admin' });
    expect((await lastAudit('admin.credits.granted')).metadata).toMatchObject({
      user: BOB,
      delta: -2,
      balance: 3,
    });
  });
});

describe('audit trail', () => {
  it('filters by action prefix and by the user an entry is by or about, newest first', async () => {
    const kyc = await adminRepository.auditLogs({ ...PAGE, filter: { action: ['admin.kyc.*'] } });
    expect(new Set(kyc.items.map((e) => e.action))).toEqual(
      new Set(['admin.kyc.approved', 'admin.kyc.rejected']),
    );

    const aboutBob = await adminRepository.auditLogs({
      ...PAGE,
      filter: { user: BOB, action: ['admin.user.updated'] },
    });
    expect(aboutBob.items.map((e) => e.metadata.reason)).toEqual([
      'Appeal accepted',
      'Spam reviews',
    ]);
    expect(aboutBob.items[0]).toMatchObject({
      actor: { id: ADMIN, name: 'Gita Admin' },
      ip: '10.0.0.9',
      requestId: 'req-admin',
    });

    const future = await adminRepository.auditLogs({
      ...PAGE,
      filter: { from: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(future).toEqual({ items: [], total: 0 });
  });
});
