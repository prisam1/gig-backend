import { z } from 'zod';
import { containsPattern, pageRange, RANGE_NOT_SATISFIABLE } from '../../lib/http';
import { DatabaseError, supabaseAdmin, unwrap } from '../../lib/supabase';
import type { Views } from '../../types/database';
import type { RatingFlag, RatingStatus } from '../../types/domain';
import type { IssuerSort, ListIssuersQuery, ListMyRatingsQuery } from './ratings.schemas';

// ---------------------------------------------------------------------------------------------
// Domain shapes
// ---------------------------------------------------------------------------------------------

export interface IssuerOffer {
  minLot: number | null;
  lotUnit: string;
  priceMin: number | null;
  priceMax: number | null;
  offerSize: number | null;
  currency: string;
  useOfFunds: string | null;
  lockIn: string | null;
  prePostRatio: string | null;
}

export interface Issuer {
  id: string;
  slug: string;
  name: string;
  instrument: string;
  assetType: string;
  exchange: string | null;
  isListed: boolean;
  openDate: string | null;
  closeDate: string | null;
  offer: IssuerOffer;
  tags: string[];
  ratingCount: number;
  averageScore: number;
  createdAt: string;
}

export type ScoreDistribution = Record<'1' | '2' | '3' | '4' | '5', number>;
export type FlagShares = Record<RatingFlag, number>;

export interface IssuerStats {
  ratingCount: number;
  averageScore: number;
  weightedScore: number;
  scoreDistribution: ScoreDistribution;
  /** Percentage of published ratings giving each flag, per factor code. */
  factorBreakdown: Record<string, FlagShares>;
  /** Number of published ratings that picked each risk code. */
  riskCounts: Record<string, number>;
  lastRatingAt: string | null;
}

// A type alias (not an interface) so it is assignable to the `Json` RPC argument.
export type FactorFlag = {
  code: string;
  flag: RatingFlag;
};

export interface NewRating {
  userId: number;
  issuerId: string;
  overallScore: number;
  factors: FactorFlag[];
  riskCodes: string[];
  idempotencyKey: string;
  requestHash: string;
}

export interface StoredRating {
  publicId: string;
  receiptNo: string;
  status: RatingStatus;
  overallScore: number;
  moderationNote: string | null;
  createdAt: string;
  issuer: { id: string; name: string };
  factors: FactorFlag[];
  riskCodes: string[];
}

export type MyRating = Omit<StoredRating, 'moderationNote' | 'factors' | 'riskCodes'>;

export interface Page<T> {
  items: T[];
  total: number;
}

/** Index names the service maps to API errors. */
export const RATING_INDEXES = {
  onePerUser: 'issuer_ratings_one_per_user_idx',
  idempotencyKey: 'issuer_ratings_idempotency_key_idx',
} as const;

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

type IssuerCardRow = Views<'issuer_cards'>;

/** View columns are typed nullable; these are guaranteed by the underlying table. */
function required<T>(value: T | null, column: string): T {
  if (value === null) throw new Error(`issuer_cards.${column} is unexpectedly null`);
  return value;
}

function toIssuer(row: IssuerCardRow): Issuer {
  return {
    id: required(row.id, 'id'),
    slug: required(row.slug, 'slug'),
    name: required(row.name, 'name'),
    instrument: required(row.instrument, 'instrument'),
    assetType: required(row.asset_type, 'asset_type'),
    exchange: row.exchange,
    isListed: row.is_listed ?? false,
    openDate: row.open_date,
    closeDate: row.close_date,
    offer: {
      minLot: row.min_lot,
      lotUnit: row.lot_unit ?? 'shares',
      priceMin: row.price_min,
      priceMax: row.price_max,
      offerSize: row.offer_size,
      currency: row.currency ?? 'INR',
      useOfFunds: row.use_of_funds,
      lockIn: row.lock_in,
      prePostRatio: row.pre_post_ratio,
    },
    tags: row.tags ?? [],
    ratingCount: row.rating_count ?? 0,
    averageScore: row.average_score ?? 0,
    createdAt: required(row.created_at, 'created_at'),
  };
}

// The jsonb columns of issuer_stats are written by recompute_issuer_stats(); parse them rather
// than trusting their shape.
const scoreDistributionSchema = z.object({
  '1': z.number(),
  '2': z.number(),
  '3': z.number(),
  '4': z.number(),
  '5': z.number(),
});
const flagSharesSchema = z.object({
  POSITIVE: z.number(),
  NEUTRAL: z.number(),
  NEGATIVE: z.number(),
}) satisfies z.ZodType<FlagShares>;
const factorBreakdownSchema = z.record(z.string(), flagSharesSchema);
const riskCountsSchema = z.record(z.string(), z.number().int());

export const EMPTY_DISTRIBUTION: ScoreDistribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };

const ISSUER_ORDER: Record<IssuerSort, [keyof IssuerCardRow & string, boolean][]> = {
  recent: [
    ['open_date', false],
    ['created_at', false],
  ],
  closing_soon: [['close_date', true]],
  top_rated: [
    ['average_score', false],
    ['rating_count', false],
  ],
  most_rated: [
    ['rating_count', false],
    ['average_score', false],
  ],
};

const STORED_RATING_COLUMNS = `public_id, receipt_no, status, overall_score, moderation_note, created_at,
  issuer:issuers!inner(id, name),
  issuer_rating_factors(factor_code, flag),
  issuer_rating_risks(risk_code)`;

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

function isRangeError(error: unknown): boolean {
  return error instanceof DatabaseError && error.code === RANGE_NOT_SATISFIABLE;
}

export const ratingsRepository = {
  async findIssuers(query: ListIssuersQuery): Promise<Page<Issuer>> {
    const build = (head: boolean) => {
      let q = supabaseAdmin.from('issuer_cards').select('*', { count: 'exact', head });
      if (query.q) q = q.ilike('search_text', containsPattern(query.q));
      if (query.filter?.assetType?.length) q = q.in('asset_type', query.filter.assetType);
      if (query.filter?.listed !== undefined) q = q.eq('is_listed', query.filter.listed);
      return q;
    };

    let request = build(false);
    for (const [column, ascending] of ISSUER_ORDER[query.sort]) {
      request = request.order(column, { ascending, nullsFirst: false });
    }
    const { from, to } = pageRange(query);
    const result = await request.order('id').range(from, to);

    try {
      const rows = unwrap(result);
      return { items: rows.map(toIssuer), total: result.count ?? rows.length };
    } catch (error) {
      if (!isRangeError(error)) throw error;
      const head = await build(true);
      unwrap(head);
      return { items: [], total: head.count ?? 0 };
    }
  },

  async findIssuer(id: string): Promise<Issuer | null> {
    const row = unwrap(
      await supabaseAdmin.from('issuer_cards').select('*').eq('id', id).maybeSingle(),
    );
    return row && toIssuer(row);
  },

  async findStats(issuerId: string): Promise<IssuerStats | null> {
    const row = unwrap(
      await supabaseAdmin.from('issuer_stats').select('*').eq('issuer_id', issuerId).maybeSingle(),
    );
    if (!row) return null;

    return {
      ratingCount: row.rating_count,
      averageScore: row.average_score,
      weightedScore: row.weighted_score,
      scoreDistribution: scoreDistributionSchema.parse(row.score_distribution),
      factorBreakdown: factorBreakdownSchema.parse(row.factor_breakdown),
      riskCounts: riskCountsSchema.parse(row.risk_counts),
      lastRatingAt: row.last_rating_at,
    };
  },

  /** Saves the rating with its factor flags and risks in one transaction. */
  async submit(rating: NewRating): Promise<{ publicId: string }> {
    const row = unwrap(
      await supabaseAdmin
        .rpc('submit_issuer_rating', {
          p_user_id: rating.userId,
          p_issuer_id: rating.issuerId,
          p_overall_score: rating.overallScore,
          p_factors: rating.factors,
          p_risk_codes: rating.riskCodes,
          p_idempotency_key: rating.idempotencyKey,
          p_request_hash: rating.requestHash,
        })
        .single(),
    );
    return { publicId: row.public_id };
  },

  /** The rating a user already created with this Idempotency-Key, if any. */
  async findByIdempotencyKey(
    userId: number,
    idempotencyKey: string,
  ): Promise<{ publicId: string; requestHash: string | null } | null> {
    const row = unwrap(
      await supabaseAdmin
        .from('issuer_ratings')
        .select('public_id, request_hash')
        .eq('user_id', userId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle(),
    );
    return row && { publicId: row.public_id, requestHash: row.request_hash };
  },

  /** One of the user's own ratings, with its factors and risks. */
  async findOwn(userId: number, publicId: string): Promise<StoredRating | null> {
    const row = unwrap(
      await supabaseAdmin
        .from('issuer_ratings')
        .select(STORED_RATING_COLUMNS)
        .eq('user_id', userId)
        .eq('public_id', publicId)
        .is('deleted_at', null)
        .maybeSingle(),
    );
    if (!row) return null;

    return {
      publicId: row.public_id,
      receiptNo: row.receipt_no,
      status: row.status,
      overallScore: row.overall_score,
      moderationNote: row.moderation_note,
      createdAt: row.created_at,
      issuer: { id: row.issuer.id, name: row.issuer.name },
      factors: row.issuer_rating_factors.map((f) => ({ code: f.factor_code, flag: f.flag })),
      riskCodes: row.issuer_rating_risks.map((r) => r.risk_code),
    };
  },

  async findMine(userId: number, query: ListMyRatingsQuery): Promise<Page<MyRating>> {
    const build = (head: boolean) => {
      let q = supabaseAdmin
        .from('issuer_ratings')
        .select(
          'public_id, receipt_no, status, overall_score, created_at, issuer:issuers!inner(id, name)',
          {
            count: 'exact',
            head,
          },
        )
        .eq('user_id', userId)
        .is('deleted_at', null);
      if (query.status?.length) q = q.in('status', query.status);
      return q;
    };

    const { from, to } = pageRange(query);
    const result = await build(false)
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, to);

    try {
      const rows = unwrap(result);
      return {
        items: rows.map((row) => ({
          publicId: row.public_id,
          receiptNo: row.receipt_no,
          status: row.status,
          overallScore: row.overall_score,
          createdAt: row.created_at,
          issuer: { id: row.issuer.id, name: row.issuer.name },
        })),
        total: result.count ?? rows.length,
      };
    } catch (error) {
      if (!isRangeError(error)) throw error;
      const head = await build(true);
      unwrap(head);
      return { items: [], total: head.count ?? 0 };
    }
  },
};
