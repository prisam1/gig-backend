import type { z } from 'zod';
import { decrypt } from '../../lib/crypto';
import { callDb } from '../../lib/db';
import type { DbResult } from '../../lib/dbFunctions';
import { AppError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import { filesRepository } from '../files/files.repository';
import { filesStorage } from '../files/files.storage';
import type { Preferences } from '../../types/onboarding';
import type { LookupType, updateMeSchema } from './users.schemas';

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
    throw new Error(`Unexpected database result: ${result.error}`);
  }
}

export interface Option {
  code: string;
  label: string;
}

export function listOptions(type: LookupType): Promise<Option[]> {
  return callDb('app_list_options', { p_type: type });
}

export async function loadUser(userId: string) {
  const row = await callDb('app_get_user', { p_user_id: userId });
  if (!row) throw userNotFound();

  // Codes only: the app shows its own label for each one.
  const preferences: Preferences = { focus: [], risk: [], style: [], sector: [] };
  for (const p of row.preferences) {
    switch (p.type) {
      case 'INVESTMENT_FOCUS':
        preferences.focus.push(p.code);
        break;
      case 'RISK_LEVEL':
        preferences.risk.push(p.code);
        break;
      case 'INVESTMENT_STYLE':
        preferences.style.push(p.code);
        break;
      case 'INVESTMENT_SECTOR':
        preferences.sector.push(p.code);
        break;
    }
  }

  const profileCompleted = row.experienceYears !== null && row.jobProfileCode !== null && row.location !== null;
  const preferencesCompleted =
    preferences.focus.length > 0 && preferences.risk.length > 0 && preferences.style.length > 0 && preferences.sector.length > 0;
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
      jobProfile: row.jobProfileCode,
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
