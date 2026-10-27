import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { filesRepository } from '../src/modules/files/files.repository';
import { filesStorage } from '../src/modules/files/files.storage';
import { kycRepository } from '../src/modules/kyc/kyc.repository';
import { KYC_CONSENT_VERSION } from '../src/modules/kyc/kyc.service';
import { AUTH_HEADER, FILE_ID, app, makeFile, makeUser, signInAs } from './helpers';

const SUBMISSION_ID = '44444444-4444-4444-8444-444444444444';
const validBody = {
  documents: [{ fileId: FILE_ID, documentType: 'ID_PROOF' }],
  consentAccepted: true,
};

function submitKyc(body: object = validBody) {
  return request(app)
    .post('/api/v1/kyc/submissions')
    .set(AUTH_HEADER)
    .set('X-App-Version', '1.4.0')
    .send(body);
}

describe('POST /kyc/submissions', () => {
  beforeEach(() => {
    vi.spyOn(filesStorage, 'exists').mockResolvedValue(true);
  });

  it('submits documents and consent for the requested tier', async () => {
    signInAs(makeUser({ requestedTier: 'PRIVE' }));
    vi.spyOn(filesRepository, 'findOwned').mockResolvedValue([makeFile({ id: '10' })]);
    const submit = vi.spyOn(kycRepository, 'submit').mockResolvedValue(SUBMISSION_ID);

    const res = await submitKyc();

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ id: SUBMISSION_ID, tier: 'PRIVE', status: 'PENDING' });
    expect(submit).toHaveBeenCalledWith(
      {
        userId: '1',
        tier: 'PRIVE',
        documents: [{ fileId: '10', documentType: 'ID_PROOF' }],
        consentVersion: KYC_CONSENT_VERSION,
      },
      expect.objectContaining({ ip: expect.any(String), appVersion: '1.4.0' }),
    );
  });

  it('does not require consent for Institutional', async () => {
    signInAs(makeUser({ requestedTier: 'INSTITUTIONAL' }));
    vi.spyOn(filesRepository, 'findOwned').mockResolvedValue([makeFile()]);
    const submit = vi.spyOn(kycRepository, 'submit').mockResolvedValue(SUBMISSION_ID);

    const res = await submitKyc({ documents: validBody.documents });

    expect(res.status).toBe(201);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ consentVersion: null }), expect.anything());
  });

  it('requires consent for Prive', async () => {
    signInAs(makeUser({ requestedTier: 'PRIVE' }));

    const res = await submitKyc({ ...validBody, consentAccepted: false });

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({
      consentAccepted: 'Consent is required for Prive verification',
    });
  });

  it('requires choosing a verified tier first', async () => {
    signInAs(makeUser({ requestedTier: null }));

    const res = await submitKyc();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TIER_NOT_REQUESTED');
  });

  it('rejects a second submission while one is pending', async () => {
    signInAs(makeUser({ requestedTier: 'PRIVE', kycStatus: 'PENDING' }));

    const res = await submitKyc();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KYC_ALREADY_PENDING');
  });

  it('turns a concurrent duplicate submission into 409', async () => {
    signInAs(makeUser({ requestedTier: 'PRIVE' }));
    vi.spyOn(filesRepository, 'findOwned').mockResolvedValue([makeFile()]);
    vi.spyOn(kycRepository, 'submit').mockRejectedValue(
      new postgres.PostgresError({ code: '23505', message: 'duplicate key value' } as never),
    );

    const res = await submitKyc();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KYC_ALREADY_PENDING');
  });

  it('rejects files the user does not own or uploaded for another purpose', async () => {
    signInAs(makeUser({ requestedTier: 'PRIVE' }));
    const secondFileId = '55555555-5555-4555-8555-555555555555';
    vi.spyOn(filesRepository, 'findOwned').mockResolvedValue([makeFile({ purpose: 'AVATAR' })]);
    const submit = vi.spyOn(kycRepository, 'submit');

    const res = await submitKyc({
      ...validBody,
      documents: [
        { fileId: FILE_ID, documentType: 'ID_PROOF' },
        { fileId: secondFileId, documentType: 'ADDRESS_PROOF' },
      ],
    });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.fields)).toEqual([
      'documents.0.fileId',
      'documents.1.fileId',
    ]);
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects a document whose file was never uploaded to Storage', async () => {
    signInAs(makeUser({ requestedTier: 'PRIVE' }));
    vi.spyOn(filesRepository, 'findOwned').mockResolvedValue([makeFile()]);
    vi.spyOn(filesStorage, 'exists').mockResolvedValue(false);
    const submit = vi.spyOn(kycRepository, 'submit');

    const res = await submitKyc();

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ 'documents.0.fileId': 'File has not been uploaded yet' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('validates the document list', async () => {
    signInAs(makeUser({ requestedTier: 'PRIVE' }));

    const empty = await submitKyc({ documents: [], consentAccepted: true });
    const duplicate = await submitKyc({
      documents: [validBody.documents[0], validBody.documents[0]],
      consentAccepted: true,
    });
    const badType = await submitKyc({
      documents: [{ fileId: FILE_ID, documentType: 'SELFIE' }],
      consentAccepted: true,
    });

    expect(empty.body.error.fields).toEqual({ documents: 'Upload at least one document' });
    expect(duplicate.body.error.fields).toEqual({ documents: 'Each file can be attached once' });
    expect(badType.body.error.fields['documents.0.documentType']).toBeDefined();
  });
});

describe('GET /kyc/submissions/me', () => {
  it('returns the status and latest submission with the rejection reason', async () => {
    signInAs(makeUser({ requestedTier: 'PRIVE', kycStatus: 'REJECTED' }));
    vi.spyOn(kycRepository, 'findLatest').mockResolvedValue({
      publicId: SUBMISSION_ID,
      tier: 'PRIVE',
      status: 'REJECTED',
      reason: 'ID photo is blurred',
      submittedAt: new Date('2026-10-20T10:00:00.000Z'),
      reviewedAt: new Date('2026-10-21T09:00:00.000Z'),
      documents: [{ fileId: FILE_ID, documentType: 'ID_PROOF' }],
    });

    const res = await request(app).get('/api/v1/kyc/submissions/me').set(AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      kycStatus: 'REJECTED',
      tier: 'OBSERVER',
      requestedTier: 'PRIVE',
      submission: {
        id: SUBMISSION_ID,
        tier: 'PRIVE',
        status: 'REJECTED',
        rejectionReason: 'ID photo is blurred',
        submittedAt: '2026-10-20T10:00:00.000Z',
        reviewedAt: '2026-10-21T09:00:00.000Z',
        documents: [{ fileId: FILE_ID, documentType: 'ID_PROOF' }],
      },
    });
  });

  it('returns a null submission when the user has never submitted', async () => {
    signInAs();
    vi.spyOn(kycRepository, 'findLatest').mockResolvedValue(null);

    const res = await request(app).get('/api/v1/kyc/submissions/me').set(AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      kycStatus: 'NOT_STARTED',
      tier: 'OBSERVER',
      requestedTier: null,
      submission: null,
    });
  });
});
