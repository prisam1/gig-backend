import { audit } from '../../lib/audit';
import { sql, transaction } from '../../lib/db';
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

const cardColumns = () => sql`
  internal_id, id, slug, title, description, asks, why_it_matters, category, country, tags,
  regulators, goal, signature_count, vote_count, progress_pct as progress_percent, opens_at,
  closes_at, days_left, track_status, is_open_for_signing, created_at`;

function cardOrder(sort: RepresentationSort) {
  switch (sort) {
    // Open petitions first, soonest deadline first.
    case 'closing_soon':
      return sql`is_open_for_signing desc, closes_at asc`;
    case 'recent':
      return sql`opens_at desc`;
    case 'most_signed':
      return sql`signature_count desc`;
    case 'progress':
      return sql`progress_pct desc`;
  }
}

function cardFilters(query: ListRepresentationsQuery) {
  const { q, filter } = query;
  return sql`
    where true
    ${q ? sql`and search_text like ${containsPattern(q)}` : sql``}
    ${filter?.status?.length ? sql`and track_status in ${sql(filter.status)}` : sql``}
    ${filter?.country?.length ? sql`and country in ${sql(filter.country)}` : sql``}
    ${filter?.openForSigning !== undefined ? sql`and is_open_for_signing = ${filter.openForSigning}` : sql``}`;
}

// Files the virus scan flagged are never offered for download.
const documentJson = () => sql`
  json_build_object(
    'id', d.public_id, 'title', d.title, 'documentType', d.document_type,
    'file', json_build_object('bucket', d.bucket, 'objectKey', d.object_key,
                              'mimeType', d.mime_type, 'sizeBytes', d.size_bytes))`;

const signatureColumns = () => sql`
  public_id, signature_code, display_mode, signer_name, investor_type, signer_tier, created_at`;

interface SignerRow {
  id: string;
  displayMode: DisplayMode;
  signerName: string;
  investorType: string | null;
  investorTypeLabel: string | null;
  signerTier: Tier;
  signedAt: Date;
}

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
    const offset = (query.page - 1) * query.pageSize;
    const [rows, [count]] = await Promise.all([
      sql<Representation[]>`
        select ${cardColumns()} from app.representation_cards
        ${cardFilters(query)}
        order by ${cardOrder(query.sort)}, id
        limit ${query.pageSize} offset ${offset}`,
      sql<{ total: number }[]>`
        select count(*)::int as total from app.representation_cards ${cardFilters(query)}`,
    ]);
    return { items: rows, total: count?.total ?? 0 };
  },

  async findById(id: string): Promise<Representation | null> {
    const [row] = await sql<Representation[]>`
      select ${cardColumns()} from app.representation_cards where id = ${id}`;
    return row ?? null;
  },

  /** Most recent valid signers first. */
  async findSigners(representation: Representation, limit: number): Promise<Signer[]> {
    const rows = await sql<SignerRow[]>`
      select s.public_id as id, s.display_mode, s.signer_name, s.investor_type,
             o.label as investor_type_label, s.signer_tier, s.created_at as signed_at
      from app.representation_signatures s
      left join app.lookup_options o on o.type = s.investor_type_kind and o.code = s.investor_type
      where s.representation_id = ${representation.internalId}
        and s.status = 'VALID' and s.deleted_at is null
      order by s.created_at desc, s.id desc
      limit ${limit}`;
    return rows.map(toSigner);
  },

  /** Evidence documents shown on the petition's Evidence tab. */
  async findEvidence(representation: Representation): Promise<StoredDocument[]> {
    const rows = await sql<{ document: StoredDocument }[]>`
      select ${documentJson()} as document
      from app.representation_documents d
      where d.representation_id = ${representation.internalId}
        and d.document_type = 'EVIDENCE' and d.scan_status <> 'INFECTED'
      order by d.sort_order, d.id`;
    return rows.map((row) => row.document);
  },

  /** Stored status changes, oldest first, with the documents attached to each. */
  async findStatusHistory(representation: Representation): Promise<StatusChange[]> {
    return sql<StatusChange[]>`
      select h.from_status, h.to_status, h.note, h.occurred_at,
             (select coalesce(json_agg(${documentJson()} order by d.sort_order, d.id), '[]')
              from app.representation_documents d
              where d.status_history_id = h.id and d.scan_status <> 'INFECTED') as documents
      from app.representation_status_history h
      where h.representation_id = ${representation.internalId}
      order by h.occurred_at, h.id`;
  },

  /** The latest submitted petition pack (Phase 2 generates these; staff attach them). */
  async findLatestSubmissionPack(representation: Representation): Promise<StoredDocument | null> {
    const [row] = await sql<{ document: StoredDocument }[]>`
      select ${documentJson()} as document
      from app.representation_documents d
      where d.representation_id = ${representation.internalId}
        and d.document_type = 'SUBMISSION_PACK' and d.scan_status <> 'INFECTED'
      order by d.created_at desc, d.id desc
      limit 1`;
    return row?.document ?? null;
  },

  /** The user's valid, not-deleted signature on this petition. */
  async findSignature(
    userId: string,
    representation: Representation,
  ): Promise<StoredSignature | null> {
    const [row] = await sql<StoredSignature[]>`
      select ${signatureColumns()} from app.representation_signatures
      where user_id = ${userId} and representation_id = ${representation.internalId}
        and status = 'VALID' and deleted_at is null`;
    return row ?? null;
  },

  /** The signature a user already created with this Idempotency-Key, if any. */
  async findByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<{ representationId: string; requestHash: string | null } | null> {
    const [row] = await sql<{ representationId: string; requestHash: string | null }[]>`
      select r.public_id as representation_id, s.request_hash
      from app.representation_signatures s
      join app.representations r on r.id = s.representation_id
      where s.user_id = ${userId} and s.idempotency_key = ${idempotencyKey}`;
    return row ?? null;
  },

  /**
   * Saves the signature and its consents, and audits it, in one transaction. The petition row is
   * locked and re-checked, so a signature never lands after the window closed.
   */
  async sign(signature: NewSignature, ctx: ClientContext): Promise<void> {
    await transaction(async (tx) => {
      const [representation] = await tx<{ id: string; isOpen: boolean }[]>`
        select id, (now() < closes_at and track_status in ('OPEN', 'CLOSING_SOON')) as is_open
        from app.representations
        where public_id = ${signature.representationId} and deleted_at is null and opens_at <= now()
        for share`;
      if (!representation) throw new HttpError(404, 'Representation not found');
      if (!representation.isOpen) throw representationClosed();

      const [file] = await tx`
        select 1 from app.files
        where id = ${signature.signatureFileId} and owner_id = ${signature.userId}
          and purpose = 'SIGNATURE' and scan_status <> 'INFECTED'`;
      if (!file) throw signatureFileInvalid();

      await tx`
        insert into app.representation_signatures (
          signature_code, representation_id, user_id, display_mode, signer_name, investor_type,
          signature_file_id, signer_tier, weight, consent_version, idempotency_key, request_hash
        ) values (
          ${signature.signatureCode}, ${representation.id}, ${signature.userId},
          ${signature.displayMode}, ${signature.signerName}, ${signature.investorType},
          ${signature.signatureFileId}, ${signature.signerTier},
          ${signature.signerTier === 'PRIVE' ? 1 : 0}, ${signature.consentVersion},
          ${signature.idempotencyKey}, ${signature.requestHash}
        )`;

      await tx`
        insert into app.consents (user_id, type, version, accepted_at, ip, user_agent, app_version)
        select ${signature.userId}, type, ${signature.consentVersion}, now(), ${ctx.ip}::inet,
               ${ctx.userAgent}, ${ctx.appVersion}
        from unnest(${tx.array(signature.consentTypes)}::text[]) as type`;
      await audit(
        ctx,
        'representation.signed',
        {
          userId: signature.userId,
          metadata: {
            representation: signature.representationId,
            signature: signature.signatureCode,
          },
        },
        tx,
      );
    });
  },
};
