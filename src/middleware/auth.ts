import type { JwtPayload } from '@supabase/supabase-js';
import type { Request, RequestHandler } from 'express';
import { loadMembership, type KycStatus, type Tier } from '../lib/membership';
import { supabaseAdmin } from '../lib/supabase';
import { HttpError } from './errorHandler';

export interface AuthUser {
  id: string;
  tier: Tier;
  kycStatus: KycStatus;
  fullName: string;
  /** Prive with approved KYC: the "Prive" access level in the API spec. */
  isVerifiedPrive: boolean;
  /** Prive (verified) or Institutional: may see full analytics and full reviews. */
  hasFullAccess: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

async function verifyToken(token: string): Promise<JwtPayload> {
  const invalid = new HttpError(401, 'Invalid or expired access token');
  // getClaims throws (rather than returning an error) on tokens that cannot be decoded.
  const result = await supabaseAdmin.auth.getClaims(token).catch(() => null);
  if (!result || result.error || !result.data) throw invalid;
  return result.data.claims;
}

async function resolveUser(token: string): Promise<AuthUser> {
  const claims = await verifyToken(token);
  const { tier, kycStatus, fullName } = await loadMembership(claims.sub, claims);

  const isVerifiedPrive = tier === 'PRIVE' && kycStatus === 'APPROVED';
  return {
    id: claims.sub,
    tier,
    kycStatus,
    fullName,
    isVerifiedPrive,
    hasFullAccess: isVerifiedPrive || tier === 'INSTITUTIONAL',
  };
}

/** Attaches `req.user` when a valid bearer token is sent; public routes still work without one. */
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  const token = bearerToken(req);
  if (token) req.user = await resolveUser(token);
  next();
};

/** Any signed-in tier ("User" access). */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, 'Sign in required');
  req.user = await resolveUser(token);
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

/** The signed-in user on routes guarded by `requireAuth`. */
export function authUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'Sign in required');
  return req.user;
}
