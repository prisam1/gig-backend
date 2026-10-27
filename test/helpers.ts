import { vi } from 'vitest';
import { createApp } from '../src/app';
import { authProvider } from '../src/lib/auth';
import type { StoredFile } from '../src/modules/files/files.repository';
import { usersRepository, type User } from '../src/modules/users/users.repository';

export const app = createApp();

export const AUTH_HEADER = { Authorization: 'Bearer valid-token' };

export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
export const FILE_ID = '33333333-3333-4333-8333-333333333333';

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    publicId: USER_ID,
    email: 'asha@example.com',
    phone: '9876543210',
    tier: 'OBSERVER',
    requestedTier: null,
    kycStatus: 'NOT_STARTED',
    status: 'ACTIVE',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeFile(overrides: Partial<StoredFile> = {}): StoredFile {
  return {
    id: 10,
    publicId: FILE_ID,
    purpose: 'KYC_DOCUMENT',
    bucket: 'kyc-documents',
    objectKey: `${USER_ID}/doc.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    ...overrides,
  };
}

/** Makes `AUTH_HEADER` authenticate as the given user. */
export function signInAs(user: User = makeUser()): User {
  vi.spyOn(authProvider, 'verifyAccessToken').mockResolvedValue({
    authUserId: 'auth-uuid',
    email: user.email,
    phone: user.phone,
  });
  vi.spyOn(usersRepository, 'findOrCreateByIdentity').mockResolvedValue(user);
  return user;
}
