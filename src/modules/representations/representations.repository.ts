import { containsPattern, pageRange, RANGE_NOT_SATISFIABLE } from '../../lib/http';
import { DatabaseError, supabaseAdmin, unwrap } from '../../lib/supabase';
import type { Views } from '../../types/database';
import type {
  DisplayMode,
  FileScanStatus,
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
  internalId: number;
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
  opensAt: string;
  closesAt: string;
  daysLeft: number;
  /** Effective status: Open / Closing Soon / Closed follow the signing window. */
  trackStatus: RepresentationTrackStatus;
  isOpenForSigning: boolean;
  createdAt: string;
}

export interface Signer {
  id: string;
  /** Null for anonymous signers. */
  displayName: string | null;
  isAnonymous: boolean;
  investorType: { code: string; label: string } | null;
  isVerified: boolean;
  signedAt: string;
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
  occurredAt: string;
  documents: StoredDocument[];
}

export interface StoredSignature {
  publicId: string;
  signatureCode: string;
  displayMode: DisplayMode;
  signerName: string;
  investorType: string | null;
  signerTier: Tier;
  createdAt: string;
}

export interface NewSignature {
  userId: number;
  representationId: string;
  signatureCode: string;
  displayMode: DisplayMode;
  signerName: string;
  investorType: string | null;
  signatureFileId: number;
  signerTier: Tier;
  consentTypes: string[];
  consentVersion: string;
  ipAddress: string | null;
  appVersion: string | null;
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

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

type CardRow = Views<'representation_cards'>;
type SignerRow = Views<'representation_signers'>;

/** View columns are typed nullable; these are guaranteed by the underlying tables. */
function required<T>(value: T | null, view: string, column: string): T {
  if (value === null) throw new Error(`${view}.${column} is unexpectedly null`);
  return value;
}

function toRepresentation(row: CardRow): Representation {
  const r = <T>(value: T | null, column: string) => required(value, 'representation_cards', column);
  return {
    internalId: r(row.internal_id, 'internal_id'),
    id: r(row.id, 'id'),
    slug: r(row.slug, 'slug'),
    title: r(row.title, 'title'),
    description: row.description ?? '',
    asks: row.asks ?? [],
    whyItMatters: row.why_it_matters ?? '',
    category: row.category,
    country: r(row.country, 'country'),
    tags: row.tags ?? [],
    regulators: row.regulators ?? [],
    goal: r(row.goal, 'goal'),
    signatureCount: row.signature_count ?? 0,
    voteCount: row.vote_count ?? 0,
    progressPercent: row.progress_pct ?? 0,
    opensAt: r(row.opens_at, 'opens_at'),
    closesAt: r(row.closes_at, 'closes_at'),
    daysLeft: row.days_left ?? 0,
    trackStatus: r(row.track_status, 'track_status'),
    isOpenForSigning: row.is_open_for_signing ?? false,
    createdAt: r(row.created_at, 'created_at'),
  };
}

function toSigner(row: SignerRow): Signer {
  return {
    id: required(row.id, 'representation_signers', 'id'),
    displayName: row.display_name,
    isAnonymous: row.is_anonymous ?? false,
    investorType:
      row.investor_type && row.investor_type_label
        ? { code: row.investor_type, label: row.investor_type_label }
        : null,
    isVerified: row.is_verified ?? false,
    signedAt: required(row.signed_at, 'representation_signers', 'signed_at'),
  };
}

type DocumentRow = {
  public_id: string;
  title: string;
  document_type: RepresentationDocumentType;
  file: {
    bucket: string;
    object_key: string;
    mime_type: string;
    size_bytes: number;
    scan_status: FileScanStatus;
  };
};

/** Files the virus scan flagged are never offered for download. */
function visibleDocuments(rows: DocumentRow[]): StoredDocument[] {
  return rows.filter((row) => row.file.scan_status !== 'INFECTED').map(toDocument);
}

function toDocument(row: DocumentRow): StoredDocument {
  return {
    id: row.public_id,
    title: row.title,
    documentType: row.document_type,
    file: {
      bucket: row.file.bucket,
      objectKey: row.file.object_key,
      mimeType: row.file.mime_type,
      sizeBytes: row.file.size_bytes,
    },
  };
}

const DOCUMENT_COLUMNS =
  'public_id, title, document_type, file:files!inner(bucket, object_key, mime_type, size_bytes, scan_status)';

const SIGNATURE_COLUMNS =
  'public_id, signature_code, display_mode, signer_name, investor_type, signer_tier, created_at';

type SignatureRow = {
  public_id: string;
  signature_code: string;
  display_mode: DisplayMode;
  signer_name: string;
  investor_type: string | null;
  signer_tier: Tier;
  created_at: string;
};

function toStoredSignature(row: SignatureRow): StoredSignature {
  return {
    publicId: row.public_id,
    signatureCode: row.signature_code,
    displayMode: row.display_mode,
    signerName: row.signer_name,
    investorType: row.investor_type,
    signerTier: row.signer_tier,
    createdAt: row.created_at,
  };
}

const ORDER: Record<RepresentationSort, [keyof CardRow & string, boolean][]> = {
  // Open petitions first, soonest deadline first.
  closing_soon: [
    ['is_open_for_signing', false],
    ['closes_at', true],
  ],
  recent: [['opens_at', false]],
  most_signed: [['signature_count', false]],
  progress: [['progress_pct', false]],
};

function isRangeError(error: unknown): boolean {
  return error instanceof DatabaseError && error.code === RANGE_NOT_SATISFIABLE;
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export const representationsRepository = {
  async findAll(query: ListRepresentationsQuery): Promise<Page<Representation>> {
    const build = (head: boolean) => {
      let q = supabaseAdmin.from('representation_cards').select('*', { count: 'exact', head });
      if (query.q) q = q.ilike('search_text', containsPattern(query.q));
      if (query.filter?.status?.length) q = q.in('track_status', query.filter.status);
      if (query.filter?.country?.length) q = q.in('country', query.filter.country);
      if (query.filter?.openForSigning !== undefined) {
        q = q.eq('is_open_for_signing', query.filter.openForSigning);
      }
      return q;
    };

    let request = build(false);
    for (const [column, ascending] of ORDER[query.sort]) {
      request = request.order(column, { ascending });
    }
    const { from, to } = pageRange(query);
    const result = await request.order('id').range(from, to);

    try {
      const rows = unwrap(result);
      return { items: rows.map(toRepresentation), total: result.count ?? rows.length };
    } catch (error) {
      if (!isRangeError(error)) throw error;
      const head = await build(true);
      unwrap(head);
      return { items: [], total: head.count ?? 0 };
    }
  },

  async findById(id: string): Promise<Representation | null> {
    const row = unwrap(
      await supabaseAdmin.from('representation_cards').select('*').eq('id', id).maybeSingle(),
    );
    return row && toRepresentation(row);
  },

  /** Most recent signers first. */
  async findSigners(representation: Representation, limit: number): Promise<Signer[]> {
    const rows = unwrap(
      await supabaseAdmin
        .from('representation_signers')
        .select('*')
        .eq('representation_id', representation.internalId)
        .order('signed_at', { ascending: false })
        .limit(limit),
    );
    return rows.map(toSigner);
  },

  /** Evidence documents shown on the petition's Evidence tab. */
  async findEvidence(representation: Representation): Promise<StoredDocument[]> {
    const rows = unwrap(
      await supabaseAdmin
        .from('representation_documents')
        .select(DOCUMENT_COLUMNS)
        .eq('representation_id', representation.internalId)
        .eq('document_type', 'EVIDENCE')
        .order('sort_order')
        .order('id'),
    );
    return visibleDocuments(rows);
  },

  /** Stored status changes, oldest first, with the documents attached to each. */
  async findStatusHistory(representation: Representation): Promise<StatusChange[]> {
    const rows = unwrap(
      await supabaseAdmin
        .from('representation_status_history')
        .select(
          `from_status, to_status, note, occurred_at, representation_documents(${DOCUMENT_COLUMNS})`,
        )
        .eq('representation_id', representation.internalId)
        .order('occurred_at')
        .order('id'),
    );
    return rows.map((row) => ({
      fromStatus: row.from_status,
      toStatus: row.to_status,
      note: row.note,
      occurredAt: row.occurred_at,
      documents: visibleDocuments(row.representation_documents),
    }));
  },

  /** The latest submitted petition pack (Phase 2 generates these; staff attach them). */
  async findLatestSubmissionPack(representation: Representation): Promise<StoredDocument | null> {
    const rows = unwrap(
      await supabaseAdmin
        .from('representation_documents')
        .select(DOCUMENT_COLUMNS)
        .eq('representation_id', representation.internalId)
        .eq('document_type', 'SUBMISSION_PACK')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false }),
    );
    return visibleDocuments(rows)[0] ?? null;
  },

  async findSignature(
    userId: number,
    representation: Representation,
  ): Promise<StoredSignature | null> {
    const row = unwrap(
      await supabaseAdmin
        .from('representation_signatures')
        .select(SIGNATURE_COLUMNS)
        .eq('user_id', userId)
        .eq('representation_id', representation.internalId)
        .eq('status', 'VALID')
        .is('deleted_at', null)
        .maybeSingle(),
    );
    return row && toStoredSignature(row);
  },

  /** The signature a user already created with this Idempotency-Key, if any. */
  async findByIdempotencyKey(
    userId: number,
    idempotencyKey: string,
  ): Promise<{ representationId: string; requestHash: string | null } | null> {
    const row = unwrap(
      await supabaseAdmin
        .from('representation_signatures')
        .select('request_hash, representation:representations!inner(public_id)')
        .eq('user_id', userId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle(),
    );
    return row && { representationId: row.representation.public_id, requestHash: row.request_hash };
  },

  /** Saves the signature and its consents in one transaction. */
  async sign(signature: NewSignature): Promise<void> {
    unwrap(
      await supabaseAdmin
        .rpc('sign_representation', {
          p_user_id: signature.userId,
          p_representation_id: signature.representationId,
          p_signature_code: signature.signatureCode,
          p_display_mode: signature.displayMode,
          p_signer_name: signature.signerName,
          p_investor_type: signature.investorType,
          p_signature_file_id: signature.signatureFileId,
          p_signer_tier: signature.signerTier,
          p_consent_types: signature.consentTypes,
          p_consent_version: signature.consentVersion,
          p_ip_address: signature.ipAddress,
          p_app_version: signature.appVersion,
          p_idempotency_key: signature.idempotencyKey,
          p_request_hash: signature.requestHash,
        })
        .single(),
    );
  },
};
