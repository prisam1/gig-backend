import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { decrypt, keyedHash } from '../../lib/crypto';
import { DatabaseError, isUniqueViolation } from '../../lib/db';
import { containsPattern, type PageMeta } from '../../lib/http';
import { hashRequest, type IdempotentResult } from '../../lib/idempotency';
import type { Member } from '../../lib/membership';
import { HttpError, validationError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import type { StaffRole } from '../../types/domain';
import { identifierSchema } from '../auth/auth.schemas';
import { filesStorage } from '../files/files.storage';
import { EVIDENCE_BUCKET } from '../reviews/reviews.service';
import { hasPermission } from './admin.access';
import {
  adminRepository,
  isDbError,
  type CreditGrant,
  type DbResult,
  type Page,
  type UserDetailRow,
  type UserSearch,
} from './admin.repository';
import type {
  AuditLogsQuery,
  CompanyInput,
  DocumentInput,
  DocumentUploadUrlInput,
  GrantCreditsInput,
  IssuerInput,
  LearnInput,
  ListCompaniesQuery,
  ListIssuersAdminQuery,
  ListKycQuery,
  ListLearnAdminQuery,
  ListQuestionsQuery,
  ListRepresentationsAdminQuery,
  ListRoadshowsAdminQuery,
  ListUsersQuery,
  ModerationDecisionInput,
  ModerationQueueQuery,
  ModerationType,
  RepresentationInput,
  RepresentationStatusInput,
  RoadshowInput,
  UpdateUserInput,
} from './admin.schemas';

/** Private bucket for petition evidence, submission packs and regulator responses. */
export const REPRESENTATION_DOCUMENTS_BUCKET = 'representation-documents';

/** Download links for KYC documents, evidence and petition documents last 5 minutes. */
const DOWNLOAD_URL_TTL_SECONDS = 300;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

const notFound = (what: string) => new HttpError(404, `${what} not found`);

// { error: CODE } results of the app_admin_* functions, as API errors.
const ERRORS: Record<string, (result: { status?: string; balance?: number }) => HttpError> = {
  SELF_CHANGE: () =>
    new HttpError(409, 'Staff cannot make this change to their own account', {
      code: 'SELF_CHANGE',
    }),
  KYC_NOT_APPROVED: () =>
    new HttpError(
      409,
      'Prive and Institutional need approved KYC; approve a KYC submission instead',
      {
        code: 'KYC_NOT_APPROVED',
      },
    ),
  LAST_ADMIN: () =>
    new HttpError(409, 'GIG must keep at least one active ADMIN', { code: 'LAST_ADMIN' }),
  ALREADY_DECIDED: (r) =>
    new HttpError(409, `This submission was already ${r.status?.toLowerCase() ?? 'decided'}`, {
      code: 'KYC_ALREADY_DECIDED',
    }),
  OWN_SUBMISSION: () =>
    new HttpError(403, 'Another staff member must decide your own KYC', {
      code: 'CONFLICT_OF_INTEREST',
    }),
  USER_INACTIVE: () =>
    new HttpError(409, 'The account has been deleted', { code: 'USER_INACTIVE' }),
  DOCUMENT_INFECTED: () =>
    new HttpError(409, 'A document failed the virus scan; reject the submission instead', {
      code: 'DOCUMENT_INFECTED',
    }),
  OWN_CONTENT: () =>
    new HttpError(403, 'Another staff member must moderate your own content', {
      code: 'CONFLICT_OF_INTEREST',
    }),
  INVALID_TRANSITION: (r) =>
    new HttpError(409, `Not possible from the current status (${r.status ?? 'unknown'})`, {
      code: 'INVALID_TRANSITION',
    }),
  DOCUMENT_INVALID: () =>
    validationError({ documents: 'Upload each document through upload-url for this petition' }),
  INSUFFICIENT_CREDITS: (r) =>
    new HttpError(409, `The user has only ${r.balance ?? 0} credits`, {
      code: 'INSUFFICIENT_CREDITS',
    }),
  IDEMPOTENCY_CONFLICT: () =>
    new HttpError(409, 'Idempotency-Key was already used for a different request', {
      code: 'IDEMPOTENCY_CONFLICT',
    }),
};

/** The value of a successful app_admin_* call; otherwise the matching API error. */
function unwrap<T>(result: DbResult<T>, what: string): T {
  if (!isDbError(result)) return result;
  if (result.error === 'NOT_FOUND') throw notFound(what);
  const error = ERRORS[result.error];
  if (!error) throw new Error(`Unexpected database result: ${result.error}`);
  throw error(result);
}

/** Slug clashes and the database's own range checks, as field errors. */
function contentError(error: unknown): never {
  if (isUniqueViolation(error) && (error as DatabaseError).constraint?.endsWith('_slug_key')) {
    throw new HttpError(409, 'Another item already uses this slug', {
      code: 'SLUG_TAKEN',
      fields: { slug: 'Already in use' },
    });
  }
  if (
    isUniqueViolation(error) &&
    (error as DatabaseError).constraint === 'representation_documents_object_key_key'
  ) {
    throw new HttpError(409, 'A document is already attached', {
      code: 'DOCUMENT_ALREADY_ATTACHED',
    });
  }
  // CHECK constraints spanning stored and new values (dates, price range, signing window).
  if (error instanceof DatabaseError && error.code === '23514') {
    throw new HttpError(400, 'These values conflict with the ones already saved', {
      fields: { _: error.constraint ?? 'Check failed' },
    });
  }
  throw error;
}

async function guarded<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    contentError(error);
  }
}

function pageOf<T>(
  page: Page<T>,
  query: { page: number; pageSize: number },
): { items: T[]; meta: PageMeta } {
  return {
    items: page.items,
    meta: { page: query.page, pageSize: query.pageSize, total: page.total },
  };
}

function downloadUrl(bucket: string, objectKey: string): Promise<string> {
  return filesStorage.createDownloadUrl(bucket, objectKey, DOWNLOAD_URL_TTL_SECONDS);
}

const linkExpiry = () => new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000);

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------

/** `q` as the database searches it: exact email or phone (by keyed hash), user ID, or name. */
export function userSearch(q: string | undefined): UserSearch {
  if (!q) return {};
  if (z.uuid().safeParse(q).success) return { publicId: q.toLowerCase() };
  const identifier = identifierSchema.safeParse(q);
  if (identifier.success) {
    return identifier.data.channel === 'EMAIL'
      ? { emailHash: keyedHash('email', identifier.data.value) }
      : { phoneHash: keyedHash('phone', identifier.data.value) };
  }
  return { namePattern: containsPattern(q) };
}

function toUserDetail(row: UserDetailRow, contact: { email: string; phone: string } | null) {
  return {
    id: row.publicId,
    name: row.name,
    tier: row.tier,
    requestedTier: row.requestedTier,
    kycStatus: row.kycStatus,
    status: row.status,
    roles: row.roles,
    creditBalance: row.creditBalance,
    /** Null for staff roles that may not see contact details. */
    contact,
    profile: {
      experienceYears: row.experienceYears,
      jobProfile: row.jobProfile,
      otherJob: row.otherJob,
      location: row.location,
    },
    emailVerifiedAt: row.emailVerifiedAt,
    phoneVerifiedAt: row.phoneVerifiedAt,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    activeSessions: row.activeSessions,
    activity: row.activity,
    kycSubmissions: row.kycSubmissions,
    tierHistory: row.tierHistory,
  };
}

async function requireUser(publicId: string): Promise<UserDetailRow> {
  const row = await adminRepository.findUser(publicId);
  if (!row) throw notFound('User');
  return row;
}

export const adminUsers = {
  async list(query: ListUsersQuery) {
    return pageOf(await adminRepository.findUsers(userSearch(query.q), query), query);
  },

  /** Email and phone only for roles allowed to see them; each such view is audited. */
  async get(staff: Member, roles: StaffRole[], publicId: string, ctx: ClientContext) {
    const row = await requireUser(publicId);
    if (!hasPermission(roles, 'users.contact')) return toUserDetail(row, null);

    await audit(ctx, 'admin.user.viewed', {
      userId: staff.userId,
      metadata: { user: row.publicId },
    });
    return toUserDetail(row, {
      email: decrypt(row.emailEnc, 'email'),
      phone: decrypt(row.phoneEnc, 'phone'),
    });
  },

  async update(staff: Member, publicId: string, input: UpdateUserInput, ctx: ClientContext) {
    const { reason, ...changes } = input;
    unwrap(await adminRepository.updateUser(staff.userId, publicId, changes, reason, ctx), 'User');
    return toUserDetail(await requireUser(publicId), null);
  },

  async setRoles(staff: Member, publicId: string, roles: StaffRole[], ctx: ClientContext) {
    const result = unwrap(
      await adminRepository.setRoles(staff.userId, publicId, roles, ctx),
      'User',
    );
    return { id: publicId, roles: result.roles };
  },

  async credits(publicId: string, query: { page: number; pageSize: number }) {
    const credits = await adminRepository.userCredits(publicId, query);
    if (!credits) throw notFound('User');
    return { balance: credits.balance, ...pageOf(credits, query) };
  },
};

// ---------------------------------------------------------------------------------------------
// KYC
// ---------------------------------------------------------------------------------------------

export const adminKyc = {
  async list(query: ListKycQuery) {
    return pageOf(await adminRepository.findKyc(query), query);
  },

  /** The submission with 5-minute links to its documents. Opening it is audited. */
  async get(staff: Member, publicId: string, ctx: ClientContext) {
    const row = await adminRepository.findKycSubmission(publicId);
    if (!row) throw notFound('KYC submission');

    const documents = await Promise.all(
      row.documents.map(async ({ bucket, objectKey, ...document }) => ({
        ...document,
        // Files the virus scan flagged are never handed out.
        downloadUrl:
          document.scanStatus === 'INFECTED' ? null : await downloadUrl(bucket, objectKey),
      })),
    );
    await audit(ctx, 'admin.kyc.viewed', {
      userId: staff.userId,
      metadata: { submission: row.id, user: row.user.id },
    });
    return { ...row, documents, linksExpireAt: linkExpiry() };
  },

  async approve(staff: Member, publicId: string, ctx: ClientContext) {
    const decision = unwrap(
      await adminRepository.decideKyc(staff.userId, publicId, 'APPROVE', null, ctx),
      'KYC submission',
    );
    return { id: publicId, ...decision };
  },

  async reject(staff: Member, publicId: string, reason: string, ctx: ClientContext) {
    const decision = unwrap(
      await adminRepository.decideKyc(staff.userId, publicId, 'REJECT', reason, ctx),
      'KYC submission',
    );
    return { id: publicId, ...decision, reason };
  },
};

// ---------------------------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------------------------

const MODERATION_LABELS: Record<ModerationType, string> = {
  REVIEW: 'Review',
  RATING: 'Rating',
  QUESTION: 'Question',
};

export const adminModeration = {
  async queue(query: ModerationQueueQuery) {
    return pageOf(await adminRepository.moderationQueue(query), query);
  },

  /** The full review, rating or question, with 5-minute links to a review's evidence. */
  async get(type: ModerationType, id: string) {
    const row = await adminRepository.moderationItem(type, id);
    if (!row) throw notFound(MODERATION_LABELS[type]);

    const evidence = await Promise.all(
      row.evidence.map(async (file) => ({
        ...file,
        downloadUrl: await downloadUrl(EVIDENCE_BUCKET, file.path),
      })),
    );
    return { ...row, evidence, linksExpireAt: evidence.length > 0 ? linkExpiry() : null };
  },

  async decide(staff: Member, id: string, input: ModerationDecisionInput, ctx: ClientContext) {
    return unwrap(
      await adminRepository.moderate(staff.userId, id, input, ctx),
      MODERATION_LABELS[input.type],
    );
  },
};

// ---------------------------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------------------------

export const adminCompanies = {
  async list(query: ListCompaniesQuery) {
    return pageOf(await adminRepository.findCompanies(query), query);
  },

  async get(id: string) {
    const company = await adminRepository.findCompany(id);
    if (!company) throw notFound('Company');
    return company;
  },

  async save(staff: Member, id: string | null, input: CompanyInput, ctx: ClientContext) {
    const saved = unwrap(
      await guarded(() => adminRepository.saveCompany(staff.userId, id, input, ctx)),
      'Company',
    );
    return this.get(saved.id);
  },

  async remove(staff: Member, id: string, ctx: ClientContext) {
    if (!(await adminRepository.deleteCompany(staff.userId, id, ctx))) throw notFound('Company');
  },
};

export const adminIssuers = {
  async list(query: ListIssuersAdminQuery) {
    return pageOf(await adminRepository.findIssuers(query), query);
  },

  async get(id: string) {
    const issuer = await adminRepository.findIssuer(id);
    if (!issuer) throw notFound('Issuer');
    return issuer;
  },

  async save(staff: Member, id: string | null, input: IssuerInput, ctx: ClientContext) {
    const saved = unwrap(
      await guarded(() => adminRepository.saveIssuer(staff.userId, id, input, ctx)),
      'Issuer',
    );
    return this.get(saved.id);
  },

  async remove(staff: Member, id: string, ctx: ClientContext) {
    if (!(await adminRepository.deleteIssuer(staff.userId, id, ctx))) throw notFound('Issuer');
  },
};

const EXTENSION_BY_MIME: Record<DocumentUploadUrlInput['mimeType'], string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** Every document must have been uploaded to the petition's folder before it is attached. */
async function checkUploaded(documents: DocumentInput[]): Promise<void> {
  const fields: Record<string, string> = {};
  await Promise.all(
    documents.map(async (document, index) => {
      if (!(await filesStorage.exists(REPRESENTATION_DOCUMENTS_BUCKET, document.objectKey))) {
        fields[`documents.${index}.objectKey`] = 'File has not been uploaded yet';
      }
    }),
  );
  if (Object.keys(fields).length > 0) throw validationError(fields);
}

export const adminRepresentations = {
  async list(query: ListRepresentationsAdminQuery) {
    return pageOf(await adminRepository.findRepresentations(query), query);
  },

  /** The petition with its documents (5-minute links; infected files flagged, never linked). */
  async get(id: string) {
    const representation = await adminRepository.findRepresentation(id);
    if (!representation) throw notFound('Representation');

    const documents = await Promise.all(
      representation.documents.map(async (document) => ({
        ...document,
        downloadUrl:
          document.scanStatus === 'INFECTED'
            ? null
            : await downloadUrl(document.bucket, document.objectKey),
      })),
    );
    return {
      ...representation,
      documents,
      linksExpireAt: documents.length > 0 ? linkExpiry() : null,
    };
  },

  async save(staff: Member, id: string | null, input: RepresentationInput, ctx: ClientContext) {
    const saved = unwrap(
      await guarded(() => adminRepository.saveRepresentation(staff.userId, id, input, ctx)),
      'Representation',
    );
    return this.get(saved.id);
  },

  async remove(staff: Member, id: string, ctx: ClientContext) {
    if (!(await adminRepository.deleteRepresentation(staff.userId, id, ctx)))
      throw notFound('Representation');
  },

  /** A signed URL to PUT one document into the petition's folder; attach it afterwards. */
  async createDocumentUploadUrl(id: string, input: DocumentUploadUrlInput) {
    if (!(await adminRepository.findRepresentation(id))) throw notFound('Representation');
    const objectKey = `${id}/${randomUUID()}.${EXTENSION_BY_MIME[input.mimeType]}`;
    return {
      objectKey,
      uploadUrl: await filesStorage.createUploadUrl(REPRESENTATION_DOCUMENTS_BUCKET, objectKey),
      method: 'PUT',
      contentType: input.mimeType,
    };
  },

  async addDocuments(staff: Member, id: string, documents: DocumentInput[], ctx: ClientContext) {
    await checkUploaded(documents);
    unwrap(
      await guarded(() =>
        adminRepository.addRepresentationDocuments(staff.userId, id, documents, ctx),
      ),
      'Representation',
    );
    return this.get(id);
  },

  async changeStatus(
    staff: Member,
    id: string,
    input: RepresentationStatusInput,
    ctx: ClientContext,
  ) {
    await checkUploaded(input.documents);
    const change = unwrap(
      await guarded(() =>
        adminRepository.changeRepresentationStatus(
          staff.userId,
          id,
          { status: input.status, note: input.note ?? null, documents: input.documents },
          ctx,
        ),
      ),
      'Representation',
    );
    return { ...change, representation: await this.get(id) };
  },
};

// ---------------------------------------------------------------------------------------------
// Roadshows and learn
// ---------------------------------------------------------------------------------------------

export const adminRoadshows = {
  async list(query: ListRoadshowsAdminQuery) {
    return pageOf(await adminRepository.findRoadshows(query), query);
  },

  async get(id: string) {
    const roadshow = await adminRepository.findRoadshow(id);
    if (!roadshow) throw notFound('Roadshow');
    return roadshow;
  },

  async save(staff: Member, id: string | null, input: RoadshowInput, ctx: ClientContext) {
    const result = await guarded(() => adminRepository.saveRoadshow(staff.userId, id, input, ctx));
    if (isDbError(result) && result.error === 'ISSUER_NOT_FOUND') {
      throw validationError({ issuerId: 'Issuer not found' });
    }
    return this.get(unwrap(result, 'Roadshow').id);
  },

  async remove(staff: Member, id: string, ctx: ClientContext) {
    if (!(await adminRepository.deleteRoadshow(staff.userId, id, ctx))) throw notFound('Roadshow');
  },

  /** Ask Me Anything questions, oldest first; filter by status, category or answered. */
  async questions(id: string, query: ListQuestionsQuery) {
    const page = await adminRepository.findQuestions(id, query);
    if (!page) throw notFound('Roadshow');
    return pageOf(page, query);
  },

  /** Publishes the issuer's answer; answering a pending question publishes the question too. */
  async answer(staff: Member, id: string, questionId: string, answer: string, ctx: ClientContext) {
    return unwrap(
      await adminRepository.answerQuestion(staff.userId, id, questionId, answer, ctx),
      'Question',
    );
  },
};

export const adminLearn = {
  async list(query: ListLearnAdminQuery) {
    return pageOf(await adminRepository.findLearn(query), query);
  },

  async get(id: string) {
    const item = await adminRepository.findLearnItem(id);
    if (!item) throw notFound('Learn item');
    return item;
  },

  async save(staff: Member, id: string | null, input: LearnInput, ctx: ClientContext) {
    const saved = unwrap(
      await guarded(() => adminRepository.saveLearn(staff.userId, id, input, ctx)),
      'Learn item',
    );
    return this.get(saved.id);
  },

  async remove(staff: Member, id: string, ctx: ClientContext) {
    if (!(await adminRepository.deleteLearn(staff.userId, id, ctx))) throw notFound('Learn item');
  },
};

// ---------------------------------------------------------------------------------------------
// Credits and audit trail
// ---------------------------------------------------------------------------------------------

export const adminCredits = {
  /** Grant (delta > 0) or revoke (delta < 0). A retry with the same Idempotency-Key is a replay. */
  async grant(
    staff: Member,
    input: GrantCreditsInput,
    idempotencyKey: string,
    ctx: ClientContext,
  ): Promise<IdempotentResult<Omit<CreditGrant, 'replayed'> & { userId: string }>> {
    const { replayed, ...grant } = unwrap(
      await adminRepository.grantCredits(
        staff.userId,
        { ...input, idempotencyKey, requestHash: hashRequest(input) },
        ctx,
      ),
      'User',
    );
    return { result: { userId: input.userId, ...grant }, replayed };
  },
};

export const adminAudit = {
  async list(query: AuditLogsQuery) {
    return pageOf(await adminRepository.auditLogs(query), query);
  },
};
