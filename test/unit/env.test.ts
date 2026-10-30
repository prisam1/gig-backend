import { afterEach, describe, expect, it, vi } from 'vitest';

// src/config/env.ts validates process.env when it is first imported and exits on a bad value.
async function loadEnvWith(values: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const loaded = await import('../../src/config/env').then(
    () => true,
    () => false,
  );
  return { loaded, exited: exit.mock.calls.length > 0, logged: JSON.stringify(error.mock.calls) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OTP_TEST_CODE', () => {
  it('is accepted outside production', async () => {
    const result = await loadEnvWith({ NODE_ENV: 'development', OTP_TEST_CODE: '1234' });
    expect(result).toMatchObject({ loaded: true, exited: false });
  });

  it('stops the server from starting in production', async () => {
    const result = await loadEnvWith({
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.gig.example',
      OTP_TEST_CODE: '1234',
    });
    expect(result.exited).toBe(true);
    expect(result.logged).toContain('A fixed OTP code is not allowed in production');
  });

  it('must be exactly 4 digits', async () => {
    const result = await loadEnvWith({ NODE_ENV: 'development', OTP_TEST_CODE: '123456' });
    expect(result.exited).toBe(true);
    expect(result.logged).toContain('Must be exactly 4 digits');
  });
});
