import { AppError } from '../middleware/errorHandler';
import { sql } from './db';
import type { Member } from './membership';
import { verifyAccessToken } from './tokens';

export const authProvider = {
  // Checks the JWT and then the database on every request, so logout, revoked devices, password
  // resets and suspensions take effect immediately instead of when the token expires.
  async loadMember(accessToken: string): Promise<Member> {
    const claims = verifyAccessToken(accessToken);
    const [row] = await sql<Member[]>`
      select u.id as user_id, u.public_id as user_public_id, s.id as session_id,
             s.public_id as session_public_id, u.tier, u.requested_tier, u.kyc_status,
             coalesce(p.name, '') as full_name
      from app.user_sessions s
      join app.users u on u.id = s.user_id
      left join app.user_profiles p on p.user_id = u.id
      where s.public_id = ${claims.sessionPublicId} and u.public_id = ${claims.userPublicId}
        and s.revoked_at is null and s.expires_at > now() and s.absolute_expires_at > now()
        and u.status = 'ACTIVE'`;
    if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'Your session has ended. Please log in again.');
    return row;
  },
};
