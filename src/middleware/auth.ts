import type { Request, RequestHandler } from 'express';
import { loadMember, type KycStatus, type Member, type Tier } from '../lib/membership';
import { HttpError } from './errorHandler';

export type AuthContext = Member;

/** The signed-in user as the catalog and reviews modules see it. */
export interface AuthUser {
  /** app.users.public_id */
  id: string;
  tier: Tier;
  kycStatus: KycStatus;
  fullName: string;
  /** Prive with approved KYC: the "Prive" access level in the API spec. */
  isVerifiedPrive: boolean;
  /** Prive (verified) or Institutional: may see full analytics and full reviews. */
  hasFullAccess: boolean;
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

async function authenticate(req: Request, token: string): Promise<void> {
  const member = await loadMember(token);
  const isVerifiedPrive = member.tier === 'PRIVE' && member.kycStatus === 'APPROVED';
  req.auth = member;
  req.user = {
    id: member.userPublicId,
    tier: member.tier,
    kycStatus: member.kycStatus,
    fullName: member.fullName,
    isVerifiedPrive,
    hasFullAccess: isVerifiedPrive || member.tier === 'INSTITUTIONAL',
  };
}

/** Attaches the user when a bearer token is sent; public routes still work without one. */
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  const token = bearerToken(req);
  if (token) await authenticate(req, token);
  next();
};

/** Any signed-in tier ("User" access). */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, 'Sign in to continue');
  await authenticate(req, token);
  next();
};

/** Prive membership with approved KYC ("Prive" access). Use after `requireAuth`. */
export const requireVerifiedPrive: RequestHandler = (req, _res, next) => {
  const user = authUser(req);
  if (user.tier !== 'PRIVE') throw new HttpError(403, 'Prive membership required');
  if (!user.isVerifiedPrive) {
    throw new HttpError(403, 'KYC verification required', { code: 'KYC_REQUIRED' });
  }
  next();
};

/** Prive (verified) or Institutional. Use after `requireAuth`. */
export const requireFullAccess: RequestHandler = (req, _res, next) => {
  const user = authUser(req);
  if (!user.hasFullAccess) {
    throw new HttpError(403, 'Available to verified Prive and Institutional members');
  }
  next();
};

/** The signed-in session and user on routes guarded by `requireAuth`. */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw new HttpError(401, 'Sign in to continue');
  return req.auth;
}

/** The signed-in user on routes guarded by `requireAuth`. */
export function authUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'Sign in to continue');
  return req.user;
}
