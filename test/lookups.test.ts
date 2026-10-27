import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { lookupsRepository } from '../src/modules/lookups/lookups.repository';
import { app } from './helpers';

describe('GET /lookups/:type', () => {
  it('is public and returns active options for the type', async () => {
    const options = [{ code: 'VALUE', label: 'Value' }];
    const findActive = vi.spyOn(lookupsRepository, 'findActive').mockResolvedValue(options);

    const res = await request(app).get('/api/v1/lookups/styles');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(options);
    expect(findActive).toHaveBeenCalledWith('STYLE');
  });

  it('maps multi-word slugs', async () => {
    const findActive = vi.spyOn(lookupsRepository, 'findActive').mockResolvedValue([]);

    await request(app).get('/api/v1/lookups/job-profiles');

    expect(findActive).toHaveBeenCalledWith('JOB_PROFILE');
  });

  it('returns 404 for an unknown type', async () => {
    const res = await request(app).get('/api/v1/lookups/planets');

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('Unknown lookup type "planets"');
  });
});
