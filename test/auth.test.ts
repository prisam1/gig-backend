import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { authProvider } from '../src/lib/auth';
import { AUTH_HEADER, app, makeUser, signInAs } from './helpers';

describe('authentication on protected routes', () => {
  it('rejects requests without a bearer token', async () => {
    const res = await request(app).get('/api/v1/me');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Missing bearer token' });
  });

  it('rejects an invalid or expired token', async () => {
    vi.spyOn(authProvider, 'verifyAccessToken').mockResolvedValue(null);

    const res = await request(app).get('/api/v1/me').set(AUTH_HEADER);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid or expired token');
  });

  it('blocks suspended accounts', async () => {
    signInAs(makeUser({ status: 'SUSPENDED' }));

    const res = await request(app).get('/api/v1/me').set(AUTH_HEADER);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('returns 400 for malformed JSON bodies', async () => {
    signInAs();

    const res = await request(app)
      .patch('/api/v1/me')
      .set(AUTH_HEADER)
      .set('Content-Type', 'application/json')
      .send('{"name": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});
