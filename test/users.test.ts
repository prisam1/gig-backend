import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filesRepository } from '../src/modules/files/files.repository';
import { filesStorage } from '../src/modules/files/files.storage';
import { lookupsRepository } from '../src/modules/lookups/lookups.repository';
import { usersRepository, type Profile } from '../src/modules/users/users.repository';
import {
  AUTH_HEADER,
  FILE_ID,
  OTHER_USER_ID,
  USER_ID,
  app,
  makeFile,
  makeUser,
  signInAs,
} from './helpers';

const profile: Profile = {
  name: 'Asha Rao',
  experience: '5-10 years',
  jobProfile: 'SOFTWARE_ENGINEER',
  otherJob: null,
  location: 'Mumbai',
  avatar: { bucket: 'avatars', objectKey: `${USER_ID}/a.png` },
};

function stubProfileReads() {
  vi.spyOn(usersRepository, 'findProfile').mockResolvedValue(profile);
  vi.spyOn(usersRepository, 'findPreferences').mockResolvedValue([
    { type: 'FOCUS', code: 'WEALTH_CREATION' },
    { type: 'RISK', code: 'MODERATE' },
    { type: 'STYLE', code: 'VALUE' },
    { type: 'SECTOR', code: 'BANKING' },
    { type: 'SECTOR', code: 'ENERGY' },
  ]);
  vi.spyOn(usersRepository, 'countFollows').mockResolvedValue({ followers: 4, following: 2 });
  vi.spyOn(filesStorage, 'publicUrl').mockReturnValue('https://cdn.example/a.png');
}

/** Every code passed to the lookup check is treated as valid unless listed in `unknown`. */
function stubLookups(...unknown: string[]) {
  vi.spyOn(lookupsRepository, 'findActiveCodes').mockImplementation(async (_type, codes) =>
    codes.filter((code) => !unknown.includes(code)),
  );
}

describe('GET /me', () => {
  it('returns the full private profile', async () => {
    signInAs();
    stubProfileReads();

    const res = await request(app).get('/api/v1/me').set(AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: USER_ID,
      name: 'Asha Rao',
      email: 'asha@example.com',
      phone: '9876543210',
      avatarUrl: 'https://cdn.example/a.png',
      tier: 'OBSERVER',
      requestedTier: null,
      kycStatus: 'NOT_STARTED',
      experience: '5-10 years',
      jobProfile: 'SOFTWARE_ENGINEER',
      otherJob: null,
      location: 'Mumbai',
      preferences: {
        focus: 'WEALTH_CREATION',
        risk: 'MODERATE',
        styles: ['VALUE'],
        sectors: ['BANKING', 'ENERGY'],
      },
      followers: 4,
      following: 2,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('works before a profile exists', async () => {
    signInAs();
    vi.spyOn(usersRepository, 'findProfile').mockResolvedValue(null);
    vi.spyOn(usersRepository, 'findPreferences').mockResolvedValue([]);
    vi.spyOn(usersRepository, 'countFollows').mockResolvedValue({ followers: 0, following: 0 });

    const res = await request(app).get('/api/v1/me').set(AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: null,
      avatarUrl: null,
      preferences: { focus: null, risk: null, styles: [], sectors: [] },
    });
  });
});

describe('PATCH /me', () => {
  beforeEach(() => {
    signInAs();
    stubProfileReads();
  });

  it('updates the given fields and returns the profile', async () => {
    stubLookups();
    const upsert = vi.spyOn(usersRepository, 'upsertProfile').mockResolvedValue();

    const res = await request(app)
      .patch('/api/v1/me')
      .set(AUTH_HEADER)
      .send({ name: '  Asha Rao ', location: 'Pune', jobProfile: 'SOFTWARE_ENGINEER' });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(USER_ID);
    expect(upsert).toHaveBeenCalledWith(1, {
      name: 'Asha Rao',
      location: 'Pune',
      jobProfile: 'SOFTWARE_ENGINEER',
      otherJob: null,
    });
  });

  it('keeps the free-text job when choosing Others', async () => {
    const upsert = vi.spyOn(usersRepository, 'upsertProfile').mockResolvedValue();

    await request(app)
      .patch('/api/v1/me')
      .set(AUTH_HEADER)
      .send({ jobProfile: 'OTHERS', otherJob: 'Portfolio manager' })
      .expect(200);

    expect(upsert).toHaveBeenCalledWith(1, { jobProfile: 'OTHERS', otherJob: 'Portfolio manager' });
  });

  it('applies the app validation rules', async () => {
    const res = await request(app)
      .patch('/api/v1/me')
      .set(AUTH_HEADER)
      .send({ name: 'Ash', jobProfile: 'OTHERS' });

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({
      name: 'Name must be at least 4 characters',
      otherJob: 'Describe your job profile when choosing Others',
    });
  });

  it('rejects fields that cannot be edited here', async () => {
    const res = await request(app).patch('/api/v1/me').set(AUTH_HEADER).send({ tier: 'PRIVE' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an empty update', async () => {
    const res = await request(app).patch('/api/v1/me').set(AUTH_HEADER).send({});

    expect(res.status).toBe(400);
    expect(res.body.error.fields._root).toBe('Provide at least one field to update');
  });

  it('rejects an unknown job profile', async () => {
    stubLookups('ASTRONAUT');

    const res = await request(app)
      .patch('/api/v1/me')
      .set(AUTH_HEADER)
      .send({ jobProfile: 'ASTRONAUT' });

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ jobProfile: 'Unknown job profile' });
  });

  it('sets the avatar from an uploaded AVATAR file', async () => {
    vi.spyOn(filesRepository, 'findOwned').mockResolvedValue([
      makeFile({ id: 77, purpose: 'AVATAR' }),
    ]);
    const upsert = vi.spyOn(usersRepository, 'upsertProfile').mockResolvedValue();

    await request(app)
      .patch('/api/v1/me')
      .set(AUTH_HEADER)
      .send({ avatarFileId: FILE_ID })
      .expect(200);

    expect(upsert).toHaveBeenCalledWith(1, { avatarFileId: 77 });
  });

  it('rejects an avatar file uploaded for another purpose or by someone else', async () => {
    vi.spyOn(filesRepository, 'findOwned').mockResolvedValue([
      makeFile({ purpose: 'KYC_DOCUMENT' }),
    ]);

    const res = await request(app)
      .patch('/api/v1/me')
      .set(AUTH_HEADER)
      .send({ avatarFileId: FILE_ID });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.avatarFileId).toBeDefined();
  });
});

describe('PUT /me/preferences', () => {
  const valid = {
    focus: 'WEALTH_CREATION',
    risk: 'MODERATE',
    styles: ['VALUE', 'GROWTH'],
    sectors: ['BANKING'],
  };

  beforeEach(() => {
    signInAs();
  });

  it('replaces all preferences', async () => {
    stubLookups();
    const replace = vi.spyOn(usersRepository, 'replacePreferences').mockResolvedValue();

    const res = await request(app).put('/api/v1/me/preferences').set(AUTH_HEADER).send(valid);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(valid);
    expect(replace).toHaveBeenCalledWith(1, [
      { type: 'FOCUS', code: 'WEALTH_CREATION' },
      { type: 'RISK', code: 'MODERATE' },
      { type: 'STYLE', code: 'VALUE' },
      { type: 'STYLE', code: 'GROWTH' },
      { type: 'SECTOR', code: 'BANKING' },
    ]);
  });

  it('allows at most 3 styles and no duplicates', async () => {
    const res = await request(app)
      .put('/api/v1/me/preferences')
      .set(AUTH_HEADER)
      .send({ ...valid, styles: ['A', 'B', 'C', 'D'], sectors: ['BANKING', 'BANKING'] });

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({
      styles: 'Choose up to 3 styles',
      sectors: 'Each sectors can be chosen once',
    });
  });

  it('rejects option codes that are not in the lookup lists', async () => {
    stubLookups('CRYPTO_ONLY', 'SPACE');
    const replace = vi.spyOn(usersRepository, 'replacePreferences');

    const res = await request(app)
      .put('/api/v1/me/preferences')
      .set(AUTH_HEADER)
      .send({ ...valid, styles: ['VALUE', 'CRYPTO_ONLY'], sectors: ['SPACE'] });

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({
      styles: 'Unknown option: CRYPTO_ONLY',
      sectors: 'Unknown option: SPACE',
    });
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('PUT /me/tier', () => {
  it('applies Observer immediately', async () => {
    signInAs(makeUser({ tier: 'PRIVE', kycStatus: 'APPROVED' }));
    const update = vi
      .spyOn(usersRepository, 'updateTier')
      .mockResolvedValue(makeUser({ tier: 'OBSERVER', kycStatus: 'APPROVED' }));

    const res = await request(app)
      .put('/api/v1/me/tier')
      .set(AUTH_HEADER)
      .send({ tier: 'OBSERVER' });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(1, 'OBSERVER', null);
    expect(res.body.data).toEqual({
      tier: 'OBSERVER',
      requestedTier: null,
      kycStatus: 'APPROVED',
      nextStep: null,
    });
  });

  it('records Prive as requested and asks for KYC', async () => {
    signInAs();
    const update = vi
      .spyOn(usersRepository, 'updateTier')
      .mockResolvedValue(makeUser({ requestedTier: 'PRIVE' }));

    const res = await request(app).put('/api/v1/me/tier').set(AUTH_HEADER).send({ tier: 'PRIVE' });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(1, 'OBSERVER', 'PRIVE');
    expect(res.body.data).toMatchObject({
      tier: 'OBSERVER',
      requestedTier: 'PRIVE',
      nextStep: 'SUBMIT_KYC',
    });
  });

  it('clears the request when choosing the tier the user already has', async () => {
    signInAs(makeUser({ tier: 'PRIVE', requestedTier: 'INSTITUTIONAL' }));
    const update = vi
      .spyOn(usersRepository, 'updateTier')
      .mockResolvedValue(makeUser({ tier: 'PRIVE' }));

    await request(app).put('/api/v1/me/tier').set(AUTH_HEADER).send({ tier: 'PRIVE' }).expect(200);

    expect(update).toHaveBeenCalledWith(1, 'PRIVE', null);
  });

  it('blocks tier changes while KYC is under review', async () => {
    signInAs(makeUser({ requestedTier: 'PRIVE', kycStatus: 'PENDING' }));

    const res = await request(app)
      .put('/api/v1/me/tier')
      .set(AUTH_HEADER)
      .send({ tier: 'OBSERVER' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KYC_PENDING');
  });

  it('rejects unknown tiers', async () => {
    signInAs();

    const res = await request(app).put('/api/v1/me/tier').set(AUTH_HEADER).send({ tier: 'GOLD' });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.tier).toBeDefined();
  });
});

describe('GET /users/:id', () => {
  beforeEach(() => {
    signInAs();
    stubProfileReads();
  });

  it('returns the public profile without contact details', async () => {
    vi.spyOn(usersRepository, 'findByPublicId').mockResolvedValue(
      makeUser({ id: 2, publicId: OTHER_USER_ID, tier: 'PRIVE', kycStatus: 'APPROVED' }),
    );

    const res = await request(app).get(`/api/v1/users/${OTHER_USER_ID}`).set(AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: OTHER_USER_ID,
      name: 'Asha Rao',
      avatarUrl: 'https://cdn.example/a.png',
      tier: 'PRIVE',
      verified: true,
      location: 'Mumbai',
      followers: 4,
      following: 2,
      memberSince: '2026-10-01T00:00:00.000Z',
    });
    expect(res.body.data).not.toHaveProperty('email');
    expect(res.body.data).not.toHaveProperty('phone');
  });

  it('returns 404 for unknown or suspended users', async () => {
    vi.spyOn(usersRepository, 'findByPublicId').mockResolvedValue(
      makeUser({ publicId: OTHER_USER_ID, status: 'SUSPENDED' }),
    );

    const res = await request(app).get(`/api/v1/users/${OTHER_USER_ID}`).set(AUTH_HEADER);

    expect(res.status).toBe(404);
  });

  it('rejects IDs that are not UUIDs', async () => {
    const res = await request(app).get('/api/v1/users/42').set(AUTH_HEADER);

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ id: 'Invalid user ID' });
  });
});

describe('POST / DELETE /users/:id/follow', () => {
  beforeEach(() => {
    signInAs();
    vi.spyOn(usersRepository, 'findByPublicId').mockResolvedValue(
      makeUser({ id: 2, publicId: OTHER_USER_ID }),
    );
  });

  it('follows another user', async () => {
    const follow = vi.spyOn(usersRepository, 'follow').mockResolvedValue();

    await request(app).post(`/api/v1/users/${OTHER_USER_ID}/follow`).set(AUTH_HEADER).expect(204);

    expect(follow).toHaveBeenCalledWith(1, 2);
  });

  it('unfollows another user', async () => {
    const unfollow = vi.spyOn(usersRepository, 'unfollow').mockResolvedValue();

    await request(app).delete(`/api/v1/users/${OTHER_USER_ID}/follow`).set(AUTH_HEADER).expect(204);

    expect(unfollow).toHaveBeenCalledWith(1, 2);
  });

  it('does not allow following yourself', async () => {
    const res = await request(app).post(`/api/v1/users/${USER_ID}/follow`).set(AUTH_HEADER);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('You cannot follow yourself');
  });
});
