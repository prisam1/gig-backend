import type { AuthContext, AuthUser } from '../middleware/auth';
import type { StaffRole } from './domain';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      user?: AuthUser;
      /** Set on /admin routes by requireStaff. */
      staffRoles?: StaffRole[];
    }
  }
}

export {};
