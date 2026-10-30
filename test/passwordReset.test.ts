import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbTransport } from '../src/lib/db';
import { app } from './helpers';

// Development delivery ("console"): codes are printed in the server log instead of being sent.
describe('POST /auth/password/forgot', () => {
  afterEach(() => vi.restoreAllMocks());

  const forgot = async (userExists: boolean, identifier: string) => {
    vi.spyOn(dbTransport, 'rpc').mockResolvedValue({ userExists });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = await request(app).post('/api/v1/auth/password/forgot').send({ identifier });
    return { res, lines: log.mock.calls.map((args) => String(args[0])) };
  };

  it('sends a code to a registered email', async () => {
    const { res, lines } = await forgot(true, 'asha@example.com');

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ channel: 'EMAIL', destination: 'a***@example.com' });
    expect(lines).toEqual([expect.stringMatching(/^\[otp\] PASSWORD_RESET EMAIL a\*\*\*@example\.com code=\d{4}$/)]);
  });

  it.each([
    ['nobody@example.com', 'No account found with this email. Please create your account.'],
    ['+919876543210', 'No account found with this phone number. Please create your account.'],
  ])('tells %s to create an account, and sends nothing', async (identifier, message) => {
    const { res, lines } = await forgot(false, identifier);

    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'ACCOUNT_NOT_FOUND', message, fields: { identifier: message } });
    expect(lines).toEqual([]);
  });
});
