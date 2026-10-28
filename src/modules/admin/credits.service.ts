import { callDb, isUniqueViolationOf } from '../../lib/db';
import { hashRequest } from '../../lib/idempotency';
import type { Member } from '../../lib/membership';
import { AppError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import type { CreditChangeInput } from './admin.schemas';
import { notFound, selfAction, unexpected } from './admin.shared';

/**
 * Grants (positive delta) or revokes (negative delta) a member's credits. The Idempotency-Key is
 * scoped to the staff member: a retry with the same key and body returns the first result with
 * `replayed: true`; the same key with another body is refused.
 */
export async function changeCredits(
  actor: Member,
  input: CreditChangeInput,
  idempotencyKey: string,
  ctx: ClientContext,
) {
  const args = {
    p_actor_id: actor.userId,
    p_user_public_id: input.userId,
    p_delta: input.delta,
    p_note: input.note,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest(input),
    p_ctx: ctx,
  };

  let result;
  try {
    result = await callDb('app_admin_credit_change', args);
  } catch (error) {
    // Two requests with one key raced; the other one committed first, so this call replays it.
    if (!isUniqueViolationOf(error, 'admin_requests_pkey')) throw error;
    result = await callDb('app_admin_credit_change', args);
  }

  if ('error' in result) {
    switch (result.error) {
      case 'NOT_FOUND':
        throw notFound('User');
      case 'SELF_ACTION':
        throw selfAction();
      case 'INSUFFICIENT_CREDITS':
        throw new AppError(
          409,
          'INSUFFICIENT_CREDITS',
          'The member has fewer credits than you are revoking',
        );
      case 'IDEMPOTENCY_CONFLICT':
        throw new AppError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This Idempotency-Key was already used for a different request',
        );
      default:
        throw unexpected('app_admin_credit_change', result);
    }
  }
  return { entry: result.entry, replayed: result.replayed };
}
