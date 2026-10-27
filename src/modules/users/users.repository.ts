import { callDb } from '../../lib/db';
import type { KycStatus, Tier } from '../../lib/membership';

/** An active user with the profile fields other members may see. */
export interface PublicUser {
  id: string;
  publicId: string;
  tier: Tier;
  kycStatus: KycStatus;
  createdAt: Date;
  name: string;
  location: string | null;
  avatarBucket: string | null;
  avatarObjectKey: string | null;
}

export const usersRepository = {
  async findActiveByPublicId(publicId: string): Promise<PublicUser | null> {
    const row = await callDb('app_public_user', {
      p_public_id: publicId,
    });
    return row && { ...row, createdAt: new Date(row.createdAt) };
  },

  countFollows(userId: string): Promise<{ followers: number; following: number }> {
    return callDb('app_count_follows', { p_user_id: userId });
  },

  async follow(followerId: string, followeeId: string): Promise<void> {
    await callDb('app_follow', { p_follower_id: followerId, p_followee_id: followeeId });
  },

  async unfollow(followerId: string, followeeId: string): Promise<void> {
    await callDb('app_unfollow', { p_follower_id: followerId, p_followee_id: followeeId });
  },
};
