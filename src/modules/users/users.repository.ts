import { sql, type Db } from '../../lib/db';
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
    const [row] = await sql<PublicUser[]>`
      select u.id, u.public_id, u.tier, u.kyc_status, u.created_at, p.name, p.location,
             f.bucket as avatar_bucket, f.object_key as avatar_object_key
      from app.users u
      join app.user_profiles p on p.user_id = u.id
      left join app.files f on f.id = p.avatar_file_id
      where u.public_id = ${publicId} and u.status = 'ACTIVE'`;
    return row ?? null;
  },

  async countFollows(userId: string, db: Db = sql): Promise<{ followers: number; following: number }> {
    const [row] = await db<{ followers: number; following: number }[]>`
      select (select count(*)::int from app.follows where followee_id = ${userId}) as followers,
             (select count(*)::int from app.follows where follower_id = ${userId}) as following`;
    return row ?? { followers: 0, following: 0 };
  },

  async follow(followerId: string, followeeId: string): Promise<void> {
    await sql`
      insert into app.follows (follower_id, followee_id) values (${followerId}, ${followeeId})
      on conflict do nothing`;
  },

  async unfollow(followerId: string, followeeId: string): Promise<void> {
    await sql`delete from app.follows where follower_id = ${followerId} and followee_id = ${followeeId}`;
  },
};
