import type { z } from 'zod';
import { audit } from '../../lib/audit';
import { decrypt } from '../../lib/crypto';
import { callDb } from '../../lib/db';
import type { DbResult } from '../../lib/dbFunctions';
import type { Member } from '../../lib/membership';
import { consume, LIMITS } from '../../lib/rateLimit';
import { AppError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import { filesRepository } from '../files/files.repository';
import { filesStorage } from '../files/files.storage';
import { usersRepository, type PublicUser } from './users.repository';
import type { LookupType, preferencesSchema, tierSchema, updateMeSchema } from './users.schemas';

// Avatars live in the public "avatars" bucket; every other file stays private.
function avatarUrl(bucket: string | null, objectKey: string | null): string | null {
  return bucket && objectKey ? filesStorage.publicUrl(bucket, objectKey) : null;
}

const fieldErrors = (fields: Record<string, string>) =>
  new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', fields);

const userNotFound = () => new AppError(404, 'NOT_FOUND', 'User not found');

// Results of the app_* write functions: { ok } on success, otherwise an error code or field errors.
type WriteResult = DbResult<'app_update_profile'>;

function assertWritten(result: WriteResult): asserts result is Extract<WriteResult, { ok: true }> {
  if ('fields' in result) throw fieldErrors(result.fields);
  if ('error' in result) {
    if (result.error === 'NOT_FOUND') throw userNotFound();
    if (result.error === 'KYC_PENDING') throw new AppError(409, 'KYC_PENDING', 'Tier cannot change while KYC is under review');
    if (result.error === 'ONBOARDING_INCOMPLETE') {
      throw new AppError(409, 'ONBOARDING_INCOMPLETE', 'Complete your professional and investment details first');
    }
    throw new Error(`Unexpected database result: ${result.error}`);
  }
}

export interface Option {
  code: string;
  label: string;
}

const PREFERENCE_KEYS = {
  INVESTMENT_FOCUS: 'focus',
  RISK_LEVEL: 'risk',
  INVESTMENT_STYLE: 'style',
  INVESTMENT_SECTOR: 'sector',
} as const;

export function listOptions(type: LookupType): Promise<Option[]> {
  return callDb('app_list_options', { p_type: type });
}

export async function loadUser(userId: string) {
  const row = await callDb('app_get_user', { p_user_id: userId });
  if (!row) throw userNotFound();

  const preferences: Record<(typeof PREFERENCE_KEYS)[keyof typeof PREFERENCE_KEYS], Option[]> = {
    focus: [],
    risk: [],
    style: [],
    sector: [],
  };
  for (const p of row.preferences) preferences[PREFERENCE_KEYS[p.type]].push({ code: p.code, label: p.label });

  const profileCompleted = row.experienceYears !== null && row.jobProfileCode !== null && row.location !== null;
  const preferencesCompleted = Object.values(preferences).every((list) => list.length > 0);
  const tierSelected = row.tierSelectedAt !== null;

  return {
    id: row.publicId,
    name: row.name,
    email: decrypt(row.emailEnc, 'email'),
    phone: decrypt(row.phoneEnc, 'phone'),
    avatarUrl: avatarUrl(row.avatarBucket, row.avatarObjectKey),
    followers: row.followers,
    following: row.following,
    tier: row.tier,
    requestedTier: row.requestedTier,
    kycStatus: row.kycStatus,
    profile: {
      experienceYears: row.experienceYears,
      jobProfile: row.jobProfileCode ? { code: row.jobProfileCode, label: row.jobProfileLabel } : null,
      otherJob: row.otherJob,
      location: row.location,
    },
    preferences,
    onboarding: {
      profileCompleted,
      preferencesCompleted,
      tierSelected,
      completed: profileCompleted && preferencesCompleted && tierSelected,
    },
    createdAt: row.createdAt,
  };
}
export type UserDto = Awaited<ReturnType<typeof loadUser>>;

export async function updateMe(userId: string, input: z.infer<typeof updateMeSchema>, ctx: ClientContext) {
  const { avatarFileId, ...changes } = input;

  // The avatar must be the user's own upload, made with purpose AVATAR, and actually uploaded.
  let avatar: string | undefined;
  if (avatarFileId !== undefined) {
    const [file] = await filesRepository.findOwned(userId, [avatarFileId]);
    if (!file || file.purpose !== 'AVATAR') {
      throw fieldErrors({ avatarFileId: 'Upload the avatar with purpose AVATAR first' });
    }
    if (!(await filesStorage.exists(file.bucket, file.objectKey))) {
      throw fieldErrors({ avatarFileId: 'File has not been uploaded yet' });
    }
    avatar = file.id;
  }

  const result = await callDb('app_update_profile', {
    p_user_id: userId,
    p_changes: { ...changes, ...(avatar && { avatarFileId: avatar }) },
    p_ctx: ctx,
  });
  assertWritten(result);
  return loadUser(userId);
}

export async function setPreferences(userId: string, input: z.infer<typeof preferencesSchema>, ctx: ClientContext) {
  const result = await callDb('app_set_preferences', {
    p_user_id: userId,
    p_groups: [
      { type: 'INVESTMENT_FOCUS', field: 'focus', codes: input.focus },
      { type: 'RISK_LEVEL', field: 'risk', codes: input.risk },
      { type: 'INVESTMENT_STYLE', field: 'style', codes: input.style },
      { type: 'INVESTMENT_SECTOR', field: 'sector', codes: input.sector },
    ],
    p_ctx: ctx,
  });
  assertWritten(result);
  return loadUser(userId);
}

// Observer is granted at once. Prive and Institutional are recorded as requested and granted
// only when KYC is approved (KYC workstream), never by this endpoint.
export async function selectTier(userId: string, input: z.infer<typeof tierSchema>, ctx: ClientContext) {
  const result = await callDb('app_select_tier', { p_user_id: userId, p_tier: input.tier, p_ctx: ctx });
  assertWritten(result);
  return { user: await loadUser(userId), nextStep: result.requestedTier ? 'KYC_REQUIRED' : 'NONE' };
}

async function findActiveUser(publicId: string): Promise<PublicUser> {
  const user = await usersRepository.findActiveByPublicId(publicId);
  if (!user) throw userNotFound();
  return user;
}

export async function getPublicProfile(publicId: string) {
  const user = await findActiveUser(publicId);
  const follows = await usersRepository.countFollows(user.id);

  // Contact details stay private: no email, phone or KYC detail here.
  return {
    id: user.publicId,
    name: user.name,
    avatarUrl: avatarUrl(user.avatarBucket, user.avatarObjectKey),
    tier: user.tier,
    verified: user.kycStatus === 'APPROVED',
    location: user.location,
    ...follows,
    memberSince: user.createdAt,
  };
}

export async function follow(me: Member, publicId: string, ctx: ClientContext): Promise<void> {
  if (publicId === me.userPublicId) {
    throw new AppError(400, 'VALIDATION_FAILED', 'You cannot follow yourself');
  }
  await consume(LIMITS.followPerUser, me.userPublicId);
  const target = await findActiveUser(publicId);
  await usersRepository.follow(me.userId, target.id);
  await audit(ctx, 'user.followed', { userId: me.userId, metadata: { user: publicId } });
}

export async function unfollow(me: Member, publicId: string, ctx: ClientContext): Promise<void> {
  await consume(LIMITS.followPerUser, me.userPublicId);
  const target = await findActiveUser(publicId);
  await usersRepository.unfollow(me.userId, target.id);
  await audit(ctx, 'user.unfollowed', { userId: me.userId, metadata: { user: publicId } });
}
