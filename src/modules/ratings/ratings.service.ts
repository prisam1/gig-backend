import type { PageMeta } from '../../lib/http';
import { hashRequest, type IdempotentResult } from '../../lib/idempotency';
import { hasFullAccess } from '../../lib/membership';
import { DatabaseError, PG_UNIQUE_VIOLATION } from '../../lib/supabase';
import { HttpError, validationError, type FieldErrors } from '../../middleware/errorHandler';
import type { RatingFlag, RatingStatus, Tier } from '../../types/domain';
import { lookupsRepository, type LookupOption } from '../lookups/lookups.repository';
import { usersRepository, type User } from '../users/users.repository';
import {
  EMPTY_DISTRIBUTION,
  RATING_INDEXES,
  ratingsRepository,
  type Issuer,
  type ScoreDistribution,
  type StoredRating,
} from './ratings.repository';
import type { ListIssuersQuery, ListMyRatingsQuery, SubmitRatingInput } from './ratings.schemas';

// ---------------------------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------------------------

export type AccessLevel = 'SUMMARY' | 'FULL';

export interface IssuerSummary extends Omit<Issuer, 'ratingCount' | 'averageScore'> {
  rating: {
    count: number;
    /** Mean overall score of published ratings; null until the first one. */
    averageScore: number | null;
  };
}

export interface FactorBreakdown {
  code: string;
  label: string;
  /** Percentages of published ratings giving each flag. */
  positive: number;
  neutral: number;
  negative: number;
}

export interface RiskShare {
  code: string;
  label: string;
  count: number;
  /** Share of published ratings that picked this risk. */
  percent: number;
}

export interface RatingSummary {
  issuerId: string;
  access: AccessLevel;
  ratingCount: number;
  averageScore: number | null;
  /** Verified Prive and Institutional members only; null otherwise. */
  breakdown: {
    /** Newer ratings weigh more (1.0 decaying to 0.5 over 24 months). */
    weightedScore: number | null;
    distribution: ScoreDistribution;
    factors: FactorBreakdown[];
    riskFactors: RiskShare[];
    lastRatedAt: string | null;
  } | null;
}

export interface RatingReceipt {
  id: string;
  receiptNo: string;
  status: RatingStatus;
  moderationNote: string | null;
  issuer: { id: string; name: string };
  overallScore: number;
  factors: { code: string; label: string; flag: RatingFlag }[];
  riskFactors: { code: string; label: string }[];
  rater: { name: string | null; tier: Tier };
  createdAt: string;
}

export interface MyRatingItem {
  id: string;
  receiptNo: string;
  status: RatingStatus;
  issuer: { id: string; name: string };
  overallScore: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function toIssuerSummary({ ratingCount, averageScore, ...issuer }: Issuer): IssuerSummary {
  return {
    ...issuer,
    rating: { count: ratingCount, averageScore: ratingCount > 0 ? averageScore : null },
  };
}

function labelLookup(options: LookupOption[]): (code: string) => string {
  const labels = new Map(options.map((option) => [option.code, option.label]));
  return (code) => labels.get(code) ?? code;
}

async function requireIssuer(issuerId: string): Promise<Issuer> {
  const issuer = await ratingsRepository.findIssuer(issuerId);
  if (!issuer) throw new HttpError(404, 'Issuer not found');
  return issuer;
}

/** Field errors for factor and risk codes that are not the active options. */
function checkCodes(
  input: SubmitRatingInput,
  factorOptions: LookupOption[],
  riskOptions: LookupOption[],
): FieldErrors {
  const fields: FieldErrors = {};
  const factorCodes = new Set(factorOptions.map((o) => o.code));
  const riskCodes = new Set(riskOptions.map((o) => o.code));

  input.factors.forEach((factor, i) => {
    if (!factorCodes.has(factor.code)) fields[`factors.${i}.code`] = 'Unknown rating factor';
  });
  const flagged = new Set(input.factors.map((f) => f.code));
  const missing = factorOptions.filter((o) => !flagged.has(o.code)).map((o) => o.code);
  if (missing.length > 0) {
    fields.factors = `Flag every rating factor (missing: ${missing.join(', ')})`;
  }

  input.riskFactors.forEach((code, i) => {
    if (!riskCodes.has(code)) fields[`riskFactors.${i}`] = 'Unknown risk factor';
  });
  return fields;
}

function toReceipt(
  rating: StoredRating,
  user: User,
  raterName: string | null,
  factorLabel: (code: string) => string,
  riskLabel: (code: string) => string,
  factorOrder: string[],
): RatingReceipt {
  const order = (code: string) => factorOrder.indexOf(code);
  return {
    id: rating.publicId,
    receiptNo: rating.receiptNo,
    status: rating.status,
    moderationNote: rating.moderationNote,
    issuer: rating.issuer,
    overallScore: rating.overallScore,
    factors: [...rating.factors]
      .sort((a, b) => order(a.code) - order(b.code))
      .map((f) => ({ code: f.code, label: factorLabel(f.code), flag: f.flag })),
    riskFactors: rating.riskCodes.map((code) => ({ code, label: riskLabel(code) })),
    rater: { name: raterName, tier: user.tier },
    createdAt: rating.createdAt,
  };
}

function isUniqueViolationOf(error: unknown, index: string): boolean {
  return (
    error instanceof DatabaseError &&
    error.code === PG_UNIQUE_VIOLATION &&
    error.message.includes(index)
  );
}

/** The rating this key already created, or null; a reused key with another body is a 409. */
async function replay(
  user: User,
  idempotencyKey: string,
  requestHash: string,
): Promise<IdempotentResult<RatingReceipt> | null> {
  const existing = await ratingsRepository.findByIdempotencyKey(user.id, idempotencyKey);
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new HttpError(409, 'Idempotency-Key was already used for a different request', {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  }
  return { result: await receipt(user, existing.publicId), replayed: true };
}

async function receipt(user: User, publicId: string): Promise<RatingReceipt> {
  const [rating, profile, factorOptions, riskOptions] = await Promise.all([
    ratingsRepository.findOwn(user.id, publicId),
    usersRepository.findProfile(user.id),
    lookupsRepository.findActive('RATING_FACTOR'),
    lookupsRepository.findActive('RISK_FACTOR'),
  ]);
  if (!rating) throw new Error(`Rating ${publicId} could not be read back`);

  return toReceipt(
    rating,
    user,
    profile?.name?.trim() || null,
    labelLookup(factorOptions),
    labelLookup(riskOptions),
    factorOptions.map((o) => o.code),
  );
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export const ratingsService = {
  async listIssuers(query: ListIssuersQuery): Promise<{ items: IssuerSummary[]; meta: PageMeta }> {
    const { items, total } = await ratingsRepository.findIssuers(query);
    return {
      items: items.map(toIssuerSummary),
      meta: { page: query.page, pageSize: query.pageSize, total },
    };
  },

  async getIssuer(issuerId: string): Promise<IssuerSummary> {
    return toIssuerSummary(await requireIssuer(issuerId));
  },

  /** Public aggregate score; verified Prive and Institutional members also get the breakdown. */
  async getRatingSummary(issuerId: string, viewer: User | undefined): Promise<RatingSummary> {
    await requireIssuer(issuerId);
    const stats = await ratingsRepository.findStats(issuerId);
    const ratingCount = stats?.ratingCount ?? 0;
    const access: AccessLevel = viewer && hasFullAccess(viewer) ? 'FULL' : 'SUMMARY';

    const summary = {
      issuerId,
      access,
      ratingCount,
      averageScore: stats && ratingCount > 0 ? stats.averageScore : null,
    };
    if (access === 'SUMMARY') return { ...summary, breakdown: null };

    const [factorOptions, riskOptions] = await Promise.all([
      lookupsRepository.findActive('RATING_FACTOR'),
      lookupsRepository.findActive('RISK_FACTOR'),
    ]);
    const riskCounts = stats?.riskCounts ?? {};

    return {
      ...summary,
      breakdown: {
        weightedScore: stats && ratingCount > 0 ? stats.weightedScore : null,
        distribution: stats?.scoreDistribution ?? EMPTY_DISTRIBUTION,
        factors: factorOptions.map(({ code, label }) => {
          const shares = stats?.factorBreakdown[code];
          return {
            code,
            label,
            positive: shares?.POSITIVE ?? 0,
            neutral: shares?.NEUTRAL ?? 0,
            negative: shares?.NEGATIVE ?? 0,
          };
        }),
        riskFactors: riskOptions
          .map(({ code, label }) => {
            const count = riskCounts[code] ?? 0;
            const percent = ratingCount > 0 ? Math.round((1000 * count) / ratingCount) / 10 : 0;
            return { code, label, count, percent };
          })
          .sort((a, b) => b.count - a.count),
        lastRatedAt: stats?.lastRatingAt ?? null,
      },
    };
  },

  /**
   * Saves a rating (pending moderation) and returns its receipt. A retry with the same
   * Idempotency-Key and body returns the same receipt.
   */
  async submitRating(
    user: User,
    issuerId: string,
    input: SubmitRatingInput,
    idempotencyKey: string,
  ): Promise<IdempotentResult<RatingReceipt>> {
    const requestHash = hashRequest({ issuerId, ...input });
    const previous = await replay(user, idempotencyKey, requestHash);
    if (previous) return previous;

    await requireIssuer(issuerId);
    const [factorOptions, riskOptions] = await Promise.all([
      lookupsRepository.findActive('RATING_FACTOR'),
      lookupsRepository.findActive('RISK_FACTOR'),
    ]);
    const fields = checkCodes(input, factorOptions, riskOptions);
    if (Object.keys(fields).length > 0) throw validationError(fields);

    try {
      const { publicId } = await ratingsRepository.submit({
        userId: user.id,
        issuerId,
        overallScore: input.overallScore,
        factors: input.factors,
        riskCodes: input.riskFactors,
        idempotencyKey,
        requestHash,
      });
      return { result: await receipt(user, publicId), replayed: false };
    } catch (error) {
      if (isUniqueViolationOf(error, RATING_INDEXES.onePerUser)) {
        throw new HttpError(409, 'You have already rated this issuer', {
          code: 'RATING_ALREADY_SUBMITTED',
        });
      }
      // A concurrent retry with the same key saved the rating first: return that one.
      if (isUniqueViolationOf(error, RATING_INDEXES.idempotencyKey)) {
        const raced = await replay(user, idempotencyKey, requestHash);
        if (raced) return raced;
      }
      // The factor or risk options changed between validation and saving.
      if (error instanceof DatabaseError && error.message.includes('RATING_FACTORS_INCOMPLETE')) {
        throw validationError({ factors: 'Flag every rating factor' });
      }
      if (error instanceof DatabaseError && error.message.includes('RATING_RISKS_INVALID')) {
        throw validationError({ riskFactors: 'Select exactly 3 risk factors' });
      }
      throw error;
    }
  },

  async listMyRatings(
    user: User,
    query: ListMyRatingsQuery,
  ): Promise<{ items: MyRatingItem[]; meta: PageMeta }> {
    const { items, total } = await ratingsRepository.findMine(user.id, query);
    return {
      items: items.map((rating) => ({
        id: rating.publicId,
        receiptNo: rating.receiptNo,
        status: rating.status,
        issuer: rating.issuer,
        overallScore: rating.overallScore,
        createdAt: rating.createdAt,
      })),
      meta: { page: query.page, pageSize: query.pageSize, total },
    };
  },
};
