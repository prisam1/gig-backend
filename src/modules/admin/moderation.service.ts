import { callDb } from '../../lib/db';
import type { Member } from '../../lib/membership';
import { createSignedDownload, fileNameOf } from '../../lib/storage';
import { AppError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import type { ModerationType } from '../../types/domain';
import type { ModerationDecisionInput, ModerationQueueQuery } from './admin.schemas';
import { limitOffset, notFound, pageMeta, selfAction, unexpected } from './admin.shared';

/** Reviews, ratings, roadshow questions and offers waiting for a decision, oldest first. */
export async function listModerationQueue(query: ModerationQueueQuery) {
  const result = await callDb('app_admin_moderation_queue', {
    p_types: query.filter?.type ?? null,
    p_statuses: query.filter?.status ?? ['PENDING'],
    ...limitOffset(query),
  });
  return { items: result.items, meta: pageMeta(query, result.total) };
}

/** One item in full. A review's evidence comes with 5-minute download links. */
export async function getModerationItem(type: ModerationType, id: string) {
  const item = await callDb('app_admin_moderation_item', { p_type: type, p_id: id });
  if (!item) throw notFound('Item');
  if (item.type !== 'REVIEW') return item;

  const evidence = await Promise.all(
    item.content.evidence.map(async (file) => ({
      ...file,
      download: await createSignedDownload('review-evidence', file.path, fileNameOf(file.path)),
    })),
  );
  return { ...item, content: { ...item.content, evidence } };
}

export async function decideModeration(
  actor: Member,
  id: string,
  input: ModerationDecisionInput,
  ctx: ClientContext,
) {
  const result = await callDb('app_admin_moderate', {
    p_actor_id: actor.userId,
    p_type: input.type,
    p_id: id,
    p_decision: input.decision,
    p_note: input.note ?? null,
    p_ctx: ctx,
  });
  if ('error' in result) {
    switch (result.error) {
      case 'NOT_FOUND':
        throw notFound('Item');
      case 'SELF_ACTION':
        throw selfAction();
      case 'INVALID_TRANSITION':
        throw new AppError(
          409,
          'INVALID_TRANSITION',
          `${input.decision} does not apply to an item that is ${result.status ?? 'in this state'}`,
        );
      default:
        throw unexpected('app_admin_moderate', result);
    }
  }
  return {
    type: result.type,
    id: result.id,
    decision: input.decision,
    status: result.status,
    previousStatus: result.previousStatus,
  };
}
