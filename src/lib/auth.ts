import { AppError } from '../middleware/errorHandler';
import { callDb } from './db';
import type { Member } from './membership';
import { verifyAccessToken } from './tokens';

export const authProvider = {
  // Checks the JWT and then the database on every request, so logout, revoked devices, password
  // resets and suspensions take effect immediately instead of when the token expires.
  async loadMember(accessToken: string): Promise<Member> {
    const claims = verifyAccessToken(accessToken);
    const member = await callDb<Member | null>('app_member', {
      p_user_public_id: claims.userPublicId,
      p_session_public_id: claims.sessionPublicId,
    });
    if (!member) throw new AppError(401, 'UNAUTHENTICATED', 'Your session has ended. Please log in again.');
    return member;
  },
};
