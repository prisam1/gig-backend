import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { app } from './helpers';

// A mutable copy of the validated env: the request log is off in tests unless switched on here.
vi.mock('../src/config/env', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/config/env')>();
  return { env: { ...original.env } };
});

describe('request log', () => {
  afterEach(() => {
    (env as { NODE_ENV: string }).NODE_ENV = 'test';
    vi.restoreAllMocks();
  });

  it('writes one line per request with the error code and message, and never the body', async () => {
    (env as { NODE_ENV: string }).NODE_ENV = 'development';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await request(app)
      .post('/api/v1/auth/password/forgot')
      .send({ identifier: 'not-an-email', password: 'Secret@123' });

    expect(res.status).toBe(400);
    const lines = warn.mock.calls.map((args) => String(args[0]));
    expect(lines).toEqual([
      expect.stringMatching(/^\[http\] [0-9a-f]{8} POST \/api\/v1\/auth\/password\/forgot 400 \d+ms VALIDATION_FAILED "[^"]+" fields: /),
    ]);
    expect(lines[0]).toContain(res.headers['x-request-id'].slice(0, 8));
    expect(lines.join('\n')).not.toContain('Secret@123');
    expect(lines.join('\n')).not.toContain('not-an-email');
  });

  it('is silent in tests', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await request(app).get('/api/v1/nope');
    expect([...log.mock.calls, ...warn.mock.calls]).toEqual([]);
  });
});
