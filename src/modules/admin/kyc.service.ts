import { audit } from '../../lib/audit';
import { callDb } from '../../lib/db';
import type { Member } from '../../lib/membership';
import { createSignedDownload, fileNameOf } from '../../lib/storage';
import { AppError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import type { ListKycQuery } from './admin.schemas';
import { limitOffset, notFound, pageMeta, selfAction, unexpected } from './admin.shared';

export async function listKycSubmissions(query: ListKycQuery) {
  const result = await callDb('app_admin_kyc_queue', {
    p_statuses: query.filter?.status ?? ['PENDING'],
    p_tiers: query.filter?.tier ?? null,
    p_oldest_first: query.sort === 'oldest',
    ...limitOffset(query),
  });
  return { items: result.items, meta: pageMeta(query, result.total) };
}

/**
 * One submission with 5-minute download links for its documents. Files the virus scan flagged
 * are listed without a link. Opening a member's identity documents is recorded in the audit log.
 */
export async function getKycSubmission(actor: Member, submissionId: string, ctx: ClientContext) {
  const submission = await callDb('app_admin_kyc_get', { p_submission_id: submissionId });
  if (!submission) throw notFound('KYC submission');

  const documents = await Promise.all(
    submission.documents.map(async ({ bucket, objectKey, ...doc }) => ({
      ...doc,
      download:
        doc.scanStatus === 'INFECTED'
          ? null
          : await createSignedDownload(bucket, objectKey, fileNameOf(objectKey)),
    })),
  );
  await audit(ctx, 'admin.kyc.viewed', {
    userId: actor.userId,
    metadata: { submission: submissionId, user: submission.user.id },
  });
  return { ...submission, documents };
}

/** Approves (granting the submitted tier) or rejects a pending submission. */
export async function decideKyc(
  actor: Member,
  submissionId: string,
  decision: { decision: 'APPROVE' } | { decision: 'REJECT'; reason: string },
  ctx: ClientContext,
) {
  const result = await callDb('app_admin_kyc_decide', {
    p_actor_id: actor.userId,
    p_submission_id: submissionId,
    p_decision: decision.decision,
    p_reason: decision.decision === 'REJECT' ? decision.reason : null,
    p_ctx: ctx,
  });
  if ('error' in result) {
    switch (result.error) {
      case 'NOT_FOUND':
        throw notFound('KYC submission');
      case 'SELF_ACTION':
        throw selfAction();
      case 'ALREADY_DECIDED':
        throw new AppError(
          409,
          'KYC_ALREADY_DECIDED',
          `This submission is already ${result.status?.toLowerCase() ?? 'decided'}`,
        );
      default:
        throw unexpected('app_admin_kyc_decide', result);
    }
  }
  return { id: submissionId, status: result.status, user: result.user };
}
