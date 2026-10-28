import { callDb } from '../../lib/db';
import { containsPattern, escapeLike } from '../../lib/http';
import type { KycStatus, Tier, VerifiedTier } from '../../lib/membership';
import type { ClientContext } from '../../middleware/requestContext';
import type {
  KycDocumentType,
  KycSubmissionStatus,
  LearnContentType,
  MarketCountry,
  RatingStatus,
  RepresentationDocumentType,
  RepresentationTrackStatus,
  RoadshowQuestionCategory,
  StaffRole,
  UserStatus,
} from '../../types/domain';
import type {
  AuditLogsQuery,
  CompanyInput,
  DocumentInput,
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
  RoadshowInput,
} from './admin.schemas';

// Every admin write is one app_admin_* database function that also writes its audit entry.
// Expected failures come back as { error: CODE }; the service turns them into HTTP errors.

export interface Page<T> {
  items: T[];
  total: number;
}

export type DbResult<T> = T | { error: string; status?: string; balance?: number };

export function isDbError<T>(
  result: DbResult<T>,
): result is { error: string; status?: string; balance?: number } {
  return typeof result === 'object' && result !== null && 'error' in result;
}

const offset = (query: { page: number; pageSize: number }) => ({
  p_limit: query.pageSize,
  p_offset: (query.page - 1) * query.pageSize,
});

// ---------------------------------------------------------------------------------------------
// Shapes (dates as the JSON carries them: ISO strings)
// ---------------------------------------------------------------------------------------------

export interface PersonRef {
  id: string;
  name: string | null;
}

export interface UserListItem {
  id: string;
  name: string | null;
  tier: Tier;
  requestedTier: VerifiedTier | null;
  kycStatus: KycStatus;
  status: UserStatus;
  creditBalance: number;
  roles: StaffRole[];
  createdAt: string;
  lastLoginAt: string | null;
}

export interface UserDetailRow {
  /** Internal key, never returned by the API. */
  id: string;
  publicId: string;
  emailEnc: string;
  phoneEnc: string;
  name: string | null;
  experienceYears: number | null;
  jobProfile: string | null;
  otherJob: string | null;
  location: string | null;
  tier: Tier;
  requestedTier: VerifiedTier | null;
  kycStatus: KycStatus;
  status: UserStatus;
  creditBalance: number;
  roles: StaffRole[];
  emailVerifiedAt: string;
  phoneVerifiedAt: string;
  createdAt: string;
  lastLoginAt: string | null;
  deletedAt: string | null;
  activeSessions: number;
  activity: {
    reviews: number;
    ratings: number;
    signatures: number;
    followers: number;
    following: number;
  };
  kycSubmissions: {
    id: string;
    tier: VerifiedTier;
    status: KycSubmissionStatus;
    reason: string | null;
    submittedAt: string;
    reviewedAt: string | null;
  }[];
  tierHistory: {
    fromTier: Tier;
    toTier: Tier;
    requestedTier: VerifiedTier | null;
    reason: string;
    at: string;
  }[];
}

/** What a user search matches on; at most one is set. */
export interface UserSearch {
  emailHash?: string;
  phoneHash?: string;
  publicId?: string;
  namePattern?: string;
}

export interface KycListItem {
  id: string;
  tier: VerifiedTier;
  status: KycSubmissionStatus;
  provider: string;
  reason: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  documentCount: number;
  user: { id: string; name: string | null; tier: Tier; kycStatus: KycStatus; status: UserStatus };
}

export interface KycDocumentRow {
  fileId: string;
  documentType: KycDocumentType;
  bucket: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED';
}

export interface KycDetailRow {
  id: string;
  tier: VerifiedTier;
  status: KycSubmissionStatus;
  provider: string;
  reference: string | null;
  reason: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewer: PersonRef | null;
  user: {
    id: string;
    name: string | null;
    tier: Tier;
    requestedTier: VerifiedTier | null;
    kycStatus: KycStatus;
    status: UserStatus;
    createdAt: string;
  };
  consent: { version: string; acceptedAt: string } | null;
  documents: KycDocumentRow[];
}

export interface KycDecision {
  status: KycSubmissionStatus;
  tier: Tier;
  kycStatus: KycStatus;
}

export interface ModerationAuthor {
  id: string;
  name: string;
  tier: Tier | null;
  kycStatus: KycStatus | null;
}

export interface ModerationQueueItem {
  type: ModerationType;
  id: string;
  /** Null for questions, which have no receipt. */
  receiptNo: string | null;
  status: RatingStatus;
  submittedAt: string;
  moderationNote: string | null;
  author: ModerationAuthor;
  subject: { type: 'COMPANY' | 'ISSUER' | 'ROADSHOW'; id: string; name: string };
  summary: Record<string, unknown>;
}

export interface ModerationItemRow extends Omit<ModerationQueueItem, 'summary'> {
  publishedAt: string | null;
  content: Record<string, unknown>;
  /** Review evidence: objects in the review-evidence bucket. */
  evidence: { path: string; docType: string }[];
  history: {
    changeType: string;
    fromValue: string | null;
    toValue: string | null;
    note: string | null;
    at: string;
  }[];
}

export interface ModerationResult {
  type: ModerationType;
  id: string;
  previousStatus: RatingStatus;
  status: RatingStatus;
}

export interface AdminCompany {
  id: string;
  slug: string;
  name: string;
  assetClass: string;
  country: MarketCountry;
  logoUrl: string | null;
  description: string | null;
  verified: boolean;
  tags: string[];
  reviewCount: number;
  score: number;
  pendingReviews: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AdminIssuer {
  id: string;
  slug: string;
  name: string;
  instrument: string;
  assetType: string;
  exchange: string | null;
  openDate: string | null;
  closeDate: string | null;
  isListed: boolean;
  minLot: number | null;
  lotUnit: string;
  priceMin: number | null;
  priceMax: number | null;
  offerSize: number | null;
  currency: string;
  useOfFunds: string | null;
  lockIn: string | null;
  prePostRatio: string | null;
  tags: string[];
  ratingCount: number;
  averageScore: number;
  pendingRatings: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AdminRepresentation {
  id: string;
  slug: string;
  title: string;
  description: string;
  asks: string[];
  whyItMatters: string;
  category: string | null;
  country: MarketCountry;
  tags: string[];
  regulators: string[];
  goal: number;
  signatureCount: number;
  voteCount: number;
  opensAt: string;
  closesAt: string;
  /** As stored; Open / Closing Soon / Closed are then derived from the dates. */
  storedStatus: RepresentationTrackStatus;
  /** The status the app shows. */
  trackStatus: RepresentationTrackStatus;
  isPublished: boolean;
  isOpenForSigning: boolean;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AdminRepresentationDocument {
  id: string;
  title: string;
  documentType: RepresentationDocumentType;
  bucket: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED';
  createdAt: string;
}

export interface AdminRepresentationDetail extends AdminRepresentation {
  documents: AdminRepresentationDocument[];
  history: {
    fromStatus: RepresentationTrackStatus | null;
    toStatus: RepresentationTrackStatus;
    note: string | null;
    actor: PersonRef | null;
    occurredAt: string;
    documentIds: string[];
  }[];
}

export interface RoadshowFinancialYear {
  fiscalYear: string;
  revenue: number | null;
  ebitda: number | null;
  netProfit: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  netWorth: number | null;
  totalDebt: number | null;
  operatingCashFlow: number | null;
  eps: number | null;
  roePct: number | null;
}

export interface AdminRoadshow {
  id: string;
  slug: string;
  title: string;
  summary: string;
  issuer: { id: string; name: string };
  typeOfIssue: string;
  instruments: string;
  noOfInstruments: number | null;
  offerPrice: number | null;
  currency: string;
  lockIn: string | null;
  maturity: string | null;
  convertibility: string | null;
  callable: boolean;
  couponRate: number | null;
  riskFactors: string[];
  opensAt: string;
  closesAt: string;
  poolEnabled: boolean;
  isPublished: boolean;
  publishedAt: string | null;
  /** Published, and between opensAt and closesAt. */
  isOpen: boolean;
  /** Newest fiscal year first. */
  financials: RoadshowFinancialYear[];
  questions: { pending: number; published: number; unanswered: number };
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AdminQuestion {
  id: string;
  category: RoadshowQuestionCategory;
  question: string;
  status: RatingStatus;
  moderationNote: string | null;
  answer: string | null;
  answeredAt: string | null;
  answeredBy: PersonRef | null;
  author: ModerationAuthor;
  creditSpent: number;
  upvoteCount: number;
  submittedAt: string;
  publishedAt: string | null;
}

export interface AdminLearnItem {
  id: string;
  slug: string;
  title: string;
  summary: string;
  contentType: LearnContentType;
  category: string | null;
  tags: string[];
  minTier: Tier;
  downloadable: boolean;
  author: string | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  body: string | null;
  durationSeconds: number | null;
  featured: boolean;
  isPublished: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreditEntry {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  refType: string;
  createdAt: string;
}

export interface CreditGrant {
  entry: CreditEntry;
  balance: number;
  replayed: boolean;
}

export interface UserCredits extends Page<
  CreditEntry & { refId: string | null; actor: PersonRef | null }
> {
  balance: number;
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  action: string;
  actor: PersonRef | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
}

/** Audit action filters as LIKE patterns: `admin.*` matches every action under admin. */
export function actionPatterns(actions: string[] | undefined): string[] | null {
  if (!actions?.length) return null;
  return actions.map((action) =>
    action.endsWith('.*') ? `${escapeLike(action.slice(0, -1))}%` : escapeLike(action),
  );
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export const adminRepository = {
  // ----- staff -----

  staffRoles(userId: string): Promise<StaffRole[]> {
    return callDb('app_admin_staff_roles', { p_user_id: userId });
  },

  // ----- users -----

  findUsers(search: UserSearch, query: ListUsersQuery): Promise<Page<UserListItem>> {
    return callDb('app_admin_find_users', {
      p_search: search,
      p_tiers: query.filter?.tier ?? null,
      p_kyc_statuses: query.filter?.kycStatus ?? null,
      p_statuses: query.filter?.status ?? null,
      p_roles: query.filter?.role ?? null,
      p_sort: query.sort,
      ...offset(query),
    });
  },

  findUser(publicId: string): Promise<UserDetailRow | null> {
    return callDb('app_admin_get_user', { p_public_id: publicId });
  },

  updateUser(
    actorId: string,
    publicId: string,
    changes: { tier?: Tier; status?: 'ACTIVE' | 'SUSPENDED' },
    reason: string,
    ctx: ClientContext,
  ): Promise<DbResult<{ ok: true }>> {
    return callDb('app_admin_update_user', {
      p_actor_id: actorId,
      p_public_id: publicId,
      p_changes: changes,
      p_reason: reason,
      p_ctx: ctx,
    });
  },

  setRoles(
    actorId: string,
    publicId: string,
    roles: StaffRole[],
    ctx: ClientContext,
  ): Promise<DbResult<{ roles: StaffRole[] }>> {
    return callDb('app_admin_set_roles', {
      p_actor_id: actorId,
      p_public_id: publicId,
      p_roles: roles,
      p_ctx: ctx,
    });
  },

  userCredits(
    publicId: string,
    query: { page: number; pageSize: number },
  ): Promise<UserCredits | null> {
    return callDb('app_admin_user_credits', { p_public_id: publicId, ...offset(query) });
  },

  // ----- KYC -----

  findKyc(query: ListKycQuery): Promise<Page<KycListItem>> {
    return callDb('app_admin_find_kyc', {
      p_statuses: query.filter?.status ?? ['PENDING'],
      p_tiers: query.filter?.tier ?? null,
      ...offset(query),
    });
  },

  findKycSubmission(publicId: string): Promise<KycDetailRow | null> {
    return callDb('app_admin_get_kyc', { p_public_id: publicId });
  },

  decideKyc(
    actorId: string,
    publicId: string,
    decision: 'APPROVE' | 'REJECT',
    reason: string | null,
    ctx: ClientContext,
  ): Promise<DbResult<KycDecision>> {
    return callDb('app_admin_decide_kyc', {
      p_actor_id: actorId,
      p_public_id: publicId,
      p_decision: decision,
      p_reason: reason,
      p_ctx: ctx,
    });
  },

  // ----- moderation -----

  moderationQueue(query: ModerationQueueQuery): Promise<Page<ModerationQueueItem>> {
    return callDb('app_admin_moderation_queue', {
      p_types: query.filter?.type ?? null,
      p_statuses: query.filter?.status ?? ['PENDING_MODERATION'],
      ...offset(query),
    });
  },

  moderationItem(type: ModerationType, id: string): Promise<ModerationItemRow | null> {
    return callDb('app_admin_moderation_item', { p_type: type, p_id: id });
  },

  moderate(
    actorId: string,
    id: string,
    input: ModerationDecisionInput,
    ctx: ClientContext,
  ): Promise<DbResult<ModerationResult>> {
    return callDb('app_admin_moderate', {
      p_actor_id: actorId,
      p_type: input.type,
      p_id: id,
      p_decision: input.decision,
      p_note: input.note ?? null,
      p_ctx: ctx,
    });
  },

  // ----- companies -----

  findCompanies(query: ListCompaniesQuery): Promise<Page<AdminCompany>> {
    return callDb('app_admin_find_companies', {
      p_q_pattern: query.q ? containsPattern(query.q) : null,
      p_asset_classes: query.filter?.assetClass ?? null,
      p_countries: query.filter?.country ?? null,
      p_verified: query.filter?.verified ?? null,
      p_include_deleted: query.filter?.deleted ?? false,
      ...offset(query),
    });
  },

  findCompany(id: string): Promise<AdminCompany | null> {
    return callDb('app_admin_get_company', { p_id: id });
  },

  /** Creates the company when `id` is null. */
  saveCompany(
    actorId: string,
    id: string | null,
    input: CompanyInput,
    ctx: ClientContext,
  ): Promise<DbResult<{ id: string }>> {
    return callDb('app_admin_save_company', {
      p_actor_id: actorId,
      p_id: id,
      p_company: input,
      p_ctx: ctx,
    });
  },

  deleteCompany(actorId: string, id: string, ctx: ClientContext): Promise<boolean> {
    return callDb('app_admin_delete_company', { p_actor_id: actorId, p_id: id, p_ctx: ctx });
  },

  // ----- issuers -----

  findIssuers(query: ListIssuersAdminQuery): Promise<Page<AdminIssuer>> {
    return callDb('app_admin_find_issuers', {
      p_q_pattern: query.q ? containsPattern(query.q) : null,
      p_asset_types: query.filter?.assetType ?? null,
      p_listed: query.filter?.listed ?? null,
      p_include_deleted: query.filter?.deleted ?? false,
      ...offset(query),
    });
  },

  findIssuer(id: string): Promise<AdminIssuer | null> {
    return callDb('app_admin_get_issuer', { p_id: id });
  },

  /** Creates the issuer when `id` is null. */
  saveIssuer(
    actorId: string,
    id: string | null,
    input: IssuerInput,
    ctx: ClientContext,
  ): Promise<DbResult<{ id: string }>> {
    return callDb('app_admin_save_issuer', {
      p_actor_id: actorId,
      p_id: id,
      p_issuer: input,
      p_ctx: ctx,
    });
  },

  deleteIssuer(actorId: string, id: string, ctx: ClientContext): Promise<boolean> {
    return callDb('app_admin_delete_issuer', { p_actor_id: actorId, p_id: id, p_ctx: ctx });
  },

  // ----- representations -----

  findRepresentations(query: ListRepresentationsAdminQuery): Promise<Page<AdminRepresentation>> {
    return callDb('app_admin_find_representations', {
      p_q_pattern: query.q ? containsPattern(query.q) : null,
      p_statuses: query.filter?.status ?? null,
      p_countries: query.filter?.country ?? null,
      p_include_deleted: query.filter?.deleted ?? false,
      ...offset(query),
    });
  },

  findRepresentation(id: string): Promise<AdminRepresentationDetail | null> {
    return callDb('app_admin_get_representation', { p_public_id: id });
  },

  /** Creates the petition when `id` is null. */
  saveRepresentation(
    actorId: string,
    id: string | null,
    input: RepresentationInput,
    ctx: ClientContext,
  ): Promise<DbResult<{ id: string }>> {
    return callDb('app_admin_save_representation', {
      p_actor_id: actorId,
      p_public_id: id,
      p_representation: input,
      p_ctx: ctx,
    });
  },

  deleteRepresentation(actorId: string, id: string, ctx: ClientContext): Promise<boolean> {
    return callDb('app_admin_delete_representation', {
      p_actor_id: actorId,
      p_public_id: id,
      p_ctx: ctx,
    });
  },

  changeRepresentationStatus(
    actorId: string,
    id: string,
    input: { status: RepresentationTrackStatus; note: string | null; documents: DocumentInput[] },
    ctx: ClientContext,
  ): Promise<
    DbResult<{ previousStatus: RepresentationTrackStatus; status: RepresentationTrackStatus }>
  > {
    return callDb('app_admin_representation_status', {
      p_actor_id: actorId,
      p_public_id: id,
      p_to_status: input.status,
      p_note: input.note,
      p_documents: input.documents,
      p_ctx: ctx,
    });
  },

  addRepresentationDocuments(
    actorId: string,
    id: string,
    documents: DocumentInput[],
    ctx: ClientContext,
  ): Promise<DbResult<{ ok: true }>> {
    return callDb('app_admin_add_representation_documents', {
      p_actor_id: actorId,
      p_public_id: id,
      p_documents: documents,
      p_ctx: ctx,
    });
  },

  // ----- roadshows -----

  findRoadshows(query: ListRoadshowsAdminQuery): Promise<Page<AdminRoadshow>> {
    return callDb('app_admin_find_roadshows', {
      p_q_pattern: query.q ? containsPattern(query.q) : null,
      p_issuer_id: query.filter?.issuer ?? null,
      p_published: query.filter?.published ?? null,
      p_open: query.filter?.open ?? null,
      p_include_deleted: query.filter?.deleted ?? false,
      ...offset(query),
    });
  },

  findRoadshow(id: string): Promise<AdminRoadshow | null> {
    return callDb('app_admin_get_roadshow', { p_public_id: id });
  },

  /** Creates the roadshow when `id` is null. */
  saveRoadshow(
    actorId: string,
    id: string | null,
    input: RoadshowInput,
    ctx: ClientContext,
  ): Promise<DbResult<{ id: string }>> {
    return callDb('app_admin_save_roadshow', {
      p_actor_id: actorId,
      p_public_id: id,
      p_roadshow: input,
      p_ctx: ctx,
    });
  },

  deleteRoadshow(actorId: string, id: string, ctx: ClientContext): Promise<boolean> {
    return callDb('app_admin_delete_roadshow', {
      p_actor_id: actorId,
      p_public_id: id,
      p_ctx: ctx,
    });
  },

  /** Null when the roadshow does not exist. */
  findQuestions(
    roadshowId: string,
    query: ListQuestionsQuery,
  ): Promise<Page<AdminQuestion> | null> {
    return callDb('app_admin_roadshow_questions', {
      p_public_id: roadshowId,
      p_statuses: query.filter?.status ?? null,
      p_categories: query.filter?.category ?? null,
      p_answered: query.filter?.answered ?? null,
      ...offset(query),
    });
  },

  answerQuestion(
    actorId: string,
    roadshowId: string,
    questionId: string,
    answer: string,
    ctx: ClientContext,
  ): Promise<DbResult<AdminQuestion>> {
    return callDb('app_admin_answer_question', {
      p_actor_id: actorId,
      p_roadshow_id: roadshowId,
      p_question_id: questionId,
      p_answer: answer,
      p_ctx: ctx,
    });
  },

  // ----- learn -----

  findLearn(query: ListLearnAdminQuery): Promise<Page<AdminLearnItem>> {
    return callDb('app_admin_find_learn', {
      p_q_pattern: query.q ? containsPattern(query.q) : null,
      p_content_types: query.filter?.contentType ?? null,
      p_min_tiers: query.filter?.minTier ?? null,
      p_published: query.filter?.published ?? null,
      p_include_deleted: query.filter?.deleted ?? false,
      ...offset(query),
    });
  },

  findLearnItem(id: string): Promise<AdminLearnItem | null> {
    return callDb('app_admin_get_learn', { p_public_id: id });
  },

  /** Creates the learn item when `id` is null. */
  saveLearn(
    actorId: string,
    id: string | null,
    input: LearnInput,
    ctx: ClientContext,
  ): Promise<DbResult<{ id: string }>> {
    return callDb('app_admin_save_learn', {
      p_actor_id: actorId,
      p_public_id: id,
      p_item: input,
      p_ctx: ctx,
    });
  },

  deleteLearn(actorId: string, id: string, ctx: ClientContext): Promise<boolean> {
    return callDb('app_admin_delete_learn', { p_actor_id: actorId, p_public_id: id, p_ctx: ctx });
  },

  // ----- credits -----

  grantCredits(
    actorId: string,
    grant: {
      userId: string;
      delta: number;
      reason: string;
      idempotencyKey: string;
      requestHash: string;
    },
    ctx: ClientContext,
  ): Promise<DbResult<CreditGrant>> {
    return callDb('app_admin_grant_credits', {
      p_actor_id: actorId,
      p_public_id: grant.userId,
      p_delta: grant.delta,
      p_reason: grant.reason,
      p_idempotency_key: grant.idempotencyKey,
      p_request_hash: grant.requestHash,
      p_ctx: ctx,
    });
  },

  // ----- audit trail -----

  auditLogs(query: AuditLogsQuery): Promise<Page<AuditEntry>> {
    return callDb('app_admin_audit_logs', {
      p_action_patterns: actionPatterns(query.filter?.action),
      p_user: query.filter?.user ?? null,
      p_from: query.filter?.from ?? null,
      p_to: query.filter?.to ?? null,
      ...offset(query),
    });
  },
};
