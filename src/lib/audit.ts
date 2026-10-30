import type { ClientContext } from '../middleware/requestContext';
import { callDb } from './db';

export type AuditAction =
  | 'auth.register.started'
  | 'auth.register.completed'
  | 'auth.login.succeeded'
  | 'auth.login.failed'
  | 'auth.otp.failed'
  | 'auth.refresh.reuse_detected'
  | 'auth.logout'
  | 'auth.password.reset_requested'
  | 'auth.password.reset'
  | 'user.profile.updated'
  | 'user.tier.selected'
  | 'file.upload_url.created'
  | 'kyc.submitted'
  | 'rating.submitted'
  | 'representation.signed'
  // Admin actions written by the API. KYC decisions, moderation, user and role changes, credit
  // grants, petition tracking and answers are audited inside their app_admin_* functions.
  | `admin.${'company' | 'issuer' | 'roadshow' | 'learn'}.${'created' | 'updated' | 'deleted'}`
  | 'admin.roadshow.financials_replaced'
  | 'admin.roadshow.document_added'
  | 'admin.roadshow.document_removed'
  | 'admin.kyc.viewed'
  | 'admin.upload_url.created';

// Append-only: the table rejects UPDATE and DELETE. Never put raw PII in metadata.
// Multi-step operations write their audit entry inside their own database function.
export async function audit(
  ctx: ClientContext,
  action: AuditAction,
  details: { userId?: string | null; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  await callDb('app_audit', {
    p_ctx: ctx,
    p_action: action,
    p_user_id: details.userId ?? null,
    p_metadata: details.metadata ?? {},
  });
}
