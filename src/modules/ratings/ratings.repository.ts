import { z } from 'zod';
import { callDb } from '../../lib/db';
import { containsPattern } from '../../lib/http';
import type { ClientContext } from '../../middleware/requestContext';
import type { RatingFlag, RatingStatus } from '../../types/domain';
import type { IssuerSort, ListIssuersQuery } from './ratings.schemas';

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
  /** YYYY-MM-DD */
  openDate: string | null;
  /** YYYY-MM-DD */
  closeDate: string | null;
  offer: IssuerOffer;
  tags: string[];
  ratingCount: number;
  averageScore: number;
  createdAt: Date;
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
  lastRatingAt: Date | null;
}

export interface FactorFlag {
  code: string;
  flag: RatingFlag;
}

export interface NewRating {
  userId: string;
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
  createdAt: Date;
  issuer: { id: string; name: string };
  factors: FactorFlag[];
  riskCodes: string[];
}

export interface Page<T> {
  items: T[];
  total: number;
}

/** Index names the service maps to API errors. */
export const RATING_INDEXES = {
  onePerUser: 'issuer_ratings_one_per_user_idx',
  idempotencyKey: 'issuer_ratings_idempotency_key_idx',
} as const;

export const EMPTY_DISTRIBUTION: ScoreDistribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

interface IssuerRow extends IssuerOffer {
  id: string;
  slug: string;
  name: string;
  instrument: string;
  assetType: string;
  exchange: string | null;
  isListed: boolean;
  openDate: string | null;
  closeDate: string | null;
  tags: string[];
  ratingCount: number;
  averageScore: number;
  createdAt: Date;
}

function toIssuer(row: IssuerRow): Issuer {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    instrument: row.instrument,
    assetType: row.assetType,
    exchange: row.exchange,
    isListed: row.isListed,
    openDate: row.openDate,
    closeDate: row.closeDate,
    offer: {
      minLot: row.minLot,
      lotUnit: row.lotUnit,
      priceMin: row.priceMin,
      priceMax: row.priceMax,
      offerSize: row.offerSize,
      currency: row.currency,
      useOfFunds: row.useOfFunds,
      lockIn: row.lockIn,
      prePostRatio: row.prePostRatio,
    },
    tags: row.tags,
    ratingCount: row.ratingCount,
    averageScore: row.averageScore,
    createdAt: row.createdAt,
  };
}

// The jsonb columns of issuer_stats are written by app.recompute_issuer_stats(); parse them rather
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

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export const ratingsRepository = {
  async findIssuers(query: ListIssuersQuery): Promise<Page<Issuer>> {
    const page = await callDb('app_find_issuers', {
      p_q_pattern: query.q ? containsPattern(query.q) : null,
      p_asset_types: query.filter?.assetType ?? null,
      p_listed: query.filter?.listed ?? null,
      p_sort: query.sort satisfies IssuerSort,
      p_limit: query.pageSize,
      p_offset: (query.page - 1) * query.pageSize,
    });
    return { items: page.items.map(toIssuer), total: page.total };
  },

  async findIssuer(id: string): Promise<Issuer | null> {
    const row = await callDb('app_find_issuer', { p_id: id });
    return row ? toIssuer(row) : null;
  },

  async findStats(issuerId: string): Promise<IssuerStats | null> {
    const row = await callDb('app_issuer_stats', { p_issuer_id: issuerId });
    if (!row) return null;

    return {
      ratingCount: row.ratingCount,
      averageScore: row.averageScore,
      weightedScore: row.weightedScore,
      scoreDistribution: scoreDistributionSchema.parse(row.scoreDistribution),
      factorBreakdown: factorBreakdownSchema.parse(row.factorBreakdown),
      riskCounts: riskCountsSchema.parse(row.riskCounts),
      lastRatingAt: row.lastRatingAt,
    };
  },

  /** Saves the rating with its factor flags and risks, and audits it, in one transaction. */
  submit(rating: NewRating, ctx: ClientContext): Promise<string> {
    return callDb('app_rating_submit', { p_rating: rating, p_ctx: ctx });
  },

  /** The rating a user already created with this Idempotency-Key, if any. */
  findByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<{ publicId: string; requestHash: string | null } | null> {
    return callDb('app_rating_by_idempotency_key', {
      p_user_id: userId,
      p_idempotency_key: idempotencyKey,
    });
  },

  /** One of the user's own, not-deleted ratings, with its factors and risks. */
  async findOwn(userId: string, publicId: string): Promise<StoredRating | null> {
    const row = await callDb('app_rating_own', {
      p_user_id: userId,
      p_public_id: publicId,
    });
    return row;
  },

};
