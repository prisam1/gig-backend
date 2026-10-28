import { callDb } from '../../lib/db';
import { escapeLike } from '../../lib/http';
import type { AuditLogsQuery } from './admin.schemas';
import { limitOffset, pageMeta } from './admin.shared';

/** The append-only audit trail, newest first. */
export async function listAuditLogs(query: AuditLogsQuery) {
  const filter = query.filter;
  const result = await callDb('app_admin_audit_logs', {
    p_actions: filter?.action ?? null,
    p_action_prefix: filter?.actionPrefix ? `${escapeLike(filter.actionPrefix)}%` : null,
    p_actor_public_id: filter?.actorId ?? null,
    p_from: filter?.from ?? null,
    p_to: filter?.to ?? null,
    ...limitOffset(query),
  });
  return { items: result.items, meta: pageMeta(query, result.total) };
}
