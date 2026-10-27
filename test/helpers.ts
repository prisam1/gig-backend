import { vi } from 'vitest';
import { createApp } from '../src/app';
import { authProvider } from '../src/lib/auth';
import type { Member } from '../src/lib/membership';
import type { StoredFile } from '../src/modules/files/files.repository';

export const app = createApp();

export const AUTH_HEADER = { Authorization: 'Bearer valid-token' };

export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
export const FILE_ID = '33333333-3333-4333-8333-333333333333';

export function makeUser(overrides: Partial<Member> = {}): Member {
  return {
    userId: '1',
    userPublicId: USER_ID,
    sessionId: '7',
    sessionPublicId: '66666666-6666-4666-8666-666666666666',
    tier: 'OBSERVER',
    requestedTier: null,
    kycStatus: 'NOT_STARTED',
    fullName: 'Asha Rao',
    ...overrides,
  };
}

export function makeFile(overrides: Partial<StoredFile> = {}): StoredFile {
  return {
    id: '10',
    publicId: FILE_ID,
    purpose: 'KYC_DOCUMENT',
    bucket: 'kyc-documents',
    objectKey: `${USER_ID}/doc.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    ...overrides,
  };
}

/** Makes `AUTH_HEADER` authenticate as the given member (the JWT and session checks are stubbed). */
export function signInAs(user: Member = makeUser()): Member {
  vi.spyOn(authProvider, 'loadMember').mockResolvedValue(user);
  return user;
}
