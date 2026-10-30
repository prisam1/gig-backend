import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { dbTransport } from '../src/lib/db';
import { app } from './helpers';

describe('GET /lookups/:type', () => {
  it('serves the sign-up choices without a token, cached for 5 minutes', async () => {
    const rpc = vi.spyOn(dbTransport, 'rpc').mockResolvedValue([{ code: '+91', label: 'India' }]);

    const res = await request(app).get('/api/v1/lookups/country-codes').expect(200);

    expect(res.body).toEqual({ data: [{ code: '+91', label: 'India' }] });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(rpc).toHaveBeenCalledWith('app_list_options', { p_type: 'COUNTRY_CODE' });
  });

  it.each([
    ['country-codes', 'COUNTRY_CODE'],
    ['job-profiles', 'JOB_PROFILE'],
    ['investment-focus', 'INVESTMENT_FOCUS'],
    ['risk-levels', 'RISK_LEVEL'],
    ['investment-styles', 'INVESTMENT_STYLE'],
    ['investment-sectors', 'INVESTMENT_SECTOR'],
    ['tiers', 'TIER'],
  ])('maps /lookups/%s to the %s list', async (path, type) => {
    const rpc = vi.spyOn(dbTransport, 'rpc').mockResolvedValue([]);
    await request(app).get(`/api/v1/lookups/${path}`).expect(200);
    expect(rpc).toHaveBeenCalledWith('app_list_options', { p_type: type });
  });

  it('refuses unknown lists without touching the database', async () => {
    const rpc = vi.spyOn(dbTransport, 'rpc');
    const res = await request(app).get('/api/v1/lookups/COUNTRY_CODE');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(rpc).not.toHaveBeenCalled();
  });
});
