import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env';
import { codeHash, issueCode } from '../../src/modules/auth/otp';

// A mutable copy of the validated env, so each test can switch OTP_TEST_CODE on or off.
vi.mock('../../src/config/env', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/config/env')>();
  return { env: { ...original.env } };
});

afterEach(() => {
  delete (env as { OTP_TEST_CODE?: string }).OTP_TEST_CODE;
});

describe('issueCode', () => {
  it('issues a random 6-digit code by default', () => {
    const codes = new Set(Array.from({ length: 20 }, () => issueCode().code));
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(1);
  });

  it('issues OTP_TEST_CODE when it is set (development only)', () => {
    (env as { OTP_TEST_CODE?: string }).OTP_TEST_CODE = '123456';
    const issued = issueCode();

    expect(issued.code).toBe('123456');
    // Stored as a keyed hash like any other code, so verification follows the normal path.
    expect(issued.stored.codeHash).toBe(codeHash(issued.publicId, '123456'));
    // A decoy (unknown or taken address) still matches no code, not even the test code.
    expect(issued.stored.decoyHash).not.toBe(issued.stored.codeHash);
  });
});
