import type { Request, RequestHandler } from 'express';
import { callDb } from '../../lib/db';
import { getAuth } from '../../middleware/auth';
import { HttpError } from '../../middleware/errorHandler';
import type { StaffRole } from '../../types/domain';

// Staff access is the second axis next to membership tier: a staff member is a signed-in account
// with one or more roles in app.user_roles. Each admin route names the permission it needs; this
// table is the single place that says which roles hold it.
export const PERMISSIONS = {
  /** Search members and see one member's account, contact details included (audited). */
  'users.read': ['ADMIN', 'SUPPORT'],
  /** Change a member's tier, suspend or reactivate an account. */
  'users.manage': ['ADMIN'],
  /** Grant and revoke staff roles. */
  'roles.manage': ['ADMIN'],
  /** KYC queue, documents and approve / reject decisions. */
  'kyc.review': ['ADMIN', 'SUPPORT'],
  /** See the moderation queue. */
  'moderation.read': ['ADMIN', 'MODERATOR', 'ANALYST'],
  /** Approve, reject, request changes on or take down reviews, ratings, questions and offers. */
  'moderation.decide': ['ADMIN', 'MODERATOR'],
  /** Read the content catalog as staff see it (drafts, archived and deleted items included). */
  'content.read': ['ADMIN', 'MODERATOR', 'ANALYST', 'SUPPORT'],
  /** Create, edit and delete companies, issuers, petitions, roadshows and learn content. */
  'content.manage': ['ADMIN'],
  /** Move a petition along its track, attach documents, remove fraudulent signatures. */
  'representations.track': ['ADMIN', 'MODERATOR'],
  /** Publish the issuer's answers to Ask Me Anything questions. */
  'questions.answer': ['ADMIN', 'MODERATOR'],
  /** Grant and revoke member credits. */
  'credits.manage': ['ADMIN'],
  /** Read the audit trail. */
  'audit.read': ['ADMIN'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function permissionsOf(roles: readonly StaffRole[]): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((permission) =>
    (PERMISSIONS[permission] as readonly StaffRole[]).some((role) => roles.includes(role)),
  );
}

/** The signed-in staff member's roles, loaded by `requireStaff`. */
export function staffRoles(req: Request): StaffRole[] {
  if (!req.staffRoles) throw new HttpError(403, 'Staff access required');
  return req.staffRoles;
}

/**
 * Any staff role. Use after `requireAuth`. Roles are read on every request, so revoking one (or
 * suspending the account) takes effect at once.
 */
export const requireStaff: RequestHandler = async (req, _res, next) => {
  const roles = await callDb('app_staff_roles', { p_user_id: getAuth(req).userId });
  if (roles.length === 0) throw new HttpError(403, 'Staff access required');
  req.staffRoles = roles;
  next();
};

/** Throws 403 unless the staff member holds `permission`. */
export function assertPermission(req: Request, permission: Permission): void {
  if (!permissionsOf(staffRoles(req)).includes(permission)) {
    throw new HttpError(403, 'Your staff role does not allow this', { code: 'INSUFFICIENT_ROLE' });
  }
}

/** Route guard for one permission. Use after `requireStaff`. */
export function can(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    assertPermission(req, permission);
    next();
  };
}
