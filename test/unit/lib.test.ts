import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { csv, pageRange, parse } from '../../src/lib/http';
import { loadMembership } from '../../src/lib/membership';

describe('csv query helper', () => {
  const schema = csv(z.enum(['A', 'B', 'C']));

  it('splits, trims and de-duplicates comma-separated values', () => {
    expect(schema.parse(' A , B,A ,, C')).toEqual(['A', 'B', 'C']);
  });

  it('accepts repeated query keys', () => {
    expect(schema.parse(['A', 'B,C'])).toEqual(['A', 'B', 'C']);
  });

  it('rejects any invalid item', () => {
    expect(schema.safeParse('A,D').success).toBe(false);
  });
});

describe('pageRange', () => {
  it('converts page and size to a 0-based inclusive range', () => {
    expect(pageRange({ page: 1, pageSize: 20 })).toEqual({ from: 0, to: 19 });
    expect(pageRange({ page: 3, pageSize: 10 })).toEqual({ from: 20, to: 29 });
  });
});

describe('parse', () => {
  it('returns parsed output or throws a ZodError', () => {
    expect(parse(z.coerce.number(), '5')).toBe(5);
    expect(() => parse(z.number(), 'x')).toThrow(z.ZodError);
  });
});

describe('loadMembership (auth-module integration point)', () => {
  const claims = (app?: unknown, user?: unknown) =>
    ({ sub: 'u1', app_metadata: app, user_metadata: user }) as never;

  it('reads tier, KYC status and name from Supabase Auth metadata', async () => {
    await expect(
      loadMembership(
        'u1',
        claims({ tier: 'PRIVE', kyc_status: 'APPROVED' }, { full_name: ' Shreya Mehta ' }),
      ),
    ).resolves.toEqual({ tier: 'PRIVE', kycStatus: 'APPROVED', fullName: 'Shreya Mehta' });
  });

  it('defaults to Observer, KYC not started and no name', async () => {
    await expect(loadMembership('u1', claims())).resolves.toEqual({
      tier: 'OBSERVER',
      kycStatus: 'NOT_STARTED',
      fullName: '',
    });
  });

  it('falls back to safe defaults for unknown values', async () => {
    await expect(
      loadMembership('u1', claims({ tier: 'ADMIN', kyc_status: 'yes' }, { full_name: 42 })),
    ).resolves.toEqual({ tier: 'OBSERVER', kycStatus: 'NOT_STARTED', fullName: '' });
  });
});
