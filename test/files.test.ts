import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filesRepository } from '../src/modules/files/files.repository';
import { filesStorage } from '../src/modules/files/files.storage';
import { AUTH_HEADER, USER_ID, app, makeFile, signInAs } from './helpers';

describe('POST /files/upload-url', () => {
  beforeEach(() => {
    signInAs();
  });

  it('creates a file record and returns a signed upload URL', async () => {
    const createUploadUrl = vi
      .spyOn(filesStorage, 'createUploadUrl')
      .mockResolvedValue('https://storage.example/upload?token=abc');
    const create = vi.spyOn(filesRepository, 'create').mockResolvedValue(makeFile());

    const res = await request(app)
      .post('/api/v1/files/upload-url')
      .set(AUTH_HEADER)
      .send({ purpose: 'KYC_DOCUMENT', mimeType: 'application/pdf', sizeBytes: 2048 });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      fileId: makeFile().publicId,
      path: expect.stringMatching(new RegExp(`^${USER_ID}/[0-9a-f-]{36}\\.pdf$`)),
      uploadUrl: 'https://storage.example/upload?token=abc',
      method: 'PUT',
      contentType: 'application/pdf',
    });

    const [bucket, objectKey] = createUploadUrl.mock.calls[0]!;
    expect(bucket).toBe('kyc-documents');
    expect(objectKey).toMatch(new RegExp(`^${USER_ID}/[0-9a-f-]{36}\\.pdf$`));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: '1', purpose: 'KYC_DOCUMENT', objectKey, sizeBytes: 2048 }),
    );
  });

  it('rejects disallowed file types and files over 10 MB', async () => {
    const res = await request(app)
      .post('/api/v1/files/upload-url')
      .set(AUTH_HEADER)
      .send({ purpose: 'KYC_DOCUMENT', mimeType: 'application/zip', sizeBytes: 11 * 1024 * 1024 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: {
        mimeType: 'Only PDF, JPG and PNG files are allowed',
        sizeBytes: 'File must be 10 MB or smaller',
      },
    });
  });

  it('rejects fields the endpoint does not take', async () => {
    const res = await request(app)
      .post('/api/v1/files/upload-url')
      .set(AUTH_HEADER)
      .send({ purpose: 'AVATAR', mimeType: 'image/png', sizeBytes: 100, objectKey: 'someone-else/x.png' });

    expect(res.status).toBe(400);
  });

  it('rejects a PDF avatar', async () => {
    const res = await request(app)
      .post('/api/v1/files/upload-url')
      .set(AUTH_HEADER)
      .send({ purpose: 'AVATAR', mimeType: 'application/pdf', sizeBytes: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ mimeType: 'Avatar must be a JPG or PNG image' });
  });
});
