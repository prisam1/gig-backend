import type { Request, RequestHandler } from 'express';
import { getAuth } from '../../middleware/auth';
import { HttpError } from '../../middleware/errorHandler';
import type { StaffRole } from '../../types/domain';
import { adminRepository } from './admin.repository';

// Staff roles are a second axis next to the membership tier: a Prive investor is not staff, and
// staff need no particular tier. Each admin route names the permission it needs; this table says
// which roles hold it.
export const PERMISSIONS = {
  /** Search users and see their account, KYC and activity (no contact details). */
  'users.read': ['ADMIN', 'MODERATOR', 'ANALYST', 'SUPPORT'],
  /** See a user's email and phone. Each view is audited. */
  'users.contact': ['ADMIN', 'SUPPORT'],
  /** Change a user's tier, suspend or reactivate them. */
  'users.write': ['ADMIN'],
  'roles.write': ['ADMIN'],
  /** The KYC queue and documents. Opening a submission is audited. */
  'kyc.read': ['ADMIN', 'MODERATOR', 'SUPPORT'],
  'kyc.decide': ['ADMIN', 'MODERATOR'],
  moderation: ['ADMIN', 'MODERATOR'],
  'content.read': ['ADMIN', 'MODERATOR', 'ANALYST', 'SUPPORT'],
  /** Companies, issuers and representations, including the petition track and its documents. */
  'content.write': ['ADMIN'],
  'credits.grant': ['ADMIN'],
  'audit.read': ['ADMIN'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(roles: readonly StaffRole[], permission: Permission): boolean {
  const allowed: readonly StaffRole[] = PERMISSIONS[permission];
  return roles.some((role) => allowed.includes(role));
}

export function permissionsOf(roles: readonly StaffRole[]): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => hasPermission(roles, p));
}

/** Staff only. Loads the signed-in user's roles; use after `requireAuth`. */
export const requireStaff: RequestHandler = async (req, _res, next) => {
  const roles = await adminRepository.staffRoles(getAuth(req).userId);
  if (roles.length === 0) throw new HttpError(403, 'GIG staff only', { code: 'STAFF_ONLY' });
  req.staffRoles = roles;
  next();
};

/** One permission from the table above. Use after `requireStaff`. */
export function allow(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!hasPermission(staffRoles(req), permission)) {
      throw new HttpError(403, 'Your staff role does not allow this', { code: 'ROLE_FORBIDDEN' });
    }
    next();
  };
}

/** The signed-in staff member's roles on routes guarded by `requireStaff`. */
export function staffRoles(req: Request): StaffRole[] {
  if (!req.staffRoles) throw new HttpError(403, 'GIG staff only', { code: 'STAFF_ONLY' });
  return req.staffRoles;
}
