import { AppError } from '../middleware/errorHandler';
import { sql } from './db';
import { verifyAccessToken } from './tokens';

// The signed-in member: session, tier, KYC status and name. Owned by the auth module; every
// other module reads users through here.

export const TIERS = ['OBSERVER', 'PRIVE', 'INSTITUTIONAL'] as const;
export type Tier = (typeof TIERS)[number];

export const KYC_STATUSES = ['NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export interface Member {
  userId: string;
  /** The user id other modules store (reviews.user_id, evidence folders). */
  userPublicId: string;
  sessionId: string;
  sessionPublicId: string;
  tier: Tier;
  kycStatus: KycStatus;
  /** Shown on reviews per the reviewer's display mode. Empty until the profile step is done. */
  fullName: string;
}

// Checks the JWT and then the database on every request, so logout, revoked devices, password
// resets and suspensions take effect immediately instead of when the token expires.
export async function loadMember(accessToken: string): Promise<Member> {
  const claims = verifyAccessToken(accessToken);
  const [row] = await sql<Member[]>`
    select u.id as user_id, u.public_id as user_public_id, s.id as session_id,
           s.public_id as session_public_id, u.tier, u.kyc_status, coalesce(p.name, '') as full_name
    from app.user_sessions s
    join app.users u on u.id = s.user_id
    left join app.user_profiles p on p.user_id = u.id
    where s.public_id = ${claims.sessionPublicId} and u.public_id = ${claims.userPublicId}
      and s.revoked_at is null and s.expires_at > now() and s.absolute_expires_at > now()
      and u.status = 'ACTIVE'`;
  if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'Your session has ended. Please log in again.');
  return row;
}
