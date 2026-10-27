import type { AuthContext, AuthUser } from '../middleware/auth';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      user?: AuthUser;
    }
  }
}

export {};
