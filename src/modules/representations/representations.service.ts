import { randomInt } from 'node:crypto';
import { displayNameFor } from '../../lib/displayName';
import type { PageMeta } from '../../lib/http';
import { hashRequest, type IdempotentResult } from '../../lib/idempotency';
import { DatabaseError, PG_UNIQUE_VIOLATION } from '../../lib/supabase';
import { HttpError, validationError } from '../../middleware/errorHandler';
import type { DisplayMode, RepresentationTrackStatus, Tier } from '../../types/domain';
import { filesRepository } from '../files/files.repository';
import { filesStorage } from '../files/files.storage';
import { lookupsRepository } from '../lookups/lookups.repository';
import { lookupsService } from '../lookups/lookups.service';
import { usersRepository, type User } from '../users/users.repository';
import { renderSignatureReceipt } from './representations.receipt';
import {
  representationsRepository,
  SIGNATURE_CONSTRAINTS,
  type Representation,
  type Signer,
  type StatusChange,
  type StoredDocument,
  type StoredSignature,
} from './representations.repository';
import type { ListRepresentationsQuery, SignRepresentationInput } from './representations.schemas';

/** Version of the two signing declarations shown in the app; bump it when the wording changes. */
export const SIGNATURE_CONSENT_VERSION = '2026-10';

/** The signing declarations, stored in the consents table under these types. */
export const SIGNATURE_CONSENTS = {
  PETITION_SUBMISSION_SUPPORT:
    'I support this representation being submitted to the regulator(s) listed.',
  PETITION_DIGITAL_ENDORSEMENT:
    'I understand my signature is a digital endorsement and may be included in aggregate reporting.',
} as const;

/** Track labels as the app shows them. */
export const TRACK_LABELS: Record<RepresentationTrackStatus, string> = {
  OPEN: 'Open',
  CLOSING_SOON: 'Closing Soon',
  CLOSED: 'Closed',
  UNDER_REVIEW: 'Under Review by GIG',
  SUBMITTED_TO_REGULATOR: 'Submitted to Reg.',
  MEETING_REQUESTED: 'Meeting Requested',
  MEETING_SCHEDULED: 'Meeting Scheduled',
  REGULATOR_RESPONDED: 'Reg. Responded',
  RESOLVED: 'Resolved / Closed',
};

const TRACK_ORDER = Object.keys(TRACK_LABELS) as RepresentationTrackStatus[];

/** Matches representation_closing_soon_window() in SQL. */
const CLOSING_SOON_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Signers shown on the petition page; the total is in `signatureCount`. */
const SIGNER_PREVIEW_LIMIT = 20;

/** Lifetime of document and receipt download links. */
const DOWNLOAD_URL_TTL_SECONDS = 300;

const RECEIPT_BUCKET = 'signature-receipts';
const SIGNATURE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SIGNATURE_CODE_ATTEMPTS = 3;

const ANONYMOUS_LABEL = 'Anonymous (counted)';

const DISCLAIMER =
  'This petition is created and supported by participating investors. GIG facilitates collection and submission.';

// ---------------------------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------------------------

export type RepresentationSummary = Omit<
  Representation,
  'internalId' | 'asks' | 'whyItMatters' | 'regulators'
> & { trackLabel: string };

export interface DocumentLink {
  id: string;
  title: string;
  type: StoredDocument['documentType'];
  mimeType: string;
  sizeBytes: number;
  /** Short-lived download link. */
  downloadUrl: string;
}

export interface SignatureReceiptLink {
  url: string;
  expiresAt: string;
}

export interface MySignature {
  signatureId: string;
  displayMode: DisplayMode;
  signedAt: string;
  receiptPdf: SignatureReceiptLink;
}

export interface RepresentationDetail extends RepresentationSummary {
  overview: { asks: string[]; whyItMatters: string; regulators: string[]; disclaimer: string };
  evidence: DocumentLink[];
  signers: { total: number; recent: Signer[] };
  /** The signed-in user's signature, if they signed. */
  mySignature: MySignature | null;
}

export interface TimelineStep {
  status: RepresentationTrackStatus;
  label: string;
  /** When the petition reached this step; null if it has not yet. */
  reachedAt: string | null;
  isCurrent: boolean;
}

export interface RepresentationTimeline {
  currentStatus: RepresentationTrackStatus;
  steps: TimelineStep[];
  history: {
    fromStatus: RepresentationTrackStatus | null;
    toStatus: RepresentationTrackStatus;
    label: string;
    note: string | null;
    occurredAt: string;
    documents: DocumentLink[];
  }[];
}

export interface SignatureReceipt {
  /** The ID shown on the receipt: GIG- followed by 9 characters. */
  signatureId: string;
  representation: { id: string; title: string };
  signer: {
    displayMode: DisplayMode;
    /** What other investors see; null when anonymous. */
    displayName: string | null;
    investorType: { code: string; label: string } | null;
    tier: Tier;
    /** Only Prive signatures count as votes. */
    countsAsVote: boolean;
  };
  signedAt: string;
  consents: { version: string; accepted: string[] };
  receiptPdf: SignatureReceiptLink;
}

export interface RequestMeta {
  ipAddress: string | null;
  appVersion: string | null;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function toSummary({
  internalId: _internalId,
  asks: _asks,
  whyItMatters: _whyItMatters,
  regulators: _regulators,
  ...summary
}: Representation): RepresentationSummary {
  return { ...summary, trackLabel: TRACK_LABELS[summary.trackStatus] };
}

async function requireRepresentation(id: string): Promise<Representation> {
  const representation = await representationsRepository.findById(id);
  if (!representation) throw new HttpError(404, 'Representation not found');
  return representation;
}

async function toDocumentLink(document: StoredDocument): Promise<DocumentLink> {
  return {
    id: document.id,
    title: document.title,
    type: document.documentType,
    mimeType: document.file.mimeType,
    sizeBytes: document.file.sizeBytes,
    downloadUrl: await filesStorage.createDownloadUrl(
      document.file.bucket,
      document.file.objectKey,
      DOWNLOAD_URL_TTL_SECONDS,
    ),
  };
}

/** When each step of the 9-step track was reached, from the dates and the stored history. */
function timelineSteps(
  representation: Representation,
  history: StatusChange[],
  now: Date,
): TimelineStep[] {
  const closesAt = new Date(representation.closesAt);
  const closingSoonAt = new Date(closesAt.getTime() - CLOSING_SOON_DAYS * DAY_MS);
  const firstReached = new Map<RepresentationTrackStatus, string>();
  for (const change of history) {
    if (!firstReached.has(change.toStatus)) firstReached.set(change.toStatus, change.occurredAt);
  }

  const current = representation.trackStatus;
  const currentIndex = TRACK_ORDER.indexOf(current);

  return TRACK_ORDER.map((status, index) => {
    let reachedAt: string | null = null;
    if (index <= currentIndex) {
      if (status === 'OPEN') reachedAt = representation.opensAt;
      else if (status === 'CLOSING_SOON') {
        reachedAt = now >= closingSoonAt ? closingSoonAt.toISOString() : null;
      } else if (status === 'CLOSED') reachedAt = now >= closesAt ? closesAt.toISOString() : null;
      else reachedAt = firstReached.get(status) ?? null;
    }
    return { status, label: TRACK_LABELS[status], reachedAt, isCurrent: status === current };
  });
}

function newSignatureCode(): string {
  let code = 'GIG-';
  for (let i = 0; i < 9; i++) {
    code += SIGNATURE_CODE_ALPHABET[randomInt(SIGNATURE_CODE_ALPHABET.length)];
  }
  return code;
}

function isUniqueViolationOf(error: unknown, name: string): boolean {
  return (
    error instanceof DatabaseError &&
    error.code === PG_UNIQUE_VIOLATION &&
    error.message.includes(name)
  );
}

function raised(error: unknown, exception: string): boolean {
  return error instanceof DatabaseError && error.message.includes(exception);
}

/** The signer's file, which must be their own SIGNATURE upload that has finished uploading. */
async function resolveSignatureFile(user: User, fileId: string): Promise<number> {
  const [file] = await filesRepository.findOwned(user.id, [fileId]);
  if (!file || file.purpose !== 'SIGNATURE') {
    throw validationError({
      signatureFileId: 'Upload your signature with purpose SIGNATURE first',
    });
  }
  if (!(await filesStorage.exists(file.bucket, file.objectKey))) {
    throw validationError({ signatureFileId: 'Your signature upload has not finished' });
  }
  return file.id;
}

async function investorTypeOption(
  code: string | null,
): Promise<{ code: string; label: string } | null> {
  if (!code) return null;
  const options = await lookupsRepository.findActive('INVESTOR_TYPE');
  const option = options.find((o) => o.code === code);
  return option ? { code: option.code, label: option.label } : { code, label: code };
}

/** Writes the receipt PDF to storage and returns a short-lived link to it. */
async function publishReceipt(
  user: User,
  representation: Representation,
  signature: StoredSignature,
  investorType: { code: string; label: string } | null,
): Promise<SignatureReceiptLink> {
  const pdf = await renderSignatureReceipt({
    signatureCode: signature.signatureCode,
    petitionTitle: representation.title,
    signerDisplay: displayNameFor(signature.signerName, signature.displayMode) ?? ANONYMOUS_LABEL,
    investorType: investorType?.label ?? null,
    membership:
      signature.signerTier === 'PRIVE' ? 'Prive (verified investor)' : signature.signerTier,
    signedAt: new Date(signature.createdAt),
    regulators: representation.regulators,
    consents: Object.values(SIGNATURE_CONSENTS),
  });

  const objectKey = receiptKey(user, signature);
  await filesStorage.upload(RECEIPT_BUCKET, objectKey, pdf, 'application/pdf');
  return receiptDownloadLink(objectKey);
}

function receiptKey(user: User, signature: StoredSignature): string {
  return `${user.publicId}/${signature.signatureCode}.pdf`;
}

async function receiptDownloadLink(objectKey: string): Promise<SignatureReceiptLink> {
  const url = await filesStorage.createDownloadUrl(
    RECEIPT_BUCKET,
    objectKey,
    DOWNLOAD_URL_TTL_SECONDS,
  );
  return { url, expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString() };
}

/** A link to the stored receipt; the PDF is regenerated only if it is missing. */
async function existingReceiptLink(
  user: User,
  representation: Representation,
  signature: StoredSignature,
): Promise<SignatureReceiptLink> {
  const objectKey = receiptKey(user, signature);
  if (await filesStorage.exists(RECEIPT_BUCKET, objectKey)) return receiptDownloadLink(objectKey);
  return publishReceipt(
    user,
    representation,
    signature,
    await investorTypeOption(signature.investorType),
  );
}

async function signatureReceipt(
  user: User,
  representation: Representation,
  signature: StoredSignature,
): Promise<SignatureReceipt> {
  const investorType = await investorTypeOption(signature.investorType);
  return {
    signatureId: signature.signatureCode,
    representation: { id: representation.id, title: representation.title },
    signer: {
      displayMode: signature.displayMode,
      displayName: displayNameFor(signature.signerName, signature.displayMode),
      investorType,
      tier: signature.signerTier,
      countsAsVote: signature.signerTier === 'PRIVE',
    },
    signedAt: signature.createdAt,
    consents: { version: SIGNATURE_CONSENT_VERSION, accepted: Object.values(SIGNATURE_CONSENTS) },
    receiptPdf: await publishReceipt(user, representation, signature, investorType),
  };
}

/** The signature this key already created, or null; a reused key with another body is a 409. */
async function replay(
  user: User,
  idempotencyKey: string,
  requestHash: string,
): Promise<IdempotentResult<SignatureReceipt> | null> {
  const existing = await representationsRepository.findByIdempotencyKey(user.id, idempotencyKey);
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new HttpError(409, 'Idempotency-Key was already used for a different request', {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  }
  const representation = await requireRepresentation(existing.representationId);
  const signature = await representationsRepository.findSignature(user.id, representation);
  if (!signature) throw new Error(`Signature for key ${idempotencyKey} could not be read back`);
  return { result: await signatureReceipt(user, representation, signature), replayed: true };
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export const representationsService = {
  async list(
    query: ListRepresentationsQuery,
  ): Promise<{ items: RepresentationSummary[]; meta: PageMeta }> {
    const { items, total } = await representationsRepository.findAll(query);
    return {
      items: items.map(toSummary),
      meta: { page: query.page, pageSize: query.pageSize, total },
    };
  },

  async get(id: string, viewer: User | undefined): Promise<RepresentationDetail> {
    const representation = await requireRepresentation(id);
    const [evidence, recentSigners, mine] = await Promise.all([
      representationsRepository.findEvidence(representation),
      representationsRepository.findSigners(representation, SIGNER_PREVIEW_LIMIT),
      viewer ? representationsRepository.findSignature(viewer.id, representation) : null,
    ]);

    const mySignature: MySignature | null =
      viewer && mine
        ? {
            signatureId: mine.signatureCode,
            displayMode: mine.displayMode,
            signedAt: mine.createdAt,
            receiptPdf: await existingReceiptLink(viewer, representation, mine),
          }
        : null;

    return {
      ...toSummary(representation),
      overview: {
        asks: representation.asks,
        whyItMatters: representation.whyItMatters,
        regulators: representation.regulators,
        disclaimer: DISCLAIMER,
      },
      evidence: await Promise.all(evidence.map(toDocumentLink)),
      signers: { total: representation.signatureCount, recent: recentSigners },
      mySignature,
    };
  },

  /**
   * The latest petition pack GIG submitted to the regulator(s), for verified Prive and
   * Institutional members. Packs are produced in Phase 2; until one exists this is a 404.
   */
  async submissionPack(id: string): Promise<DocumentLink> {
    const representation = await requireRepresentation(id);
    const pack = await representationsRepository.findLatestSubmissionPack(representation);
    if (!pack) {
      throw new HttpError(404, 'This petition has not been submitted to a regulator yet', {
        code: 'SUBMISSION_NOT_AVAILABLE',
      });
    }
    return toDocumentLink(pack);
  },

  async timeline(id: string): Promise<RepresentationTimeline> {
    const representation = await requireRepresentation(id);
    const history = await representationsRepository.findStatusHistory(representation);

    return {
      currentStatus: representation.trackStatus,
      steps: timelineSteps(representation, history, new Date()),
      history: await Promise.all(
        history.map(async (change) => ({
          fromStatus: change.fromStatus,
          toStatus: change.toStatus,
          label: TRACK_LABELS[change.toStatus],
          note: change.note,
          occurredAt: change.occurredAt,
          documents: await Promise.all(change.documents.map(toDocumentLink)),
        })),
      ),
    };
  },

  /**
   * Signs a petition and returns the receipt with a link to its PDF. A retry with the same
   * Idempotency-Key and body returns the same receipt.
   */
  async sign(
    user: User,
    id: string,
    input: SignRepresentationInput,
    meta: RequestMeta,
    idempotencyKey: string,
  ): Promise<IdempotentResult<SignatureReceipt>> {
    const requestHash = hashRequest({ id, ...input });
    const previous = await replay(user, idempotencyKey, requestHash);
    if (previous) return previous;

    const representation = await requireRepresentation(id);
    if (!representation.isOpenForSigning) {
      throw new HttpError(409, 'This petition is no longer open for signatures', {
        code: 'REPRESENTATION_CLOSED',
      });
    }
    if (input.investorType) {
      const invalid = await lookupsService.findInvalidCodes('INVESTOR_TYPE', [input.investorType]);
      if (invalid.length > 0) throw validationError({ investorType: 'Unknown investor type' });
    }
    const signatureFileId = await resolveSignatureFile(user, input.signatureFileId);
    const profile = await usersRepository.findProfile(user.id);

    for (let attempt = 1; ; attempt++) {
      try {
        await representationsRepository.sign({
          userId: user.id,
          representationId: representation.id,
          signatureCode: newSignatureCode(),
          displayMode: input.displayMode,
          signerName: profile?.name?.trim() ?? '',
          investorType: input.investorType,
          signatureFileId,
          signerTier: user.tier,
          consentTypes: Object.keys(SIGNATURE_CONSENTS),
          consentVersion: SIGNATURE_CONSENT_VERSION,
          ipAddress: meta.ipAddress,
          appVersion: meta.appVersion,
          idempotencyKey,
          requestHash,
        });
        break;
      } catch (error) {
        // A random signature code collided: try another one.
        if (
          isUniqueViolationOf(error, SIGNATURE_CONSTRAINTS.code) &&
          attempt < SIGNATURE_CODE_ATTEMPTS
        ) {
          continue;
        }
        if (isUniqueViolationOf(error, SIGNATURE_CONSTRAINTS.onePerUser)) {
          throw new HttpError(409, 'You have already signed this petition', {
            code: 'ALREADY_SIGNED',
          });
        }
        // A concurrent retry with the same key signed first: return that signature.
        if (isUniqueViolationOf(error, SIGNATURE_CONSTRAINTS.idempotencyKey)) {
          const raced = await replay(user, idempotencyKey, requestHash);
          if (raced) return raced;
        }
        if (raised(error, 'REPRESENTATION_CLOSED')) {
          throw new HttpError(409, 'This petition is no longer open for signatures', {
            code: 'REPRESENTATION_CLOSED',
          });
        }
        if (raised(error, 'REPRESENTATION_NOT_FOUND'))
          throw new HttpError(404, 'Representation not found');
        if (raised(error, 'SIGNATURE_FILE_INVALID')) {
          throw validationError({
            signatureFileId: 'Upload your signature with purpose SIGNATURE first',
          });
        }
        throw error;
      }
    }

    const signature = await representationsRepository.findSignature(user.id, representation);
    if (!signature) throw new Error(`Signature on ${representation.id} could not be read back`);
    return { result: await signatureReceipt(user, representation, signature), replayed: false };
  },
};
