import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member } from '../../src/lib/membership';
import { filesRepository } from '../../src/modules/files/files.repository';
import { filesStorage } from '../../src/modules/files/files.storage';
import {
  representationClosed,
  representationsRepository,
  type NewSignature,
  type Representation,
  type StatusChange,
  type StoredDocument,
  type StoredSignature,
} from '../../src/modules/representations/representations.repository';
import {
  SIGNATURE_CONSENT_VERSION,
  SIGNATURE_CONSENTS,
} from '../../src/modules/representations/representations.service';
import { listOptions } from '../../src/modules/users/users.service';
import { AUTH_HEADER, FILE_ID, USER_ID, app, makeFile, makeUser, signInAs } from '../helpers';
import { uniqueViolation } from '../helpers/dbErrors';

vi.mock('../../src/modules/users/users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/modules/users/users.service')>()),
  listOptions: vi.fn(),
}));

const REPRESENTATION_ID = '6c3e0000-0000-4000-8000-000000000001';
const DOWNLOAD_URL = 'https://storage.test/signed/receipt.pdf?token=abc';

const petition: Representation = {
  internalId: '7',
  id: REPRESENTATION_ID,
  slug: 'mandatory-t1-settlement-disclosure',
  title: 'Mandatory T+1 Settlement Disclosure',
  description: 'Require brokers to disclose T+1 settlement risks.',
  asks: ['Mandatory pre-trade settlement cost disclosure'],
  whyItMatters: 'First-time investors need a clear explanation of settlement risk.',
  category: 'Market structure',
  country: 'IN',
  tags: ['India'],
  regulators: ['SEBI'],
  goal: 1000,
  signatureCount: 124,
  voteCount: 120,
  progressPercent: 12.4,
  opensAt: new Date('2026-10-01T00:00:00.000Z'),
  closesAt: new Date('2026-11-02T00:00:00.000Z'),
  daysLeft: 6,
  trackStatus: 'CLOSING_SOON',
  isOpenForSigning: true,
  createdAt: new Date('2026-09-30T00:00:00.000Z'),
};

const evidence: StoredDocument = {
  id: 'd0c00000-0000-4000-8000-000000000001',
  title: 'Primary Research Brief',
  documentType: 'EVIDENCE',
  file: {
    bucket: 'representation-documents',
    objectKey: 'rep/brief.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1258291,
  },
};

const mySignature: StoredSignature = {
  publicId: '5f9e0000-0000-4000-8000-000000000001',
  signatureCode: 'GIG-ET7ZWDTZK',
  displayMode: 'INITIALS',
  signerName: 'Shreya Mehta',
  investorType: 'RETAIL_EXPERIENCED',
  signerTier: 'PRIVE',
  createdAt: new Date('2026-10-27T10:24:07.000Z'),
};

const validBody = {
  displayMode: 'INITIALS',
  investorType: 'RETAIL_EXPERIENCED',
  signatureFileId: FILE_ID,
  consents: { supportSubmission: true, digitalEndorsement: true },
};

const verifiedPrive = () =>
  makeUser({ tier: 'PRIVE', kycStatus: 'APPROVED', fullName: 'Shreya Mehta' });

function stubStorage() {
  const upload = vi.spyOn(filesStorage, 'upload').mockResolvedValue();
  const download = vi.spyOn(filesStorage, 'createDownloadUrl').mockResolvedValue(DOWNLOAD_URL);
  const exists = vi.spyOn(filesStorage, 'exists').mockResolvedValue(true);
  return { upload, download, exists };
}

function stubInvestorTypes() {
  vi.mocked(listOptions).mockResolvedValue([
    { code: 'RETAIL_EXPERIENCED', label: 'Retail Investor (Experienced Investors)' },
  ]);
}

/** Everything a successful signature touches; returns the repository's sign() spy. */
function stubSigning() {
  vi.spyOn(representationsRepository, 'findByIdempotencyKey').mockResolvedValue(null);
  vi.spyOn(representationsRepository, 'findById').mockResolvedValue(petition);
  vi.spyOn(filesRepository, 'findOwned').mockResolvedValue([
    makeFile({
      id: '42',
      purpose: 'SIGNATURE',
      bucket: 'signatures',
      objectKey: `${USER_ID}/sig.png`,
    }),
  ]);
  stubInvestorTypes();
  const storage = stubStorage();
  const sign = vi
    .spyOn(representationsRepository, 'sign')
    .mockImplementation((signature: NewSignature) => {
      vi.spyOn(representationsRepository, 'findSignature').mockResolvedValue({
        ...mySignature,
        signatureCode: signature.signatureCode,
      });
      return Promise.resolve();
    });
  return { sign, storage };
}

function signPetition(body: object = validBody, key: string | null = 'signature-key-0001') {
  const req = request(app)
    .post(`/api/v1/representations/${REPRESENTATION_ID}/signatures`)
    .set(AUTH_HEADER)
    .set('X-App-Version', '1.4.0');
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
}

// ---------------------------------------------------------------------------------------------
describe('GET /representations', () => {
  it('lists petitions with goal, signatures, progress, days left and track status', async () => {
    const find = vi
      .spyOn(representationsRepository, 'findAll')
      .mockResolvedValue({ items: [petition], total: 1 });

    const res = await request(app).get('/api/v1/representations').query({
      q: 'T+1',
      sort: 'most_signed',
      'filter[status]': 'OPEN,CLOSING_SOON',
      'filter[country]': 'IN',
    });

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(res.body.data[0]).toEqual({
      id: REPRESENTATION_ID,
      slug: 'mandatory-t1-settlement-disclosure',
      title: 'Mandatory T+1 Settlement Disclosure',
      description: 'Require brokers to disclose T+1 settlement risks.',
      category: 'Market structure',
      country: 'IN',
      tags: ['India'],
      goal: 1000,
      signatureCount: 124,
      voteCount: 120,
      progressPercent: 12.4,
      opensAt: '2026-10-01T00:00:00.000Z',
      closesAt: '2026-11-02T00:00:00.000Z',
      daysLeft: 6,
      trackStatus: 'CLOSING_SOON',
      trackLabel: 'Closing Soon',
      isOpenForSigning: true,
      createdAt: '2026-09-30T00:00:00.000Z',
    });
    expect(find).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      q: 'T+1',
      sort: 'most_signed',
      filter: { status: ['OPEN', 'CLOSING_SOON'], country: ['IN'] },
    });
  });

  it("rejects the app's labels instead of status codes", async () => {
    const res = await request(app)
      .get('/api/v1/representations')
      .query({ 'filter[status]': 'Under Review by GIG' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /representations/:id', () => {
  const url = `/api/v1/representations/${REPRESENTATION_ID}`;

  beforeEach(() => {
    vi.spyOn(representationsRepository, 'findById').mockResolvedValue(petition);
    vi.spyOn(representationsRepository, 'findEvidence').mockResolvedValue([evidence]);
    vi.spyOn(representationsRepository, 'findSigners').mockResolvedValue([
      {
        id: 's1',
        displayName: 'S. M.',
        isAnonymous: false,
        investorType: {
          code: 'RETAIL_EXPERIENCED',
          label: 'Retail Investor (Experienced Investors)',
        },
        isVerified: true,
        signedAt: new Date('2026-10-27T10:24:07.000Z'),
      },
      {
        id: 's2',
        displayName: null,
        isAnonymous: true,
        investorType: null,
        isVerified: true,
        signedAt: new Date('2026-10-26T09:00:00.000Z'),
      },
    ]);
    stubInvestorTypes();
  });

  it('returns overview, evidence links and signers to visitors', async () => {
    const { download } = stubStorage();
    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({
      id: REPRESENTATION_ID,
      trackLabel: 'Closing Soon',
      overview: {
        asks: ['Mandatory pre-trade settlement cost disclosure'],
        whyItMatters: 'First-time investors need a clear explanation of settlement risk.',
        regulators: ['SEBI'],
        disclaimer: expect.stringContaining('GIG facilitates collection and submission'),
      },
      evidence: [
        {
          id: evidence.id,
          title: 'Primary Research Brief',
          type: 'EVIDENCE',
          mimeType: 'application/pdf',
          sizeBytes: 1258291,
          downloadUrl: DOWNLOAD_URL,
        },
      ],
      signers: { total: 124 },
      mySignature: null,
    });
    expect(res.body.data.signers.recent).toHaveLength(2);
    expect(res.body.data).not.toHaveProperty('internalId');
    expect(download).toHaveBeenCalledWith('representation-documents', 'rep/brief.pdf', 300);
  });

  it("includes the signed-in user's signature with a link to the stored receipt", async () => {
    signInAs(verifiedPrive());
    vi.spyOn(representationsRepository, 'findSignature').mockResolvedValue(mySignature);
    const { upload, download } = stubStorage();

    const res = await request(app).get(url).set(AUTH_HEADER);

    expect(res.body.data.mySignature).toEqual({
      signatureId: 'GIG-ET7ZWDTZK',
      displayMode: 'INITIALS',
      signedAt: '2026-10-27T10:24:07.000Z',
      receiptPdf: { url: DOWNLOAD_URL, expiresAt: expect.any(String) },
    });
    expect(upload).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledWith(
      'signature-receipts',
      `${USER_ID}/GIG-ET7ZWDTZK.pdf`,
      300,
    );
  });

  it('regenerates a missing receipt PDF', async () => {
    signInAs(verifiedPrive());
    vi.spyOn(representationsRepository, 'findSignature').mockResolvedValue(mySignature);
    const { upload, exists } = stubStorage();
    exists.mockResolvedValue(false);

    await request(app).get(url).set(AUTH_HEADER).expect(200);

    expect(upload).toHaveBeenCalledWith(
      'signature-receipts',
      `${USER_ID}/GIG-ET7ZWDTZK.pdf`,
      expect.any(Uint8Array),
      'application/pdf',
    );
  });

  it('returns 404 for an unknown petition', async () => {
    vi.spyOn(representationsRepository, 'findById').mockResolvedValue(null);
    expect((await request(app).get(url)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /representations/:id/timeline', () => {
  const url = `/api/v1/representations/${REPRESENTATION_ID}/timeline`;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-15T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns the 9 track steps with when each was reached, and the history', async () => {
    vi.spyOn(representationsRepository, 'findById').mockResolvedValue({
      ...petition,
      trackStatus: 'SUBMITTED_TO_REGULATOR',
      isOpenForSigning: false,
    });
    const history: StatusChange[] = [
      {
        fromStatus: null,
        toStatus: 'OPEN',
        note: null,
        occurredAt: new Date('2026-10-01T00:00:00.000Z'),
        documents: [],
      },
      {
        fromStatus: 'OPEN',
        toStatus: 'UNDER_REVIEW',
        note: 'Reviewing signatures',
        occurredAt: new Date('2026-11-05T00:00:00.000Z'),
        documents: [],
      },
      {
        fromStatus: 'UNDER_REVIEW',
        toStatus: 'SUBMITTED_TO_REGULATOR',
        note: 'Sent to SEBI',
        occurredAt: new Date('2026-11-20T00:00:00.000Z'),
        documents: [{ ...evidence, title: 'Submission pack', documentType: 'SUBMISSION_PACK' }],
      },
    ];
    vi.spyOn(representationsRepository, 'findStatusHistory').mockResolvedValue(history);
    stubStorage();

    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.body.data.currentStatus).toBe('SUBMITTED_TO_REGULATOR');
    expect(res.body.data.steps).toEqual([
      { status: 'OPEN', label: 'Open', reachedAt: '2026-10-01T00:00:00.000Z', isCurrent: false },
      {
        status: 'CLOSING_SOON',
        label: 'Closing Soon',
        reachedAt: '2026-10-26T00:00:00.000Z',
        isCurrent: false,
      },
      {
        status: 'CLOSED',
        label: 'Closed',
        reachedAt: '2026-11-02T00:00:00.000Z',
        isCurrent: false,
      },
      {
        status: 'UNDER_REVIEW',
        label: 'Under Review by GIG',
        reachedAt: '2026-11-05T00:00:00.000Z',
        isCurrent: false,
      },
      {
        status: 'SUBMITTED_TO_REGULATOR',
        label: 'Submitted to Reg.',
        reachedAt: '2026-11-20T00:00:00.000Z',
        isCurrent: true,
      },
      {
        status: 'MEETING_REQUESTED',
        label: 'Meeting Requested',
        reachedAt: null,
        isCurrent: false,
      },
      {
        status: 'MEETING_SCHEDULED',
        label: 'Meeting Scheduled',
        reachedAt: null,
        isCurrent: false,
      },
      { status: 'REGULATOR_RESPONDED', label: 'Reg. Responded', reachedAt: null, isCurrent: false },
      { status: 'RESOLVED', label: 'Resolved / Closed', reachedAt: null, isCurrent: false },
    ]);
    expect(res.body.data.history[2]).toMatchObject({
      toStatus: 'SUBMITTED_TO_REGULATOR',
      label: 'Submitted to Reg.',
      note: 'Sent to SEBI',
      documents: [{ title: 'Submission pack', type: 'SUBMISSION_PACK', downloadUrl: DOWNLOAD_URL }],
    });
  });

  it('shows only Open as reached for a petition still collecting signatures', async () => {
    vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
    vi.spyOn(representationsRepository, 'findById').mockResolvedValue({
      ...petition,
      trackStatus: 'OPEN',
    });
    vi.spyOn(representationsRepository, 'findStatusHistory').mockResolvedValue([]);

    const res = await request(app).get(url);
    const reached = res.body.data.steps.filter((s: { reachedAt: string | null }) => s.reachedAt);
    expect(reached.map((s: { status: string }) => s.status)).toEqual(['OPEN']);
  });
});

// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
describe('GET /representations/:id/submission', () => {
  const url = `/api/v1/representations/${REPRESENTATION_ID}/submission`;
  const pack: StoredDocument = {
    ...evidence,
    id: 'd0c00000-0000-4000-8000-000000000009',
    title: 'Submission pack',
    documentType: 'SUBMISSION_PACK',
    file: { ...evidence.file, objectKey: 'rep/pack.pdf' },
  };

  beforeEach(() => {
    vi.spyOn(representationsRepository, 'findById').mockResolvedValue({
      ...petition,
      trackStatus: 'SUBMITTED_TO_REGULATOR',
      isOpenForSigning: false,
    });
  });

  it('requires sign-in', async () => {
    expect((await request(app).get(url)).status).toBe(401);
  });

  it.each([
    ['Observer', makeUser()],
    ['Prive without approved KYC', makeUser({ tier: 'PRIVE', kycStatus: 'PENDING' })],
  ] as [string, Member][])('is not available to %s', async (_label, user) => {
    signInAs(user);
    expect((await request(app).get(url).set(AUTH_HEADER)).status).toBe(403);
  });

  it.each([
    ['verified Prive', verifiedPrive()],
    ['Institutional', makeUser({ tier: 'INSTITUTIONAL', kycStatus: 'APPROVED' })],
  ] as [string, Member][])('gives %s members a download link to the pack', async (_label, user) => {
    signInAs(user);
    vi.spyOn(representationsRepository, 'findLatestSubmissionPack').mockResolvedValue(pack);
    const { download } = stubStorage();

    const res = await request(app).get(url).set(AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toEqual({
      id: pack.id,
      title: 'Submission pack',
      type: 'SUBMISSION_PACK',
      mimeType: 'application/pdf',
      sizeBytes: 1258291,
      downloadUrl: DOWNLOAD_URL,
    });
    expect(download).toHaveBeenCalledWith('representation-documents', 'rep/pack.pdf', 300);
  });

  it('returns 404 until the petition has been submitted', async () => {
    signInAs(verifiedPrive());
    vi.spyOn(representationsRepository, 'findLatestSubmissionPack').mockResolvedValue(null);
    const res = await request(app).get(url).set(AUTH_HEADER);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SUBMISSION_NOT_AVAILABLE');
  });

  it('returns 404 for an unknown petition', async () => {
    signInAs(verifiedPrive());
    vi.spyOn(representationsRepository, 'findById').mockResolvedValue(null);
    expect((await request(app).get(url).set(AUTH_HEADER)).status).toBe(404);
  });
});

describe('POST /representations/:id/signatures: access and validation', () => {
  it('requires sign-in', async () => {
    const res = await request(app)
      .post(`/api/v1/representations/${REPRESENTATION_ID}/signatures`)
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it.each([
    ['Observer', makeUser(), 'FORBIDDEN'],
    ['Institutional', makeUser({ tier: 'INSTITUTIONAL', kycStatus: 'APPROVED' }), 'FORBIDDEN'],
    [
      'Prive without approved KYC',
      makeUser({ tier: 'PRIVE', kycStatus: 'PENDING' }),
      'KYC_REQUIRED',
    ],
  ] as [string, Member, string][])('is not open to %s', async (_label, user, code) => {
    signInAs(user);
    const res = await signPetition();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(code);
  });

  it('requires an Idempotency-Key, a display choice, a signature file and both consents', async () => {
    signInAs(verifiedPrive());
    expect((await signPetition(validBody, null)).body.error.fields).toHaveProperty(
      'Idempotency-Key',
    );

    const res = await signPetition({
      displayMode: 'Show full name',
      consents: { supportSubmission: true, digitalEndorsement: false },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({
      displayMode: 'Choose how your name is shown',
      signatureFileId: 'Upload your signature first',
      'consents.digitalEndorsement': 'Accept both consent declarations to sign',
    });
  });
});

describe('POST /representations/:id/signatures: rules', () => {
  beforeEach(() => signInAs(verifiedPrive()));

  it('returns 404 for an unknown petition', async () => {
    stubSigning();
    vi.spyOn(representationsRepository, 'findById').mockResolvedValue(null);
    expect((await signPetition()).status).toBe(404);
  });

  it('refuses a petition that is no longer open', async () => {
    const { sign } = stubSigning();
    vi.spyOn(representationsRepository, 'findById').mockResolvedValue({
      ...petition,
      isOpenForSigning: false,
    });
    const res = await signPetition();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REPRESENTATION_CLOSED');
    expect(sign).not.toHaveBeenCalled();
  });

  it('rejects an unknown investor type', async () => {
    stubSigning();
    const res = await signPetition({ ...validBody, investorType: 'ASTRONAUT' });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ investorType: 'Unknown investor type' });
  });

  it("rejects a file that is not the user's SIGNATURE upload", async () => {
    stubSigning();
    for (const files of [[], [makeFile({ purpose: 'AVATAR' })]]) {
      vi.spyOn(filesRepository, 'findOwned').mockResolvedValue(files);
      const res = await signPetition();
      expect(res.status).toBe(400);
      expect(res.body.error.fields).toEqual({
        signatureFileId: 'Upload your signature with purpose SIGNATURE first',
      });
    }
  });

  it('rejects a signature whose upload has not finished', async () => {
    const { storage } = stubSigning();
    storage.exists.mockResolvedValue(false);
    const res = await signPetition();
    expect(res.body.error.fields).toEqual({
      signatureFileId: 'Your signature upload has not finished',
    });
  });

  it('returns 409 when the investor already signed', async () => {
    stubSigning().sign.mockRejectedValue(uniqueViolation('representation_signatures_one_per_user'));
    const res = await signPetition();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SIGNED');
  });

  it('returns 409 when the petition closed between the check and the save', async () => {
    stubSigning().sign.mockRejectedValue(representationClosed());
    expect((await signPetition()).body.error.code).toBe('REPRESENTATION_CLOSED');
  });
});

describe('POST /representations/:id/signatures: signing', () => {
  beforeEach(() => signInAs(verifiedPrive()));

  it('saves the signature with its consents and returns the receipt with a PDF link', async () => {
    const { sign, storage } = stubSigning();

    const res = await signPetition();

    expect(res.status).toBe(201);
    const [saved, ctx] = sign.mock.calls[0]!;
    expect(ctx).toMatchObject({ appVersion: '1.4.0', requestId: expect.any(String) });
    expect(saved).toEqual({
      userId: '1',
      representationId: REPRESENTATION_ID,
      signatureCode: expect.stringMatching(/^GIG-[A-Z0-9]{9}$/),
      displayMode: 'INITIALS',
      signerName: 'Shreya Mehta',
      investorType: 'RETAIL_EXPERIENCED',
      signatureFileId: '42',
      signerTier: 'PRIVE',
      consentTypes: ['PETITION_SUBMISSION_SUPPORT', 'PETITION_DIGITAL_ENDORSEMENT'],
      consentVersion: SIGNATURE_CONSENT_VERSION,
      idempotencyKey: 'signature-key-0001',
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    expect(res.body.data).toEqual({
      signatureId: saved.signatureCode,
      representation: { id: REPRESENTATION_ID, title: 'Mandatory T+1 Settlement Disclosure' },
      signer: {
        displayMode: 'INITIALS',
        displayName: 'S. M.',
        investorType: {
          code: 'RETAIL_EXPERIENCED',
          label: 'Retail Investor (Experienced Investors)',
        },
        tier: 'PRIVE',
        countsAsVote: true,
      },
      signedAt: '2026-10-27T10:24:07.000Z',
      consents: { version: SIGNATURE_CONSENT_VERSION, accepted: Object.values(SIGNATURE_CONSENTS) },
      receiptPdf: { url: DOWNLOAD_URL, expiresAt: expect.any(String) },
    });

    const [bucket, key, bytes, contentType] = storage.upload.mock.calls[0]!;
    expect([bucket, key, contentType]).toEqual([
      'signature-receipts',
      `${USER_ID}/${saved.signatureCode}.pdf`,
      'application/pdf',
    ]);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getTitle()).toBe(`GIG signature receipt ${saved.signatureCode}`);
  });

  it('retries with a new signature ID when a random ID is already taken', async () => {
    const { sign } = stubSigning();
    const codeTaken = uniqueViolation('representation_signatures_code_key');
    const save = sign.getMockImplementation()!;
    sign.mockRejectedValueOnce(codeTaken).mockImplementation(save);

    const res = await signPetition();

    expect(res.status).toBe(201);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(sign.mock.calls[0]![0].signatureCode).not.toBe(sign.mock.calls[1]![0].signatureCode);
  });

  it('returns the same receipt for a retry with the same key and body', async () => {
    const { sign } = stubSigning();
    await signPetition();
    const { requestHash, signatureCode } = sign.mock.calls[0]![0];
    vi.spyOn(representationsRepository, 'findByIdempotencyKey').mockResolvedValue({
      representationId: REPRESENTATION_ID,
      requestHash,
    });

    const retry = await signPetition();

    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.signatureId).toBe(signatureCode);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('refuses the same key with a different body', async () => {
    stubSigning();
    vi.spyOn(representationsRepository, 'findByIdempotencyKey').mockResolvedValue({
      representationId: REPRESENTATION_ID,
      requestHash: 'other',
    });
    const res = await signPetition();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('signs anonymously without exposing the name', async () => {
    stubSigning();
    vi.spyOn(representationsRepository, 'sign').mockImplementation((signature) => {
      vi.spyOn(representationsRepository, 'findSignature').mockResolvedValue({
        ...mySignature,
        signatureCode: signature.signatureCode,
        displayMode: 'ANONYMOUS',
        investorType: null,
      });
      return Promise.resolve();
    });

    const res = await signPetition({ ...validBody, displayMode: 'ANONYMOUS', investorType: null });

    expect(res.body.data.signer).toMatchObject({
      displayMode: 'ANONYMOUS',
      displayName: null,
      investorType: null,
    });
  });
});
