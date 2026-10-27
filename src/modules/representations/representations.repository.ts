import { callDb } from '../../lib/db';
import type { DbResult } from '../../lib/dbFunctions';
import { displayNameFor } from '../../lib/displayName';
import { containsPattern } from '../../lib/http';
import { HttpError, validationError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import type {
  DisplayMode,
  MarketCountry,
  RepresentationDocumentType,
  RepresentationTrackStatus,
  Tier,
} from '../../types/domain';
import type { ListRepresentationsQuery, RepresentationSort } from './representations.schemas';

// ---------------------------------------------------------------------------------------------
// Domain shapes
// ---------------------------------------------------------------------------------------------

export interface Representation {
  /** Internal key, never returned by the API. */
  internalId: string;
  id: string;
  slug: string;
  title: string;
  description: string;
  asks: string[];
  whyItMatters: string;
  category: string | null;
  country: MarketCountry;
  tags: string[];
  regulators: string[];
  goal: number;
  signatureCount: number;
  voteCount: number;
  progressPercent: number;
  opensAt: Date;
  closesAt: Date;
  daysLeft: number;
  /** Effective status: Open / Closing Soon / Closed follow the signing window. */
  trackStatus: RepresentationTrackStatus;
  isOpenForSigning: boolean;
  createdAt: Date;
}

export interface Signer {
  id: string;
  /** Null for anonymous signers. */
  displayName: string | null;
  isAnonymous: boolean;
  investorType: { code: string; label: string } | null;
  isVerified: boolean;
  signedAt: Date;
}

export interface StoredDocument {
  id: string;
  title: string;
  documentType: RepresentationDocumentType;
  file: { bucket: string; objectKey: string; mimeType: string; sizeBytes: number };
}

export interface StatusChange {
  fromStatus: RepresentationTrackStatus | null;
  toStatus: RepresentationTrackStatus;
  note: string | null;
  occurredAt: Date;
  documents: StoredDocument[];
}

export interface StoredSignature {
  publicId: string;
  signatureCode: string;
  displayMode: DisplayMode;
  signerName: string;
  investorType: string | null;
  signerTier: Tier;
  createdAt: Date;
}

export interface NewSignature {
  userId: string;
  representationId: string;
  signatureCode: string;
  displayMode: DisplayMode;
  signerName: string;
  investorType: string | null;
  signatureFileId: string;
  signerTier: Tier;
  consentTypes: string[];
  consentVersion: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface Page<T> {
  items: T[];
  total: number;
}

/** Constraint and index names the service maps to API errors. */
export const SIGNATURE_CONSTRAINTS = {
  onePerUser: 'representation_signatures_one_per_user',
  code: 'representation_signatures_code_key',
  idempotencyKey: 'representation_signatures_idempotency_key_idx',
} as const;

export function representationClosed(): HttpError {
  return new HttpError(409, 'This petition is no longer open for signatures', {
    code: 'REPRESENTATION_CLOSED',
  });
}

export function signatureFileInvalid(): HttpError {
  return validationError({ signatureFileId: 'Upload your signature with purpose SIGNATURE first' });
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

type SignerRow = DbResult<'app_representation_signers'>[number];

/** Signers as the public sees them: the name follows the signer's display choice. */
function toSigner(row: SignerRow): Signer {
  return {
    id: row.id,
    displayName: displayNameFor(row.signerName, row.displayMode),
    isAnonymous: row.displayMode === 'ANONYMOUS',
    investorType:
      row.investorType && row.investorTypeLabel
        ? { code: row.investorType, label: row.investorTypeLabel }
        : null,
    isVerified: row.signerTier === 'PRIVE',
    signedAt: row.signedAt,
  };
}

export const representationsRepository = {
  async findAll(query: ListRepresentationsQuery): Promise<Page<Representation>> {
    const page = await callDb('app_find_representations', {
      p_q_pattern: query.q ? containsPattern(query.q) : null,
      p_statuses: query.filter?.status ?? null,
      p_countries: query.filter?.country ?? null,
      p_open: query.filter?.openForSigning ?? null,
      p_sort: query.sort satisfies RepresentationSort,
      p_limit: query.pageSize,
      p_offset: (query.page - 1) * query.pageSize,
    });
    return page;
  },

  findById(id: string): Promise<Representation | null> {
    return callDb('app_find_representation', { p_id: id });
  },

  /** Most recent valid signers first. */
  async findSigners(representation: Representation, limit: number): Promise<Signer[]> {
    const rows = await callDb('app_representation_signers', {
      p_representation_id: representation.internalId,
      p_limit: limit,
    });
    return rows.map(toSigner);
  },

  /** Evidence documents shown on the petition's Evidence tab. Infected files are never listed. */
  findEvidence(representation: Representation): Promise<StoredDocument[]> {
    return callDb('app_representation_evidence', { p_representation_id: representation.internalId });
  },

  /** Stored status changes, oldest first, with the documents attached to each. */
  findStatusHistory(representation: Representation): Promise<StatusChange[]> {
    return callDb('app_representation_history', { p_representation_id: representation.internalId });
  },

  /** The latest submitted petition pack (Phase 2 generates these; staff attach them). */
  findLatestSubmissionPack(representation: Representation): Promise<StoredDocument | null> {
    return callDb('app_representation_submission_pack', {
      p_representation_id: representation.internalId,
    });
  },

  /** The user's valid, not-deleted signature on this petition. */
  findSignature(
    userId: string,
    representation: Representation,
  ): Promise<StoredSignature | null> {
    return callDb('app_representation_signature', {
      p_user_id: userId,
      p_representation_id: representation.internalId,
    });
  },

  /** The signature a user already created with this Idempotency-Key, if any. */
  findByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<{ representationId: string; requestHash: string | null } | null> {
    return callDb('app_signature_by_idempotency_key', {
      p_user_id: userId,
      p_idempotency_key: idempotencyKey,
    });
  },

  /**
   * Saves the signature and its consents, and audits it, in one transaction. The petition row is
   * locked and re-checked, so a signature never lands after the window closed.
   */
  async sign(signature: NewSignature, ctx: ClientContext): Promise<void> {
    const result = await callDb(
      'app_representation_sign',
      { p_signature: signature, p_ctx: ctx },
    );
    if ('error' in result) {
      if (result.error === 'NOT_FOUND') throw new HttpError(404, 'Representation not found');
      if (result.error === 'CLOSED') throw representationClosed();
      throw signatureFileInvalid();
    }
  },
};
