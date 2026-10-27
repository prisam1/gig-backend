import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filesStorage } from '../src/modules/files/files.storage';
import { usersRepository, type PublicUser } from '../src/modules/users/users.repository';
import { AUTH_HEADER, OTHER_USER_ID, USER_ID, app, signInAs } from './helpers';

function makePublicUser(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: '2',
    publicId: OTHER_USER_ID,
    tier: 'PRIVE',
    kycStatus: 'APPROVED',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    name: 'Asha Rao',
    location: 'Mumbai',
    avatarBucket: 'avatars',
    avatarObjectKey: `${OTHER_USER_ID}/a.png`,
    ...overrides,
  };
}

describe('GET /users/:id', () => {
  beforeEach(() => {
    signInAs();
    vi.spyOn(usersRepository, 'countFollows').mockResolvedValue({ followers: 4, following: 2 });
    vi.spyOn(filesStorage, 'publicUrl').mockReturnValue('https://cdn.example/a.png');
  });

  it('returns the public profile without contact details', async () => {
    vi.spyOn(usersRepository, 'findActiveByPublicId').mockResolvedValue(makePublicUser());

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
    // Only ACTIVE users are returned by the repository.
    vi.spyOn(usersRepository, 'findActiveByPublicId').mockResolvedValue(null);

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
    vi.spyOn(usersRepository, 'findActiveByPublicId').mockResolvedValue(makePublicUser());
  });

  it('follows another user', async () => {
    const follow = vi.spyOn(usersRepository, 'follow').mockResolvedValue();

    await request(app).post(`/api/v1/users/${OTHER_USER_ID}/follow`).set(AUTH_HEADER).expect(204);

    expect(follow).toHaveBeenCalledWith('1', '2');
  });

  it('unfollows another user', async () => {
    const unfollow = vi.spyOn(usersRepository, 'unfollow').mockResolvedValue();

    await request(app).delete(`/api/v1/users/${OTHER_USER_ID}/follow`).set(AUTH_HEADER).expect(204);

    expect(unfollow).toHaveBeenCalledWith('1', '2');
  });

  it('does not allow following yourself', async () => {
    const res = await request(app).post(`/api/v1/users/${USER_ID}/follow`).set(AUTH_HEADER);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('You cannot follow yourself');
  });
});
