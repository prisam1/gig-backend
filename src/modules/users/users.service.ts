import { HttpError, validationError, type FieldErrors } from '../../middleware/errorHandler';
import type { PreferenceType, Tier } from '../../types/domain';
import { filesRepository } from '../files/files.repository';
import { filesStorage } from '../files/files.storage';
import { lookupsService } from '../lookups/lookups.service';
import { usersRepository, type Preference, type Profile, type User } from './users.repository';
import { OTHER_JOB_PROFILE, type PreferencesInput, type UpdateProfileInput } from './users.schemas';

function avatarUrl(profile: Profile | null): string | null {
  return profile?.avatar
    ? filesStorage.publicUrl(profile.avatar.bucket, profile.avatar.objectKey)
    : null;
}

function groupPreferences(preferences: Preference[]) {
  const codesOf = (type: PreferenceType) =>
    preferences.filter((pref) => pref.type === type).map((pref) => pref.code);

  return {
    focus: codesOf('FOCUS')[0] ?? null,
    risk: codesOf('RISK')[0] ?? null,
    styles: codesOf('STYLE'),
    sectors: codesOf('SECTOR'),
  };
}

async function findUserOrThrow(publicId: string): Promise<User> {
  const user = await usersRepository.findByPublicId(publicId);
  if (!user || user.status !== 'ACTIVE') throw new HttpError(404, 'User not found');
  return user;
}

async function resolveAvatarFileId(user: User, publicFileId: string): Promise<number> {
  const [file] = await filesRepository.findOwned(user.id, [publicFileId]);
  if (!file || file.purpose !== 'AVATAR') {
    throw validationError({ avatarFileId: 'Upload the avatar with purpose AVATAR first' });
  }
  return file.id;
}

export const usersService = {
  async getMyProfile(user: User) {
    const [profile, preferences, follows] = await Promise.all([
      usersRepository.findProfile(user.id),
      usersRepository.findPreferences(user.id),
      usersRepository.countFollows(user.id),
    ]);

    return {
      id: user.publicId,
      name: profile?.name ?? null,
      email: user.email,
      phone: user.phone,
      avatarUrl: avatarUrl(profile),
      tier: user.tier,
      requestedTier: user.requestedTier,
      kycStatus: user.kycStatus,
      experience: profile?.experience ?? null,
      jobProfile: profile?.jobProfile ?? null,
      otherJob: profile?.otherJob ?? null,
      location: profile?.location ?? null,
      preferences: groupPreferences(preferences),
      ...follows,
      createdAt: user.createdAt,
    };
  },

  async updateMyProfile(user: User, input: UpdateProfileInput) {
    const { avatarFileId, ...fields } = input;
    const picksListedJob =
      fields.jobProfile !== undefined && fields.jobProfile !== OTHER_JOB_PROFILE;

    if (picksListedJob) {
      const invalid = await lookupsService.findInvalidCodes('JOB_PROFILE', [fields.jobProfile!]);
      if (invalid.length > 0) throw validationError({ jobProfile: 'Unknown job profile' });
    }

    await usersRepository.upsertProfile(user.id, {
      ...fields,
      // The free-text job only belongs with the Others option.
      ...(picksListedJob ? { otherJob: null } : {}),
      ...(avatarFileId ? { avatarFileId: await resolveAvatarFileId(user, avatarFileId) } : {}),
    });

    return this.getMyProfile(user);
  },

  async replaceMyPreferences(user: User, input: PreferencesInput) {
    const preferences: Preference[] = [
      { type: 'FOCUS', code: input.focus },
      { type: 'RISK', code: input.risk },
      ...input.styles.map((code) => ({ type: 'STYLE' as const, code })),
      ...input.sectors.map((code) => ({ type: 'SECTOR' as const, code })),
    ];

    const checks: [keyof PreferencesInput, PreferenceType, string[]][] = [
      ['focus', 'FOCUS', [input.focus]],
      ['risk', 'RISK', [input.risk]],
      ['styles', 'STYLE', input.styles],
      ['sectors', 'SECTOR', input.sectors],
    ];

    const fields: FieldErrors = {};
    for (const [field, type, codes] of checks) {
      const invalid = await lookupsService.findInvalidCodes(type, codes);
      if (invalid.length > 0) fields[field] = `Unknown option: ${invalid.join(', ')}`;
    }
    if (Object.keys(fields).length > 0) throw validationError(fields);

    await usersRepository.replacePreferences(user.id, preferences);
    return groupPreferences(preferences);
  },

  /**
   * Observer applies at once. Prive and Institutional are recorded as the requested tier
   * and only granted when an admin approves the user's KYC submission.
   */
  async chooseTier(user: User, tier: Tier) {
    if (user.kycStatus === 'PENDING') {
      throw new HttpError(409, 'Tier cannot change while KYC is under review', 'KYC_PENDING');
    }

    const updated =
      tier === 'OBSERVER'
        ? await usersRepository.updateTier(user.id, 'OBSERVER', null)
        : await usersRepository.updateTier(user.id, user.tier, tier === user.tier ? null : tier);

    return {
      tier: updated.tier,
      requestedTier: updated.requestedTier,
      kycStatus: updated.kycStatus,
      nextStep: updated.requestedTier ? 'SUBMIT_KYC' : null,
    };
  },

  async getPublicProfile(publicId: string) {
    const user = await findUserOrThrow(publicId);
    const [profile, follows] = await Promise.all([
      usersRepository.findProfile(user.id),
      usersRepository.countFollows(user.id),
    ]);

    // Contact details stay private: no email, phone or KYC detail here.
    return {
      id: user.publicId,
      name: profile?.name ?? null,
      avatarUrl: avatarUrl(profile),
      tier: user.tier,
      verified: user.kycStatus === 'APPROVED',
      location: profile?.location ?? null,
      ...follows,
      memberSince: user.createdAt,
    };
  },

  async follow(user: User, publicId: string) {
    if (publicId === user.publicId) throw new HttpError(400, 'You cannot follow yourself');
    const target = await findUserOrThrow(publicId);
    await usersRepository.follow(user.id, target.id);
  },

  async unfollow(user: User, publicId: string) {
    const target = await findUserOrThrow(publicId);
    await usersRepository.unfollow(user.id, target.id);
  },
};
