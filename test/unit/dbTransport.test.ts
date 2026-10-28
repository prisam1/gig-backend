import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseError, DatabaseUnavailableError, dbTransport } from '../../src/lib/db';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabaseAdmin: { rpc } }));

// What supabase-js returns when the HTTP request itself fails (no SQLSTATE).
const networkFailure = { data: null, error: { code: '', message: 'TypeError: fetch failed' } };
const ok = (data: unknown) => ({ data, error: null });

beforeEach(() => {
  rpc.mockReset();
});

describe('dbTransport.rpc', () => {
  it('retries a read-only function after a network failure', async () => {
    rpc.mockResolvedValueOnce(networkFailure).mockResolvedValueOnce(ok({ destinationHash: 'h' }));

    await expect(dbTransport.rpc('app_otp_peek', { p_public_id: 'x' })).resolves.toEqual({ destinationHash: 'h' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('never sends a write twice: a network failure is a 503 the app can retry', async () => {
    rpc.mockResolvedValue(networkFailure);

    const error = await dbTransport.rpc('app_otp_verify', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseUnavailableError);
    expect(error).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('gives up on a read after 3 attempts with a 503', async () => {
    rpc.mockResolvedValue(networkFailure);

    await expect(dbTransport.rpc('app_member', {})).rejects.toBeInstanceOf(DatabaseUnavailableError);
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('reports database errors as they are, without retrying', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "x_key"' },
    });

    const error = await dbTransport.rpc('app_member', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ code: '23505', constraint: 'x_key' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
