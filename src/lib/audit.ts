import type { ClientContext } from '../middleware/requestContext';
import { sql, type Db } from './db';

export type AuditAction =
  | 'auth.register.started'
  | 'auth.register.completed'
  | 'auth.login.succeeded'
  | 'auth.login.failed'
  | 'auth.otp.failed'
  | 'auth.otp.login'
  | 'auth.refresh.reuse_detected'
  | 'auth.logout'
  | 'auth.session.revoked'
  | 'auth.password.reset_requested'
  | 'auth.password.reset'
  | 'user.profile.updated'
  | 'user.preferences.updated'
  | 'user.tier.selected'
  | 'user.followed'
  | 'user.unfollowed'
  | 'file.upload_url.created'
  | 'kyc.submitted'
  | 'rating.submitted'
  | 'representation.signed';

// Append-only: the table rejects UPDATE and DELETE. Never put raw PII in metadata.
export async function audit(
  ctx: ClientContext,
  action: AuditAction,
  details: { userId?: string | null; metadata?: Record<string, unknown> } = {},
  db: Db = sql,
): Promise<void> {
  await db`
    insert into app.audit_logs (action, actor_user_id, ip, user_agent, request_id, metadata)
    values (${action}, ${details.userId ?? null}, ${ctx.ip}, ${ctx.userAgent}, ${ctx.requestId},
            ${db.json((details.metadata ?? {}) as never)})`;
}
