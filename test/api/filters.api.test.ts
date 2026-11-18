import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../helpers';
import { dbTransport } from '../../src/lib/db';

afterEach(() => vi.restoreAllMocks());

describe('GET /filters/counts', () => {
  it("returns the tab's counts, checked against the declared shape", async () => {
    const rpc = vi.spyOn(dbTransport, 'rpc').mockResolvedValue({
      Positive: { value: 3, unit: 'count' },
      Resolved: { value: 71, unit: 'percent' },
    });

    const res = await request(app).get('/api/v1/filters/counts').query({ section: 'ratings' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      Positive: { value: 3, unit: 'count' },
      Resolved: { value: 71, unit: 'percent' },
    });
    expect(rpc).toHaveBeenCalledWith('app_filter_counts', { p_section: 'ratings' });
  });

  it('refuses an answer that does not match the declared shape', async () => {
    vi.spyOn(dbTransport, 'rpc').mockResolvedValue({ Positive: { value: 1.5, unit: 'count' } });
    expect((await request(app).get('/api/v1/filters/counts').query({ section: 'ratings' })).status).toBe(500);
  });

  it('refuses an unknown section, a missing one and extra parameters', async () => {
    for (const query of [{ section: 'learn' }, {}, { section: 'ratings', extra: '1' }]) {
      expect((await request(app).get('/api/v1/filters/counts').query(query)).status).toBe(400);
    }
  });
});
