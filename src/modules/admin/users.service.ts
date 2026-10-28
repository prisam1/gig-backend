import { decrypt, keyedHash } from '../../lib/crypto';
import { callDb } from '../../lib/db';
import type { DbResult } from '../../lib/dbFunctions';
import { containsPattern } from '../../lib/http';
import type { Member } from '../../lib/membership';
import { AppError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import type { StaffRole } from '../../types/domain';
import { COUNTRY_CODES, identifierSchema, normalizePhone } from '../auth/auth.schemas';
import { permissionsOf } from './admin.access';
import type { ListUsersQuery, UpdateUserInput } from './admin.schemas';
import { limitOffset, notFound, pageMeta, selfAction, unexpected } from './admin.shared';

// Email and phone are stored encrypted with keyed hashes for lookup, so a member is found by an
// exact email or phone (hashed here the way sign-up hashes them) or by part of their name.
function searchArgs(q: string | undefined) {
  const none = { p_q_pattern: null, p_email_hash: null, p_phone_hash: null };
  if (!q) return none;

  const identifier = identifierSchema.safeParse(q);
  if (identifier.success) {
    return identifier.data.channel === 'EMAIL'
      ? { ...none, p_email_hash: keyedHash('email', identifier.data.value) }
      : { ...none, p_phone_hash: keyedHash('phone', identifier.data.value) };
  }
  // A national number without its country code: try each launch market.
  for (const code of COUNTRY_CODES) {
    const phone = normalizePhone(code, q);
    if (phone) return { ...none, p_phone_hash: keyedHash('phone', phone) };
  }
  return { ...none, p_q_pattern: containsPattern(q) };
}

export async function listUsers(query: ListUsersQuery) {
  const result = await callDb('app_admin_find_users', {
    ...searchArgs(query.q),
    p_tiers: query.filter?.tier ?? null,
    p_kyc_statuses: query.filter?.kycStatus ?? null,
    p_statuses: query.filter?.status ?? null,
    p_staff_only: query.filter?.staff ?? false,
    ...limitOffset(query),
  });
  return { items: result.items, meta: pageMeta(query, result.total) };
}

/** One account with its contact details. Every view is recorded in the audit log. */
export async function getUser(actor: Member, userId: string, ctx: ClientContext) {
  const row = await callDb('app_admin_get_user', {
    p_actor_id: actor.userId,
    p_user_public_id: userId,
    p_ctx: ctx,
  });
  if (!row) throw notFound('User');

  const { emailEnc, phoneEnc, ...user } = row;
  return {
    ...user,
    email: decrypt(emailEnc, 'email'),
    phone: decrypt(phoneEnc, 'phone'),
    permissions: permissionsOf(user.roles),
  };
}

type WriteFailure = Extract<
  DbResult<'app_admin_update_user'> | DbResult<'app_admin_set_roles'>,
  { error: string }
>;

function userWriteError(fn: string, result: WriteFailure): Error {
  switch (result.error) {
    case 'NOT_FOUND':
      return notFound('User');
    case 'SELF_ACTION':
      return selfAction();
    case 'USER_DELETED':
      return new AppError(409, 'USER_DELETED', 'This account has been deleted');
    default:
      return unexpected(fn, result);
  }
}

/** Changes a member's tier and/or suspends or reactivates the account. */
export async function updateUser(
  actor: Member,
  userId: string,
  input: UpdateUserInput,
  ctx: ClientContext,
) {
  const result = await callDb('app_admin_update_user', {
    p_actor_id: actor.userId,
    p_user_public_id: userId,
    p_tier: input.tier ?? null,
    p_status: input.status ?? null,
    p_reason: input.reason,
    p_ctx: ctx,
  });
  if ('error' in result) throw userWriteError('app_admin_update_user', result);
  return result.user;
}

/** Replaces a member's staff roles. */
export async function setRoles(
  actor: Member,
  userId: string,
  roles: StaffRole[],
  ctx: ClientContext,
) {
  const result = await callDb('app_admin_set_roles', {
    p_actor_id: actor.userId,
    p_user_public_id: userId,
    p_roles: roles,
    p_ctx: ctx,
  });
  if ('error' in result) throw userWriteError('app_admin_set_roles', result);
  return { id: userId, roles: result.roles, permissions: permissionsOf(result.roles) };
}
