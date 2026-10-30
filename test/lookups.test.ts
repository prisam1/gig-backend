import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { dbTransport } from '../src/lib/db';
import { app } from './helpers';

describe('GET /lookups/:type', () => {
  it('serves an option list without a token, cached for 5 minutes', async () => {
    const rpc = vi.spyOn(dbTransport, 'rpc').mockResolvedValue([{ code: 'PROMOTERS', label: 'Promoters' }]);

    const res = await request(app).get('/api/v1/lookups/rating-factors').expect(200);

    expect(res.body).toEqual({ data: [{ code: 'PROMOTERS', label: 'Promoters' }] });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(rpc).toHaveBeenCalledWith('app_list_options', { p_type: 'RATING_FACTOR' });
  });

  it.each([
    ['rating-factors', 'RATING_FACTOR'],
    ['risk-factors', 'RISK_FACTOR'],
    ['investor-types', 'INVESTOR_TYPE'],
  ])('maps /lookups/%s to the %s list', async (path, type) => {
    const rpc = vi.spyOn(dbTransport, 'rpc').mockResolvedValue([]);
    await request(app).get(`/api/v1/lookups/${path}`).expect(200);
    expect(rpc).toHaveBeenCalledWith('app_list_options', { p_type: type });
  });

  // The sign-up choices are fixed lists in the app; the API only checks them (src/constants/onboarding.ts).
  it.each(['country-codes', 'job-profiles', 'investment-focus', 'risk-levels', 'investment-styles', 'investment-sectors', 'tiers'])(
    'does not serve the sign-up list %s',
    async (path) => {
      const rpc = vi.spyOn(dbTransport, 'rpc');
      const res = await request(app).get(`/api/v1/lookups/${path}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it('refuses unknown lists without touching the database', async () => {
    const rpc = vi.spyOn(dbTransport, 'rpc');
    const res = await request(app).get('/api/v1/lookups/RATING_FACTOR');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(rpc).not.toHaveBeenCalled();
  });
});
