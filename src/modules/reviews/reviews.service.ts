import type { PostgrestError } from '@supabase/supabase-js';
import { displayNameFor } from '../../lib/displayName';
import { hashRequest } from '../../lib/idempotency';
import type { PageMeta } from '../../lib/http';
import { pageRange } from '../../lib/http';
import type { Member, Tier } from '../../lib/membership';
import { supabaseAdmin } from '../../lib/supabase';
import { assertNoFieldErrors, HttpError } from '../../middleware/errorHandler';
import type { Enums, Tables, Views } from '../../types/database';
import { accessLevel, assertCompanyExists } from '../catalog/catalog.service';
import {
  DECLARATIONS_VERSION,
  type ListCompanyReviewsQuery,
  type ListMyReviewsQuery,
  type ReviewSort,
  type SubmitReviewInput,
  type UpdateResolutionInput,
} from './reviews.schemas';

type ReviewTagType = 'APPRECIATION' | 'CONCERN' | 'CONTACT_STATUS';

// ---------------------------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------------------------

export interface ReviewMetrics {
  transparency: number;
  responsiveness: number;
  easeOfProcess: number;
  trustworthiness: number;
  overallSatisfaction: number;
}

export interface ReviewAuthor {
  /** Full name or initials per the reviewer's display mode; null when anonymous. */
  name: string | null;
  anonymous: boolean;
}

interface ReviewCore {
  id: string;
  author: ReviewAuthor;
  country: Enums<'market_country'>;
  assetClass: Enums<'asset_class'>;
  productScheme: string;
  /** null = "Older" */
  investmentYear: number | null;
  investmentStatus: Enums<'investment_status'>;
  sentiment: Enums<'sentiment'>;
  avgRating: number;
  excerpt: string;
  resolutionStatus: Enums<'resolution_status'>;
  createdAt: string;
}

/** What Observers (and signed-out visitors) see. */
export interface ReviewSummary extends ReviewCore {
  detail: 'SUMMARY';
}

/** What verified Prive and Institutional members see. */
export interface ReviewFull extends ReviewCore {
  detail: 'FULL';
  detailedReview: string | null;
  mixedReview: string | null;
  negativeDescription: string | null;
  reinvestStatus: Enums<'reinvest_status'> | null;
  appreciations: string[];
  concerns: string[];
  contactStatus: string[];
  metrics: ReviewMetrics;
  followUpNote: string | null;
}

export type PublicReview = ReviewSummary | ReviewFull;

export interface ReviewTimelineEvent {
  type: Enums<'review_change_type'>;
  from: string | null;
  to: string | null;
  note: string | null;
  at: string;
}

/** The reviewer's own view of their review: the receipt. */
export interface ReviewReceipt {
  detail: 'OWNER';
  id: string;
  receiptNo: string;
  status: Enums<'review_status'>;
  moderationNote: string | null;
  /**
   * The reviewer. `name` is as captured at submission; `displayName` is what other investors see
   * (null when anonymous). `tier` and `kycVerified` are the reviewer's current membership.
   */
  reviewer: {
    name: string;
    displayName: string | null;
    tier: Tier;
    kycVerified: boolean;
  };
  company: { id: string; name: string; assetClass: Enums<'asset_class'> };
  country: Enums<'market_country'>;
  assetClass: Enums<'asset_class'>;
  productScheme: string;
  investmentYear: number | null;
  investmentStatus: Enums<'investment_status'>;
  sentiment: Enums<'sentiment'>;
  detailedReview: string | null;
  mixedReview: string | null;
  negativeDescription: string | null;
  reinvestStatus: Enums<'reinvest_status'> | null;
  appreciations: string[];
  concerns: string[];
  contactStatus: string[];
  /** Objects in the review-evidence bucket. */
  evidence: { path: string; docType: string; fileName: string }[];
  metrics: ReviewMetrics;
  avgRating: number;
  resolutionStatus: Enums<'resolution_status'>;
  followUpNote: string | null;
  displayMode: Enums<'display_mode'>;
  allowContact: boolean;
  timeline: ReviewTimelineEvent[];
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface MyReviewItem {
  id: string;
  receiptNo: string;
  status: Enums<'review_status'>;
  company: { id: string; name: string };
  sentiment: Enums<'sentiment'>;
  avgRating: number;
  resolutionStatus: Enums<'resolution_status'>;
  createdAt: string;
  updatedAt: string;
}

export interface ResolutionUpdate {
  id: string;
  resolutionStatus: Enums<'resolution_status'>;
  followUpNote: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

type MetricColumns = Pick<
  Tables<'reviews'>,
  | 'm_transparency'
  | 'm_responsiveness'
  | 'm_ease_of_process'
  | 'm_trustworthiness'
  | 'm_overall_satisfaction'
>;

function toMetrics(row: MetricColumns): ReviewMetrics {
  return {
    transparency: row.m_transparency,
    responsiveness: row.m_responsiveness,
    easeOfProcess: row.m_ease_of_process,
    trustworthiness: row.m_trustworthiness,
    overallSatisfaction: row.m_overall_satisfaction,
  };
}

function averageRating(m: ReviewMetrics): number {
  const sum =
    m.transparency + m.responsiveness + m.easeOfProcess + m.trustworthiness + m.overallSatisfaction;
  return Math.round((sum / 5) * 10) / 10;
}

const EXCERPT_LENGTH = 160;

function excerptOf(...texts: (string | null)[]): string {
  const text = texts.find((t): t is string => !!t) ?? '';
  if (text.length <= EXCERPT_LENGTH) return text;
  const cut = text.slice(0, EXCERPT_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > EXCERPT_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** View columns are typed nullable; these are guaranteed by the underlying tables. */
function required<T>(value: T | null, column: string): T {
  if (value === null) throw new Error(`review_feed.${column} is unexpectedly null`);
  return value;
}

function toPublicReview(row: Views<'review_feed'>, access: 'SUMMARY' | 'FULL'): PublicReview {
  const metrics: ReviewMetrics = {
    transparency: required(row.m_transparency, 'm_transparency'),
    responsiveness: required(row.m_responsiveness, 'm_responsiveness'),
    easeOfProcess: required(row.m_ease_of_process, 'm_ease_of_process'),
    trustworthiness: required(row.m_trustworthiness, 'm_trustworthiness'),
    overallSatisfaction: required(row.m_overall_satisfaction, 'm_overall_satisfaction'),
  };
  const core: ReviewCore = {
    id: required(row.id, 'id'),
    author: { name: row.author_name, anonymous: row.display_mode === 'ANONYMOUS' },
    country: required(row.country, 'country'),
    assetClass: required(row.asset_class, 'asset_class'),
    productScheme: row.product_scheme ?? '',
    investmentYear: row.investment_year,
    investmentStatus: required(row.investment_status, 'investment_status'),
    sentiment: required(row.sentiment, 'sentiment'),
    avgRating: row.avg_rating ?? averageRating(metrics),
    excerpt: excerptOf(row.detailed_review, row.mixed_review, row.negative_description),
    resolutionStatus: required(row.resolution_status, 'resolution_status'),
    createdAt: required(row.created_at, 'created_at'),
  };

  if (access === 'SUMMARY') return { ...core, detail: 'SUMMARY' };
  return {
    ...core,
    detail: 'FULL',
    detailedReview: row.detailed_review,
    mixedReview: row.mixed_review,
    negativeDescription: row.negative_description,
    reinvestStatus: row.reinvest_status,
    appreciations: row.appreciations ?? [],
    concerns: row.concerns ?? [],
    contactStatus: row.contact_statuses ?? [],
    metrics,
    followUpNote: row.follow_up_note,
  };
}

function tagsOf(tags: { tag_type: string; code: string }[], type: ReviewTagType): string[] {
  return tags
    .filter((t) => t.tag_type === type)
    .map((t) => t.code)
    .sort();
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

const isRangeError = (error: PostgrestError | null) => error?.code === 'PGRST103';

function submissionError(error: PostgrestError): Error {
  if (error.code === '23505' && error.message.includes('reviews_one_active_per_product_idx')) {
    return new HttpError(409, 'You have already reviewed this product for this company', {
      fields: { productScheme: 'You already have an active review for this product' },
    });
  }
  if (error.code === 'P0001' && error.message === 'EVIDENCE_INVALID') {
    return new HttpError(400, 'Validation failed', {
      fields: { evidence: 'One or more files are invalid or already attached' },
    });
  }
  // Check and foreign-key violations mean the input slipped past validation.
  if (error.code === '23514' || error.code === '23503') {
    return new HttpError(400, 'Review data is invalid', { code: 'VALIDATION_FAILED' });
  }
  return error;
}

// ---------------------------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------------------------

/** Private Storage bucket holding review evidence, one folder per user. */
export const EVIDENCE_BUCKET = 'review-evidence';

export interface SubmitResult {
  receipt: ReviewReceipt;
  /** True when this Idempotency-Key already created the review and it is being returned again. */
  replayed: boolean;
}

/** Sentiment-specific columns, chosen exhaustively from the discriminated union. */
function sentimentFields(input: SubmitReviewInput) {
  switch (input.sentiment) {
    case 'Positive':
      return {
        detailedReview: input.detailedReview,
        mixedReview: null,
        negativeDescription: null,
        reinvestStatus: input.reinvestStatus,
        appreciations: [...input.appreciations],
        concerns: [] as string[],
        contactStatus: [] as string[],
      };
    case 'Neutral':
      return {
        detailedReview: input.detailedReview,
        mixedReview: input.mixedReview,
        negativeDescription: null,
        reinvestStatus: null,
        appreciations: [] as string[],
        concerns: [] as string[],
        contactStatus: [] as string[],
      };
    case 'Negative':
      return {
        detailedReview: input.detailedReview ?? null,
        mixedReview: null,
        negativeDescription: input.negativeDescription,
        reinvestStatus: null,
        appreciations: [] as string[],
        concerns: [...input.concerns],
        contactStatus: [...input.contactStatus],
      };
    default: {
      const unreachable: never = input;
      throw new Error(`Unhandled sentiment: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The review this Idempotency-Key already created, or null. The same key with a different body
 * is a client bug and gets 409.
 */
async function replayedReview(
  user: Member,
  idempotencyKey: string,
  hash: string,
): Promise<SubmitResult | null> {
  const { data: existing, error } = await supabaseAdmin
    .from('reviews')
    .select('id, request_hash')
    .eq('user_id', user.id)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) throw error;
  if (!existing) return null;

  if (existing.request_hash !== hash) {
    throw new HttpError(409, 'Idempotency-Key was already used for a different request', {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  }
  const receipt = await findOwnReview(user, existing.id);
  if (!receipt) {
    throw new HttpError(409, 'Idempotency-Key was already used', { code: 'IDEMPOTENCY_CONFLICT' });
  }
  return { receipt, replayed: true };
}

/**
 * Evidence must be the reviewer's own uploads in the evidence bucket, each attached once.
 * Returns field errors keyed like `evidence.0.path`.
 */
async function checkEvidence(
  user: Member,
  evidence: SubmitReviewInput['evidence'],
): Promise<Record<string, string>> {
  const fields: Record<string, string> = {};
  const paths = evidence.map((e) => e.path);
  if (paths.length === 0) return fields;
  if (new Set(paths).size !== paths.length) {
    fields.evidence = 'Each file can be attached once';
    return fields;
  }

  await Promise.all(
    paths.map(async (path, i) => {
      const key = `evidence.${i}.path`;
      if (!path.startsWith(`${user.id}/`)) {
        fields[key] = 'File not found';
        return;
      }
      // Resolves { data: false } for a missing object and throws on transport errors.
      const { data: exists } = await supabaseAdmin.storage.from(EVIDENCE_BUCKET).exists(path);
      if (!exists) fields[key] = 'File has not been uploaded yet';
    }),
  );
  if (Object.keys(fields).length > 0) return fields;

  const { data: attached, error } = await supabaseAdmin
    .from('review_attachments')
    .select('storage_path')
    .in('storage_path', paths);
  if (error) throw error;
  for (const { storage_path } of attached) {
    fields[`evidence.${paths.indexOf(storage_path)}.path`] =
      'File is already attached to another review';
  }
  return fields;
}

export async function submitReview(
  user: Member,
  input: SubmitReviewInput,
  idempotencyKey: string,
): Promise<SubmitResult> {
  const hash = hashRequest(input);
  const replay = await replayedReview(user, idempotencyKey, hash);
  if (replay) return replay;

  const fields: Record<string, string> = {};
  const companyExists = await assertCompanyExists(input.companyId).then(
    () => true,
    (err: unknown) => {
      if (err instanceof HttpError && err.status === 404) return false;
      throw err;
    },
  );
  if (!companyExists) fields.companyId = 'Company not found';
  Object.assign(fields, await checkEvidence(user, input.evidence));
  assertNoFieldErrors(fields);

  const s = sentimentFields(input);
  const { data, error } = await supabaseAdmin
    .rpc('submit_review', {
      p_user_id: user.id,
      p_idempotency_key: idempotencyKey,
      p_request_hash: hash,
      p_author_name: user.fullName,
      p_company_id: input.companyId,
      p_country: input.country,
      p_asset_class: input.assetClass,
      p_product_scheme: input.productScheme,
      p_investment_year: input.investmentYear === 'OLDER' ? null : input.investmentYear,
      p_investment_status: input.investmentStatus,
      p_sentiment: input.sentiment,
      p_detailed_review: s.detailedReview,
      p_mixed_review: s.mixedReview,
      p_negative_description: s.negativeDescription,
      p_reinvest_status: s.reinvestStatus,
      p_appreciations: s.appreciations,
      p_concerns: s.concerns,
      p_contact_statuses: s.contactStatus,
      p_evidence_paths: input.evidence.map((e) => e.path),
      p_evidence_doc_types: input.evidence.map((e) => e.docType),
      p_m_transparency: input.metrics.transparency,
      p_m_responsiveness: input.metrics.responsiveness,
      p_m_ease_of_process: input.metrics.easeOfProcess,
      p_m_trustworthiness: input.metrics.trustworthiness,
      p_m_overall_satisfaction: input.metrics.overallSatisfaction,
      p_resolution_status: input.resolutionStatus,
      p_follow_up_note: input.followUpNote || null,
      p_display_mode: input.displayMode,
      p_allow_contact: input.declarations.allowContact,
      p_declarations_version: DECLARATIONS_VERSION,
    })
    .single();

  if (error) {
    // A concurrent retry with the same key created the review first: return that one.
    if (error.code === '23505' && error.message.includes('reviews_idempotency_key_idx')) {
      const raced = await replayedReview(user, idempotencyKey, hash);
      if (raced) return raced;
    }
    throw submissionError(error);
  }

  const receipt = await findOwnReview(user, data.id);
  if (!receipt) throw new Error(`Submitted review ${data.id} could not be read back`);
  return { receipt, replayed: false };
}

// ---------------------------------------------------------------------------------------------
// Resolution update (reviewer only)
// ---------------------------------------------------------------------------------------------

export async function updateResolution(
  user: Member,
  reviewId: string,
  input: UpdateResolutionInput,
): Promise<ResolutionUpdate> {
  const { data, error } = await supabaseAdmin
    .rpc('update_review_resolution', {
      p_user_id: user.id,
      p_review_id: reviewId,
      p_resolution_status: input.resolutionStatus,
      p_follow_up_note: input.followUpNote || null,
      p_update_note: input.followUpNote !== undefined,
    })
    .single();

  if (error) {
    if (error.code === 'P0001' && error.message === 'REVIEW_NOT_FOUND') {
      throw new HttpError(404, 'Review not found');
    }
    throw error;
  }

  return {
    id: data.id,
    resolutionStatus: data.resolution_status,
    followUpNote: data.follow_up_note,
    updatedAt: data.updated_at,
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

const reviewSortOrders: Record<ReviewSort, ['created_at' | 'avg_rating', boolean][]> = {
  recent: [['created_at', false]],
  oldest: [['created_at', true]],
  highest: [
    ['avg_rating', false],
    ['created_at', false],
  ],
  lowest: [
    ['avg_rating', true],
    ['created_at', false],
  ],
};

export async function listCompanyReviews(
  companyId: string,
  query: ListCompanyReviewsQuery,
  user: Member | undefined,
): Promise<{ items: PublicReview[]; meta: PageMeta }> {
  await assertCompanyExists(companyId);
  const f = query.filter ?? {};

  const build = (head: boolean) => {
    let q = supabaseAdmin
      .from('review_feed')
      .select('*', { count: 'exact', head })
      .eq('company_id', companyId);
    if (f.sentiment?.length) q = q.in('sentiment', f.sentiment);
    if (f.resolution?.length) q = q.in('resolution_bucket', f.resolution);
    if (f.assetClass?.length) q = q.in('asset_class', f.assetClass);
    if (f.investedStatus?.length) q = q.in('investment_status', f.investedStatus);
    if (f.year?.length) q = q.in('investment_year', f.year);
    return q;
  };

  let request = build(false);
  for (const [column, ascending] of reviewSortOrders[query.sort]) {
    request = request.order(column, { ascending });
  }
  const { from, to } = pageRange(query);
  const { data, count, error } = await request.order('id').range(from, to);
  const meta = { page: query.page, pageSize: query.pageSize, total: count ?? 0 };

  if (isRangeError(error)) {
    const { count: total, error: countError } = await build(true);
    if (countError) throw countError;
    return { items: [], meta: { ...meta, total: total ?? 0 } };
  }
  if (error) throw error;

  const access = accessLevel(user);
  return { items: data.map((row) => toPublicReview(row, access)), meta };
}

export async function listMyReviews(
  user: Member,
  query: ListMyReviewsQuery,
): Promise<{ items: MyReviewItem[]; meta: PageMeta }> {
  const build = (head: boolean) => {
    let q = supabaseAdmin
      .from('reviews')
      .select(
        `id, receipt_no, status, sentiment, resolution_status, created_at, updated_at,
         m_transparency, m_responsiveness, m_ease_of_process, m_trustworthiness,
         m_overall_satisfaction, company:companies!inner(id, name)`,
        { count: 'exact', head },
      )
      .eq('user_id', user.id)
      .is('deleted_at', null);
    if (query.status?.length) q = q.in('status', query.status);
    return q;
  };

  const { from, to } = pageRange(query);
  const { data, count, error } = await build(false)
    .order('created_at', { ascending: false })
    .order('id')
    .range(from, to);
  const meta = { page: query.page, pageSize: query.pageSize, total: count ?? 0 };

  if (isRangeError(error)) {
    const { count: total, error: countError } = await build(true);
    if (countError) throw countError;
    return { items: [], meta: { ...meta, total: total ?? 0 } };
  }
  if (error) throw error;

  return {
    items: data.map((row) => ({
      id: row.id,
      receiptNo: row.receipt_no,
      status: row.status,
      company: { id: row.company.id, name: row.company.name },
      sentiment: row.sentiment,
      avgRating: averageRating(toMetrics(row)),
      resolutionStatus: row.resolution_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    meta,
  };
}

async function findOwnReview(user: Member, reviewId: string): Promise<ReviewReceipt | null> {
  const { data: row, error } = await supabaseAdmin
    .from('reviews')
    .select(
      `*,
       company:companies!inner(id, name, asset_class),
       review_tags(tag_type, code),
       review_attachments(storage_path, doc_type),
       review_versions(change_type, from_value, to_value, note, created_at)`,
    )
    .eq('id', reviewId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .order('created_at', { referencedTable: 'review_versions', ascending: true })
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;

  const metrics = toMetrics(row);
  return {
    detail: 'OWNER',
    id: row.id,
    receiptNo: row.receipt_no,
    status: row.status,
    moderationNote: row.moderation_note,
    reviewer: {
      name: row.author_name,
      displayName: displayNameFor(row.author_name, row.display_mode),
      tier: user.tier,
      kycVerified: user.kycStatus === 'APPROVED',
    },
    company: { id: row.company.id, name: row.company.name, assetClass: row.company.asset_class },
    country: row.country,
    assetClass: row.asset_class,
    productScheme: row.product_scheme,
    investmentYear: row.investment_year,
    investmentStatus: row.investment_status,
    sentiment: row.sentiment,
    detailedReview: row.detailed_review,
    mixedReview: row.mixed_review,
    negativeDescription: row.negative_description,
    reinvestStatus: row.reinvest_status,
    appreciations: tagsOf(row.review_tags, 'APPRECIATION'),
    concerns: tagsOf(row.review_tags, 'CONCERN'),
    contactStatus: tagsOf(row.review_tags, 'CONTACT_STATUS'),
    evidence: row.review_attachments.map((a) => ({
      path: a.storage_path,
      docType: a.doc_type,
      fileName: a.storage_path.slice(a.storage_path.indexOf('/') + 1),
    })),
    metrics,
    avgRating: averageRating(metrics),
    resolutionStatus: row.resolution_status,
    followUpNote: row.follow_up_note,
    displayMode: row.display_mode,
    allowContact: row.allow_contact,
    timeline: row.review_versions.map((e) => ({
      type: e.change_type,
      from: e.from_value,
      to: e.to_value,
      note: e.note,
      at: e.created_at,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

/** The owner gets the full receipt; anyone else sees the published review at their access level. */
export async function getReview(
  user: Member,
  reviewId: string,
): Promise<ReviewReceipt | PublicReview> {
  const own = await findOwnReview(user, reviewId);
  if (own) return own;

  const { data, error } = await supabaseAdmin
    .from('review_feed')
    .select('*')
    .eq('id', reviewId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Review not found');
  return toPublicReview(data, accessLevel(user));
}
