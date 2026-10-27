import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { fake } from '../helpers/fakeSupabase';
import { COMPANY_A, companyCardRow } from '../helpers/fixtures';

vi.mock('../../src/lib/supabase', async () => {
  const { fake } = await import('../helpers/fakeSupabase');
  return { supabaseAdmin: fake.client };
});
vi.mock('../../src/lib/auth', async () => {
  const { fakeAuthProvider } = await import('../helpers/fakeSupabase');
  return { authProvider: fakeAuthProvider };
});
vi.mock('../../src/modules/users/users.repository', async (importOriginal) => {
  const { fakeUsersRepository } = await import('../helpers/fakeSupabase');
  const original = await importOriginal<typeof import('../../src/modules/users/users.repository')>();
  return { ...original, usersRepository: { ...original.usersRepository, ...fakeUsersRepository } };
});

const app = createApp();

beforeEach(() => fake.reset());

describe('API conventions', () => {
  it('serves the health check', async () => {
    const res = await request(app).get('/api/v1/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('answers unknown routes with a NOT_FOUND error envelope', async () => {
    const res = await request(app).get('/api/v1/companies-list');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found: GET /api/v1/companies-list' },
    });
  });

  it('answers malformed JSON with VALIDATION_FAILED', async () => {
    const res = await request(app)
      .post('/api/v1/reviews')
      .set('Content-Type', 'application/json')
      .send('{"companyId": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'VALIDATION_FAILED', message: 'Malformed JSON body' });
  });

  it('rejects an invalid token even on public routes', async () => {
    const res = await request(app)
      .get(`/api/v1/companies/${COMPANY_A}`)
      .set('Authorization', 'Bearer forged');
    expect(res.status).toBe(401);
  });

  it('treats a non-Bearer Authorization header as signed out', async () => {
    fake.on('from:company_cards', { data: companyCardRow() });
    const res = await request(app)
      .get(`/api/v1/companies/${COMPANY_A}`)
      .set('Authorization', 'Basic abc');
    expect(res.status).toBe(200);
    expect(res.body.data.access).toBe('SUMMARY');
  });

  it('turns unexpected database errors into a 500 INTERNAL error', async () => {
    fake.on('from:company_cards', { error: { code: 'XX000', message: 'connection lost' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(app).get(`/api/v1/companies/${COMPANY_A}`);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
  });

  it('sets security headers', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
