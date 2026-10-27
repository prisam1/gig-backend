import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { authProvider } from '../src/lib/auth';
import { signAccessToken } from '../src/lib/tokens';
import { AppError } from '../src/middleware/errorHandler';
import { AUTH_HEADER, OTHER_USER_ID, app, signInAs } from './helpers';

const SECRET = process.env.JWT_ACCESS_SECRET!;
const claims = { sid: randomUUID() };
const signOptions = { issuer: 'gig-backend', audience: 'gig-app', subject: randomUUID() } as const;

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

// Every route that needs a signed-in user ("User", "Prive" or "Full" access in the API spec).
const PROTECTED: [method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string][] = [
  ['post', '/api/v1/auth/logout'],
  ['get', '/api/v1/auth/sessions'],
  ['delete', '/api/v1/auth/sessions'],
  ['get', '/api/v1/me'],
  ['patch', '/api/v1/me'],
  ['put', '/api/v1/me/preferences'],
  ['put', '/api/v1/me/tier'],
  ['get', `/api/v1/users/${OTHER_USER_ID}`],
  ['post', `/api/v1/users/${OTHER_USER_ID}/follow`],
  ['delete', `/api/v1/users/${OTHER_USER_ID}/follow`],
  ['post', '/api/v1/files/upload-url'],
  ['post', '/api/v1/kyc/submissions'],
  ['get', '/api/v1/kyc/submissions/me'],
  ['get', '/api/v1/companies/compare?ids=a,b'],
  ['get', `/api/v1/companies/${OTHER_USER_ID}/trends`],
  ['post', '/api/v1/reviews'],
  ['get', '/api/v1/reviews/me'],
  ['get', `/api/v1/reviews/${OTHER_USER_ID}`],
  ['patch', `/api/v1/reviews/${OTHER_USER_ID}/resolution`],
];

describe('authentication on protected routes', () => {
  it.each(PROTECTED)('%s %s rejects requests without a bearer token', async (method, path) => {
    const res = await request(app)[method](path);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each(PROTECTED)('%s %s rejects a forged token', async (method, path) => {
    const res = await request(app)[method](path).set('Authorization', 'Bearer forged.token.value');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a token signed with another secret', async () => {
    const token = jwt.sign(claims, 'not-the-server-secret', signOptions);

    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const token = jwt.sign(claims, SECRET, { ...signOptions, expiresIn: -10 });

    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
  });

  it('rejects an unsigned token (alg "none")', async () => {
    const token = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ ...claims, sub: signOptions.subject })}.`;

    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
  });

  it('rejects a token for another audience or issuer', async () => {
    const otherAudience = jwt.sign(claims, SECRET, { ...signOptions, audience: 'another-app' });
    const otherIssuer = jwt.sign(claims, SECRET, { ...signOptions, issuer: 'someone-else' });

    for (const token of [otherAudience, otherIssuer]) {
      const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    }
  });

  it('accepts a valid token only while its session is active', async () => {
    // A correctly signed token still needs a live session; logout, password reset and suspension end it.
    const token = signAccessToken(randomUUID(), randomUUID());
    vi.spyOn(authProvider, 'loadMember').mockRejectedValue(
      new AppError(401, 'UNAUTHENTICATED', 'Your session has ended. Please log in again.'),
    );

    const res = await request(app).get('/api/v1/kyc/submissions/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Your session has ended. Please log in again.');
  });

  it('marks every API response, errors included, as not cacheable', async () => {
    const res = await request(app).get('/api/v1/me');

    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 400 for malformed JSON bodies', async () => {
    signInAs();

    const res = await request(app)
      .patch('/api/v1/me')
      .set(AUTH_HEADER)
      .set('Content-Type', 'application/json')
      .send('{"name": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
