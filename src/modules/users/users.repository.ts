import type { AuthIdentity } from '../../lib/auth';
import { supabaseAdmin, unwrap } from '../../lib/supabase';
import type { Tables } from '../../types/database';
import type { KycStatus, PreferenceType, Tier, UserStatus, VerifiedTier } from '../../types/domain';

export interface User {
  id: number;
  publicId: string;
  email: string | null;
  phone: string | null;
  tier: Tier;
  requestedTier: VerifiedTier | null;
  kycStatus: KycStatus;
  status: UserStatus;
  createdAt: string;
}

const USER_COLUMNS =
  'id, public_id, email, phone, tier, requested_tier, kyc_status, status, created_at';

type UserRow = Pick<
  Tables<'users'>,
  | 'id'
  | 'public_id'
  | 'email'
  | 'phone'
  | 'tier'
  | 'requested_tier'
  | 'kyc_status'
  | 'status'
  | 'created_at'
>;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    publicId: row.public_id,
    email: row.email,
    phone: row.phone,
    tier: row.tier,
    requestedTier: row.requested_tier,
    kycStatus: row.kyc_status,
    status: row.status,
    createdAt: row.created_at,
  };
}

export interface Profile {
  name: string | null;
  experience: string | null;
  jobProfile: string | null;
  otherJob: string | null;
  location: string | null;
  avatar: { bucket: string; objectKey: string } | null;
}

export type ProfileChanges = Partial<Omit<Profile, 'avatar'> & { avatarFileId: number }>;

// A type alias rather than an interface, so it is assignable to the `Json` RPC argument.
export type Preference = {
  type: PreferenceType;
  code: string;
};

async function findUser(column: 'auth_user_id' | 'public_id', value: string) {
  const row = unwrap(
    await supabaseAdmin.from('users').select(USER_COLUMNS).eq(column, value).maybeSingle(),
  );
  return row && toUser(row);
}

async function countFollowsBy(column: 'follower_id' | 'followee_id', userId: number) {
  const result = await supabaseAdmin
    .from('follows')
    .select('*', { count: 'exact', head: true })
    .eq(column, userId);
  unwrap(result);
  return result.count ?? 0;
}

export const usersRepository = {
  /** Loads the GIG user for a Supabase Auth identity, creating it on first sign-in. */
  async findOrCreateByIdentity(identity: AuthIdentity): Promise<User> {
    const existing = await findUser('auth_user_id', identity.authUserId);
    if (existing) return existing;

    // ignoreDuplicates makes concurrent first requests safe; the re-read returns the winner.
    unwrap(
      await supabaseAdmin
        .from('users')
        .upsert(
          { auth_user_id: identity.authUserId, email: identity.email, phone: identity.phone },
          { onConflict: 'auth_user_id', ignoreDuplicates: true },
        ),
    );
    const created = await findUser('auth_user_id', identity.authUserId);
    if (!created) throw new Error(`User for auth id ${identity.authUserId} was not created`);
    return created;
  },

  findByPublicId(publicId: string): Promise<User | null> {
    return findUser('public_id', publicId);
  },

  async updateTier(userId: number, tier: Tier, requestedTier: VerifiedTier | null): Promise<User> {
    const row = unwrap(
      await supabaseAdmin
        .from('users')
        .update({ tier, requested_tier: requestedTier })
        .eq('id', userId)
        .select(USER_COLUMNS)
        .single(),
    );
    return toUser(row);
  },

  async findProfile(userId: number): Promise<Profile | null> {
    const row = unwrap(
      await supabaseAdmin
        .from('user_profiles')
        .select(
          'name, experience, job_profile, other_job, location, avatar:files(bucket, object_key)',
        )
        .eq('user_id', userId)
        .maybeSingle(),
    );
    if (!row) return null;

    return {
      name: row.name,
      experience: row.experience,
      jobProfile: row.job_profile,
      otherJob: row.other_job,
      location: row.location,
      avatar: row.avatar && { bucket: row.avatar.bucket, objectKey: row.avatar.object_key },
    };
  },

  /** Creates the profile or updates only the given fields; `undefined` fields are left as they are. */
  async upsertProfile(userId: number, changes: ProfileChanges): Promise<void> {
    unwrap(
      await supabaseAdmin.from('user_profiles').upsert(
        {
          user_id: userId,
          name: changes.name,
          experience: changes.experience,
          job_profile: changes.jobProfile,
          other_job: changes.otherJob,
          location: changes.location,
          avatar_file_id: changes.avatarFileId,
        },
        { onConflict: 'user_id' },
      ),
    );
  },

  async findPreferences(userId: number): Promise<Preference[]> {
    const rows = unwrap(
      await supabaseAdmin
        .from('user_preferences')
        .select('type, option_code')
        .eq('user_id', userId)
        .order('created_at'),
    );
    return rows.map((row) => ({ type: row.type, code: row.option_code }));
  },

  /** Replaces all of a user's preferences in one transaction. */
  async replacePreferences(userId: number, preferences: Preference[]): Promise<void> {
    unwrap(
      await supabaseAdmin.rpc('replace_user_preferences', {
        p_user_id: userId,
        p_preferences: preferences,
      }),
    );
  },

  async countFollows(userId: number): Promise<{ followers: number; following: number }> {
    const [followers, following] = await Promise.all([
      countFollowsBy('followee_id', userId),
      countFollowsBy('follower_id', userId),
    ]);
    return { followers, following };
  },

  async follow(followerId: number, followeeId: number): Promise<void> {
    unwrap(
      await supabaseAdmin
        .from('follows')
        .upsert(
          { follower_id: followerId, followee_id: followeeId },
          { onConflict: 'follower_id,followee_id', ignoreDuplicates: true },
        ),
    );
  },

  async unfollow(followerId: number, followeeId: number): Promise<void> {
    unwrap(
      await supabaseAdmin
        .from('follows')
        .delete()
        .eq('follower_id', followerId)
        .eq('followee_id', followeeId),
    );
  },
};
