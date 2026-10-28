import { callDb } from '../../lib/db';
import type { DbResult } from '../../lib/dbFunctions';
import { containsPattern, escapeLike } from '../../lib/http';
import type { Tier } from '../../lib/membership';
import type { ClientContext } from '../../middleware/requestContext';
import type { RepresentationTrackStatus, StaffRole } from '../../types/domain';
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

// Every admin write is one app_admin_* database function that also writes its audit entry. Their
// arguments and results are declared in src/lib/dbFunctions.ts and checked by callDb on every
// call. Expected failures come back as { error: CODE }; the service turns them into HTTP errors.

/** An expected failure reported by an app_admin_* function. */
export interface DbFailure {
  error: string;
  status?: string | undefined;
  balance?: number | undefined;
}

export function isDbError<T extends object>(result: T): result is Extract<T, { error: string }> {
  return 'error' in result;
}

/** A successful result of `fn`, without its { error } case and without null. */
type Ok<F extends Parameters<typeof callDb>[0]> = Exclude<
  NonNullable<DbResult<F>>,
  { error: string }
>;

export type Page<T> = { items: T[]; total: number };
export type UserListItem = DbResult<'app_admin_find_users'>['items'][number];
export type UserDetailRow = Ok<'app_admin_get_user'>;
export type KycDetailRow = Ok<'app_admin_get_kyc'>;
export type ModerationItemRow = Ok<'app_admin_moderation_item'>;
export type AdminCompany = Ok<'app_admin_get_company'>;
export type AdminIssuer = Ok<'app_admin_get_issuer'>;
export type AdminRepresentationDetail = Ok<'app_admin_get_representation'>;
export type AdminRoadshow = Ok<'app_admin_get_roadshow'>;
export type AdminQuestion = Ok<'app_admin_answer_question'>;
export type AdminLearnItem = Ok<'app_admin_get_learn'>;
export type CreditGrant = Ok<'app_admin_grant_credits'>;

/** What a user search matches on; at most one is set. */
export interface UserSearch {
  emailHash?: string;
  phoneHash?: string;
  publicId?: string;
  namePattern?: string;
}

/** Audit action filters as LIKE patterns: `admin.*` matches every action under admin. */
export function actionPatterns(actions: string[] | undefined): string[] | null {
  if (!actions?.length) return null;
  return actions.map((action) =>
    action.endsWith('.*') ? `${escapeLike(action.slice(0, -1))}%` : escapeLike(action),
  );
}

const offset = (query: { page: number; pageSize: number }) => ({
  p_limit: query.pageSize,
  p_offset: (query.page - 1) * query.pageSize,
});

const pattern = (q: string | undefined) => (q ? containsPattern(q) : null);

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export const adminRepository = {
  // ----- staff -----

  staffRoles(userId: string): Promise<StaffRole[]> {
    return callDb('app_admin_staff_roles', { p_user_id: userId });
  },

  // ----- users -----

  findUsers(search: UserSearch, query: ListUsersQuery) {
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

  findUser(publicId: string) {
    return callDb('app_admin_get_user', { p_public_id: publicId });
  },

  updateUser(
    actorId: string,
    publicId: string,
    changes: { tier?: Tier | undefined; status?: 'ACTIVE' | 'SUSPENDED' | undefined },
    reason: string,
    ctx: ClientContext,
  ) {
    return callDb('app_admin_update_user', {
      p_actor_id: actorId,
      p_public_id: publicId,
      p_changes: changes,
      p_reason: reason,
      p_ctx: ctx,
    });
  },

  setRoles(actorId: string, publicId: string, roles: StaffRole[], ctx: ClientContext) {
    return callDb('app_admin_set_roles', {
      p_actor_id: actorId,
      p_public_id: publicId,
      p_roles: roles,
      p_ctx: ctx,
    });
  },

  /** Null when the user does not exist. */
  userCredits(publicId: string, query: { page: number; pageSize: number }) {
    return callDb('app_admin_user_credits', { p_public_id: publicId, ...offset(query) });
  },

  // ----- KYC -----

  findKyc(query: ListKycQuery) {
    return callDb('app_admin_find_kyc', {
      p_statuses: query.filter?.status ?? ['PENDING'],
      p_tiers: query.filter?.tier ?? null,
      ...offset(query),
    });
  },

  findKycSubmission(publicId: string) {
    return callDb('app_admin_get_kyc', { p_public_id: publicId });
  },

  decideKyc(
    actorId: string,
    publicId: string,
    decision: 'APPROVE' | 'REJECT',
    reason: string | null,
    ctx: ClientContext,
  ) {
    return callDb('app_admin_decide_kyc', {
      p_actor_id: actorId,
      p_public_id: publicId,
      p_decision: decision,
      p_reason: reason,
      p_ctx: ctx,
    });
  },

  // ----- moderation -----

  moderationQueue(query: ModerationQueueQuery) {
    return callDb('app_admin_moderation_queue', {
      p_types: query.filter?.type ?? null,
      p_statuses: query.filter?.status ?? ['PENDING_MODERATION'],
      ...offset(query),
    });
  },

  moderationItem(type: ModerationType, id: string) {
    return callDb('app_admin_moderation_item', { p_type: type, p_id: id });
  },

  moderate(actorId: string, id: string, input: ModerationDecisionInput, ctx: ClientContext) {
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

  findCompanies(query: ListCompaniesQuery) {
    return callDb('app_admin_find_companies', {
      p_q_pattern: pattern(query.q),
      p_asset_classes: query.filter?.assetClass ?? null,
      p_countries: query.filter?.country ?? null,
      p_verified: query.filter?.verified ?? null,
      p_include_deleted: query.filter?.deleted ?? false,
      ...offset(query),
    });
  },

  findCompany(id: string) {
    return callDb('app_admin_get_company', { p_id: id });
  },

  /** Creates the company when `id` is null. */
  saveCompany(actorId: string, id: string | null, input: CompanyInput, ctx: ClientContext) {
    return callDb('app_admin_save_company', {
      p_actor_id: actorId,
      p_id: id,
      p_company: input,
      p_ctx: ctx,
    });
  },

  deleteCompany(actorId: string, id: string, ctx: ClientContext) {
    return callDb('app_admin_delete_company', { p_actor_id: actorId, p_id: id, p_ctx: ctx });
  },

  // ----- issuers -----

  findIssuers(query: ListIssuersAdminQuery) {
    return callDb('app_admin_find_issuers', {
      p_q_pattern: pattern(query.q),
      p_asset_types: query.filter?.assetType ?? null,
      p_listed: query.filter?.listed ?? null,
      p_include_deleted: query.filter?.deleted ?? false,
      ...offset(query),
    });
  },

  findIssuer(id: string) {
    return callDb('app_admin_get_issuer', { p_id: id });
  },

  /** Creates the issuer when `id` is null. */
  saveIssuer(actorId: string, id: string | null, input: IssuerInput, ctx: ClientContext) {
    return callDb('app_admin_save_issuer', {
      p_actor_id: actorId,
      p_id: id,
      p_issuer: input,
      p_ctx: ctx,
    });
  },

  deleteIssuer(actorId: string, id: string, ctx: ClientContext) {
    return callDb('app_admin_delete_issuer', { p_actor_id: actorId, p_id: id, p_ctx: ctx });
  },

  // ----- representations -----

  findRepresentations(query: ListRepresentationsAdminQuery) {
    return callDb('app_admin_find_representations', {
      p_q_pattern: pattern(query.q),
      p_statuses: query.filter?.status ?? null,
      p_countries: query.filter?.country ?? null,
      p_include_deleted: query.filter?.deleted ?? false,
      ...offset(query),
    });
  },

  findRepresentation(id: string) {
    return callDb('app_admin_get_representation', { p_public_id: id });
  },

  /** Creates the petition when `id` is null. */
  saveRepresentation(
    actorId: string,
    id: string | null,
    input: RepresentationInput,
    ctx: ClientContext,
  ) {
    return callDb('app_admin_save_representation', {
      p_actor_id: actorId,
      p_public_id: id,
      p_representation: input,
      p_ctx: ctx,
    });
  },

  deleteRepresentation(actorId: string, id: string, ctx: ClientContext) {
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
  ) {
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
  ) {
    return callDb('app_admin_add_representation_documents', {
      p_actor_id: actorId,
      p_public_id: id,
      p_documents: documents,
      p_ctx: ctx,
    });
  },

  // ----- roadshows and questions -----

  findRoadshows(query: ListRoadshowsAdminQuery) {
    return callDb('app_admin_find_roadshows', {
      p_q_pattern: pattern(query.q),
      p_issuer_id: query.filter?.issuer ?? null,
      // Archived roadshows only when asked for.
      p_statuses: query.filter?.status ?? ['DRAFT', 'PUBLISHED'],
      p_open: query.filter?.open ?? null,
      ...offset(query),
    });
  },

  findRoadshow(id: string) {
    return callDb('app_admin_get_roadshow', { p_id: id });
  },

  /** Creates the roadshow when `id` is null. */
  saveRoadshow(actorId: string, id: string | null, input: RoadshowInput, ctx: ClientContext) {
    return callDb('app_admin_save_roadshow', {
      p_actor_id: actorId,
      p_id: id,
      p_roadshow: input,
      p_ctx: ctx,
    });
  },

  archiveRoadshow(actorId: string, id: string, ctx: ClientContext) {
    return callDb('app_admin_archive_roadshow', { p_actor_id: actorId, p_id: id, p_ctx: ctx });
  },

  /** Null when the roadshow does not exist. */
  findQuestions(roadshowId: string, query: ListQuestionsQuery) {
    return callDb('app_admin_roadshow_questions', {
      p_id: roadshowId,
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
    answer: { answer: string; featured?: boolean | undefined },
    ctx: ClientContext,
  ) {
    return callDb('app_admin_answer_question', {
      p_actor_id: actorId,
      p_roadshow_id: roadshowId,
      p_question_id: questionId,
      p_answer: answer.answer,
      p_featured: answer.featured ?? null,
      p_ctx: ctx,
    });
  },

  // ----- learn -----

  findLearn(query: ListLearnAdminQuery) {
    return callDb('app_admin_find_learn', {
      p_q_pattern: pattern(query.q),
      p_formats: query.filter?.format ?? null,
      p_access: query.filter?.access ?? null,
      // Archived items only when asked for.
      p_statuses: query.filter?.status ?? ['DRAFT', 'PUBLISHED'],
      ...offset(query),
    });
  },

  findLearnItem(id: string) {
    return callDb('app_admin_get_learn', { p_id: id });
  },

  /** Creates the learn item when `id` is null. */
  saveLearn(actorId: string, id: string | null, input: LearnInput, ctx: ClientContext) {
    return callDb('app_admin_save_learn', {
      p_actor_id: actorId,
      p_id: id,
      p_item: input,
      p_ctx: ctx,
    });
  },

  archiveLearn(actorId: string, id: string, ctx: ClientContext) {
    return callDb('app_admin_archive_learn', { p_actor_id: actorId, p_id: id, p_ctx: ctx });
  },

  // ----- credits and audit trail -----

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
  ) {
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

  auditLogs(query: AuditLogsQuery) {
    return callDb('app_admin_audit_logs', {
      p_action_patterns: actionPatterns(query.filter?.action),
      p_user: query.filter?.user ?? null,
      p_from: query.filter?.from ?? null,
      p_to: query.filter?.to ?? null,
      ...offset(query),
    });
  },
};
