import type { Request, RequestHandler } from 'express';
import { authProvider } from '../lib/auth';
import { usersRepository, type User } from '../modules/users/users.repository';
import { HttpError } from './errorHandler';

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

/** Requires a valid Bearer token and loads the matching GIG user onto `req.user`. */
export const requireUser: RequestHandler = async (req, _res, next) => {
  const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
  if (scheme !== 'Bearer' || !token) {
    throw new HttpError(401, 'Missing bearer token');
  }

  const identity = await authProvider.verifyAccessToken(token);
  if (!identity) {
    throw new HttpError(401, 'Invalid or expired token');
  }

  const user = await usersRepository.findOrCreateByIdentity(identity);
  if (user.status === 'SUSPENDED') {
    throw new HttpError(403, 'Account suspended', 'ACCOUNT_SUSPENDED');
  }

  req.user = user;
  next();
};

/** The signed-in user; only call from routes behind `requireUser`. */
export function currentUser(req: Request): User {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  return req.user;
}
