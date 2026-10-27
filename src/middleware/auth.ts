import type { Request, RequestHandler } from 'express';
import { authProvider } from '../lib/auth';
import { hasFullAccess, isVerifiedPrive } from '../lib/membership';
import { usersRepository, type User } from '../modules/users/users.repository';
import { HttpError } from './errorHandler';

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

async function signIn(req: Request, token: string): Promise<void> {
  const identity = await authProvider.verifyAccessToken(token);
  if (!identity) {
    throw new HttpError(401, 'Invalid or expired token');
  }

  const user = await usersRepository.findOrCreateByIdentity(identity);
  if (user.status === 'SUSPENDED') {
    throw new HttpError(403, 'Account suspended', { code: 'ACCOUNT_SUSPENDED' });
  }

  req.user = user;
}

/** Requires a valid Bearer token and loads the matching GIG user onto `req.user` ("User" access). */
export const requireUser: RequestHandler = async (req, _res, next) => {
  const token = bearerToken(req);
  if (!token) {
    throw new HttpError(401, 'Missing bearer token');
  }
  await signIn(req, token);
  next();
};

/** Loads the user when a Bearer token is sent; public routes still work without one. */
export const optionalUser: RequestHandler = async (req, _res, next) => {
  const token = bearerToken(req);
  if (token) await signIn(req, token);
  next();
};

/** Prive membership with approved KYC ("Prive" access). Use after `requireUser`. */
export const requireVerifiedPrive: RequestHandler = (req, _res, next) => {
  const user = currentUser(req);
  if (user.tier !== 'PRIVE') throw new HttpError(403, 'Prive membership required');
  if (!isVerifiedPrive(user)) {
    throw new HttpError(403, 'KYC verification required', { code: 'KYC_REQUIRED' });
  }
  next();
};

/** Prive (verified) or Institutional ("Full" access). Use after `requireUser`. */
export const requireFullAccess: RequestHandler = (req, _res, next) => {
  if (!hasFullAccess(currentUser(req))) {
    throw new HttpError(403, 'Available to verified Prive and Institutional members');
  }
  next();
};

/** The signed-in user; only call from routes behind `requireUser`. */
export function currentUser(req: Request): User {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  return req.user;
}
