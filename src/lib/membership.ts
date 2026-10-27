import { usersRepository, type User } from '../modules/users/users.repository';
import type { KycStatus, Tier } from '../types/domain';

// How the catalog and reviews modules see the signed-in user. Users, tiers and KYC belong to the
// users module (public.users); these modules read them only through here.

export type { KycStatus, Tier };

export interface Member {
  /** users.public_id: stored as reviews.user_id and used as the evidence folder in Storage. */
  id: string;
  tier: Tier;
  kycStatus: KycStatus;
  /** Shown on reviews per the reviewer's display mode. Empty until the profile has a name. */
  fullName: string;
  /** Prive with approved KYC: the "Prive" access level in the API spec. */
  isVerifiedPrive: boolean;
  /** Prive (verified) or Institutional: may see full analytics and full reviews. */
  hasFullAccess: boolean;
}

type Access = Pick<User, 'tier' | 'kycStatus'>;

export function isVerifiedPrive(user: Access): boolean {
  return user.tier === 'PRIVE' && user.kycStatus === 'APPROVED';
}

export function hasFullAccess(user: Access): boolean {
  return isVerifiedPrive(user) || user.tier === 'INSTITUTIONAL';
}

export async function loadMember(user: User): Promise<Member> {
  const profile = await usersRepository.findProfile(user.id);
  return {
    id: user.publicId,
    tier: user.tier,
    kycStatus: user.kycStatus,
    fullName: profile?.name?.trim() ?? '',
    isVerifiedPrive: isVerifiedPrive(user),
    hasFullAccess: hasFullAccess(user),
  };
}
