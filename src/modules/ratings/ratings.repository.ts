import { z } from 'zod';
import { audit } from '../../lib/audit';
import { sql, transaction } from '../../lib/db';
import { containsPattern } from '../../lib/http';
import type { ClientContext } from '../../middleware/requestContext';
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

// Dates as YYYY-MM-DD text and numerics as numbers (postgres.js returns numeric as a string).
const issuerColumns = () => sql`
  id, slug, name, instrument, asset_type, exchange, is_listed,
  open_date::text as open_date, close_date::text as close_date,
  min_lot, lot_unit, price_min::float8 as price_min, price_max::float8 as price_max,
  offer_size::float8 as offer_size, currency, use_of_funds, lock_in, pre_post_ratio,
  tags, rating_count, average_score::float8 as average_score, created_at`;

function issuerOrder(sort: IssuerSort) {
  switch (sort) {
    case 'recent':
      return sql`open_date desc nulls last, created_at desc`;
    case 'closing_soon':
      return sql`close_date asc nulls last`;
    case 'top_rated':
      return sql`average_score desc, rating_count desc`;
    case 'most_rated':
      return sql`rating_count desc, average_score desc`;
  }
}

function issuerFilters(query: ListIssuersQuery) {
  const { q, filter } = query;
  return sql`
    where true
    ${q ? sql`and search_text like ${containsPattern(q)}` : sql``}
    ${filter?.assetType?.length ? sql`and asset_type in ${sql(filter.assetType)}` : sql``}
    ${filter?.listed !== undefined ? sql`and is_listed = ${filter.listed}` : sql``}`;
}

// The jsonb columns of issuer_stats are written by app.recompute_issuer_stats(); parse them rather
// than trusting their shape. They are read as text because the camelCase transform would also
// rename their keys (factor codes such as BUSINESS_OF_COMPANY).
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

const json = <S extends z.ZodType>(schema: S, text: string): z.output<S> =>
  schema.parse(JSON.parse(text));

interface StatsRow {
  ratingCount: number;
  averageScore: number;
  weightedScore: number;
  scoreDistribution: string;
  factorBreakdown: string;
  riskCounts: string;
  lastRatingAt: Date | null;
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export const ratingsRepository = {
  async findIssuers(query: ListIssuersQuery): Promise<Page<Issuer>> {
    const offset = (query.page - 1) * query.pageSize;
    const [rows, [count]] = await Promise.all([
      sql<IssuerRow[]>`
        select ${issuerColumns()} from app.issuer_cards
        ${issuerFilters(query)}
        order by ${issuerOrder(query.sort)}, id
        limit ${query.pageSize} offset ${offset}`,
      sql<{ total: number }[]>`
        select count(*)::int as total from app.issuer_cards ${issuerFilters(query)}`,
    ]);
    return { items: rows.map(toIssuer), total: count?.total ?? 0 };
  },

  async findIssuer(id: string): Promise<Issuer | null> {
    const [row] = await sql<IssuerRow[]>`
      select ${issuerColumns()} from app.issuer_cards where id = ${id}`;
    return row ? toIssuer(row) : null;
  },

  async findStats(issuerId: string): Promise<IssuerStats | null> {
    const [row] = await sql<StatsRow[]>`
      select rating_count, average_score::float8 as average_score,
             weighted_score::float8 as weighted_score,
             score_distribution::text as score_distribution,
             factor_breakdown::text as factor_breakdown,
             risk_counts::text as risk_counts, last_rating_at
      from app.issuer_stats where issuer_id = ${issuerId}`;
    if (!row) return null;

    return {
      ratingCount: row.ratingCount,
      averageScore: row.averageScore,
      weightedScore: row.weightedScore,
      scoreDistribution: json(scoreDistributionSchema, row.scoreDistribution),
      factorBreakdown: json(factorBreakdownSchema, row.factorBreakdown),
      riskCounts: json(riskCountsSchema, row.riskCounts),
      lastRatingAt: row.lastRatingAt,
    };
  },

  /** Saves the rating with its factor flags and risks, and audits it, in one transaction. */
  async submit(rating: NewRating, ctx: ClientContext): Promise<string> {
    return transaction(async (tx) => {
      const [created] = await tx<{ id: string; publicId: string }[]>`
        insert into app.issuer_ratings (issuer_id, user_id, overall_score, idempotency_key, request_hash)
        values (${rating.issuerId}, ${rating.userId}, ${rating.overallScore}, ${rating.idempotencyKey},
                ${rating.requestHash})
        returning id, public_id`;
      const ratingId = created!.id;

      const factors = rating.factors.map((f) => ({ ratingId, factorCode: f.code, flag: f.flag }));
      await tx`insert into app.issuer_rating_factors ${tx(factors, 'ratingId', 'factorCode', 'flag')}`;
      const risks = rating.riskCodes.map((riskCode) => ({ ratingId, riskCode }));
      await tx`insert into app.issuer_rating_risks ${tx(risks, 'ratingId', 'riskCode')}`;

      await audit(
        ctx,
        'rating.submitted',
        { userId: rating.userId, metadata: { rating: created!.publicId, issuer: rating.issuerId } },
        tx,
      );
      return created!.publicId;
    });
  },

  /** The rating a user already created with this Idempotency-Key, if any. */
  async findByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<{ publicId: string; requestHash: string | null } | null> {
    const [row] = await sql<{ publicId: string; requestHash: string | null }[]>`
      select public_id, request_hash from app.issuer_ratings
      where user_id = ${userId} and idempotency_key = ${idempotencyKey}`;
    return row ?? null;
  },

  /** One of the user's own, not-deleted ratings, with its factors and risks. */
  async findOwn(userId: string, publicId: string): Promise<StoredRating | null> {
    const [row] = await sql<StoredRating[]>`
      select r.public_id, r.receipt_no, r.status, r.overall_score, r.moderation_note, r.created_at,
             json_build_object('id', i.id, 'name', i.name) as issuer,
             (select coalesce(json_agg(json_build_object('code', f.factor_code, 'flag', f.flag)), '[]')
              from app.issuer_rating_factors f where f.rating_id = r.id) as factors,
             array(select k.risk_code from app.issuer_rating_risks k where k.rating_id = r.id
                   order by k.created_at, k.risk_code) as risk_codes
      from app.issuer_ratings r
      join public.issuers i on i.id = r.issuer_id
      where r.user_id = ${userId} and r.public_id = ${publicId} and r.deleted_at is null`;
    return row ?? null;
  },

  async findMine(userId: string, query: ListMyRatingsQuery): Promise<Page<MyRating>> {
    const offset = (query.page - 1) * query.pageSize;
    const filters = () => sql`
      where r.user_id = ${userId} and r.deleted_at is null
      ${query.status?.length ? sql`and r.status in ${sql(query.status)}` : sql``}`;

    const [rows, [count]] = await Promise.all([
      sql<MyRating[]>`
        select r.public_id, r.receipt_no, r.status, r.overall_score, r.created_at,
               json_build_object('id', i.id, 'name', i.name) as issuer
        from app.issuer_ratings r
        join public.issuers i on i.id = r.issuer_id
        ${filters()}
        order by r.created_at desc, r.id
        limit ${query.pageSize} offset ${offset}`,
      sql<
        { total: number }[]
      >`select count(*)::int as total from app.issuer_ratings r ${filters()}`,
    ]);
    return { items: rows, total: count?.total ?? 0 };
  },
};
