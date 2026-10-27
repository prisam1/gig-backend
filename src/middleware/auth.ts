import type { Request, RequestHandler } from 'express';
import { sql } from '../lib/db';
import { verifyAccessToken } from '../lib/tokens';
import type { Tier } from '../modules/users/users.service';
import { AppError } from './errorHandler';

export interface AuthContext {
  userId: string;
  userPublicId: string;
  sessionId: string;
  sessionPublicId: string;
  tier: Tier;
  kycStatus: string;
}

// Checks the JWT and then the database on every request, so logout, revoked devices, password
// resets and suspensions take effect immediately instead of when the token expires.
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(req.get('authorization') ?? '');
  if (!match?.[1]) throw new AppError(401, 'UNAUTHORIZED', 'Sign in to continue');

  const claims = verifyAccessToken(match[1]);
  const [row] = await sql<AuthContext[]>`
    select u.id as user_id, u.public_id as user_public_id, s.id as session_id,
           s.public_id as session_public_id, u.tier, u.kyc_status
    from app.user_sessions s
    join app.users u on u.id = s.user_id
    where s.public_id = ${claims.sessionPublicId} and u.public_id = ${claims.userPublicId}
      and s.revoked_at is null and s.expires_at > now() and s.absolute_expires_at > now()
      and u.status = 'ACTIVE'`;
  if (!row) throw new AppError(401, 'UNAUTHORIZED', 'Your session has ended. Please log in again.');

  req.auth = row;
  next();
};

export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Sign in to continue');
  return req.auth;
}
