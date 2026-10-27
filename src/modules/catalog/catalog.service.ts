import type { PageMeta } from '../../lib/http';
import { pageRange } from '../../lib/http';
import { supabaseAdmin } from '../../lib/supabase';
import type { Member } from '../../lib/membership';
import { HttpError } from '../../middleware/errorHandler';
import type { Database, Enums, Views } from '../../types/database';
import type { CompanySort, ListCompaniesQuery, TrendRange } from './catalog.schemas';

type CompanyCardRow = Views<'company_cards'>;

export interface SentimentSplit {
  positive: number;
  neutral: number;
  negative: number;
}

export interface Scorecard {
  transparency: number;
  responsiveness: number;
  easeOfProcess: number;
  trustworthiness: number;
  overallSatisfaction: number;
}

/** Percentages of published reviews per resolution bucket. */
export interface ResolutionLens {
  resolved: number;
  inProgress: number;
  unresolved: number;
  notContacted: number;
}

export interface CompanyCard {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  assetClass: Enums<'asset_class'>;
  country: Enums<'market_country'>;
  logoUrl: string | null;
  verified: boolean;
  tags: string[];
  totalReviews: number;
  /** Weighted score 0-5 (newer reviews weigh more). 0 when there are no reviews. */
  rating: number;
  /** Rating rounded to a whole star, null when there are no reviews. */
  avgScore: number | null;
  sentiment: Enums<'sentiment'> | null;
  sentimentSplit: SentimentSplit;
  resolution: Enums<'resolution_bucket'> | null;
  createdAt: string;
}

export interface CompanyAnalytics {
  resolutionLens: ResolutionLens;
  reviewsLast30Days: number;
  scoreChange12m: number;
  lastReviewAt: string | null;
}

export type AccessLevel = 'SUMMARY' | 'FULL';

export interface CompanyDetail extends CompanyCard {
  access: AccessLevel;
  scorecard: Scorecard;
  /** Verified Prive and Institutional members only; null otherwise. */
  analytics: CompanyAnalytics | null;
}

export interface CompanyComparison {
  id: string;
  name: string;
  assetClass: Enums<'asset_class'>;
  totalReviews: number;
  rating: number;
  sentimentSplit: SentimentSplit;
  scorecard: Scorecard;
  /** Verified Prive and Institutional members only; null otherwise. */
  resolutionLens: ResolutionLens | null;
  /** Change in average overall satisfaction vs 12 months ago. Full access only. */
  scoreChange12m: number | null;
}

export interface TrendSeries {
  /** Latest cumulative value, null when there are no reviews yet. */
  value: number | null;
  /** Change vs the start of the range (12M/24M ago, or the first month for ALL). */
  change: number | null;
  points: { month: string; value: number | null }[];
}

export interface CompanyTrends {
  range: TrendRange;
  reviewCount: number;
  overallSatisfaction: TrendSeries;
  positiveSentiment: TrendSeries;
}

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

/** View columns are typed nullable; these are guaranteed by the underlying tables. */
function required<T>(value: T | null, column: string): T {
  if (value === null) throw new Error(`company_cards.${column} is unexpectedly null`);
  return value;
}

function toCard(row: CompanyCardRow): CompanyCard {
  const reviews = row.review_count ?? 0;
  const rating = row.score ?? 0;
  return {
    id: required(row.id, 'id'),
    slug: required(row.slug, 'slug'),
    name: required(row.name, 'name'),
    description: row.description,
    assetClass: required(row.asset_class, 'asset_class'),
    country: required(row.country, 'country'),
    logoUrl: row.logo_url,
    verified: row.verified ?? false,
    tags: row.tags ?? [],
    totalReviews: reviews,
    rating,
    avgScore: reviews > 0 ? Math.round(rating) : null,
    sentiment: row.dominant_sentiment,
    sentimentSplit: {
      positive: row.positive_pct ?? 0,
      neutral: row.neutral_pct ?? 0,
      negative: row.negative_pct ?? 0,
    },
    resolution: row.dominant_resolution,
    createdAt: required(row.created_at, 'created_at'),
  };
}

function toScorecard(row: CompanyCardRow): Scorecard {
  return {
    transparency: row.avg_transparency ?? 0,
    responsiveness: row.avg_responsiveness ?? 0,
    easeOfProcess: row.avg_ease_of_process ?? 0,
    trustworthiness: row.avg_trustworthiness ?? 0,
    overallSatisfaction: row.avg_overall_satisfaction ?? 0,
  };
}

function toResolutionLens(row: CompanyCardRow): ResolutionLens {
  return {
    resolved: row.resolved_pct ?? 0,
    inProgress: row.in_progress_pct ?? 0,
    unresolved: row.unresolved_pct ?? 0,
    notContacted: row.not_contacted_pct ?? 0,
  };
}

export function accessLevel(user: Member | undefined): AccessLevel {
  return user?.hasFullAccess ? 'FULL' : 'SUMMARY';
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

type SortColumn = keyof CompanyCardRow & string;

const sortOrders: Record<CompanySort, [SortColumn, 'asc' | 'desc'][]> = {
  relevant: [
    ['relevance', 'desc'],
    ['review_count', 'desc'],
  ],
  recent: [['created_at', 'desc']],
  trending: [
    ['reviews_30d', 'desc'],
    ['review_count', 'desc'],
  ],
  top_rated: [
    ['score', 'desc'],
    ['review_count', 'desc'],
  ],
  most_reviewed: [
    ['review_count', 'desc'],
    ['score', 'desc'],
  ],
  improving: [
    ['score_change_12m', 'desc'],
    ['score', 'desc'],
  ],
};

type SearchArgs = Database['public']['Functions']['search_companies']['Args'];

function nonEmpty<T>(list: T[] | undefined): T[] | undefined {
  return list && list.length > 0 ? list : undefined;
}

/** Escapes LIKE wildcards so user input matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function searchArgs(query: ListCompaniesQuery): SearchArgs {
  const f = query.filter ?? {};
  const years = f.year ?? [];
  const exactYears = years.filter((y) => !y.startsWith('before_')).map(Number);
  const beforeYears = years.filter((y) => y.startsWith('before_')).map((y) => Number(y.slice(7)));

  return {
    p_q: query.q ? escapeLike(query.q) : undefined,
    p_sentiments: nonEmpty(f.sentiment),
    p_asset_classes: nonEmpty(f.assetClass),
    p_resolutions: nonEmpty(f.resolution),
    p_scores: nonEmpty(f.score),
    p_countries: nonEmpty(f.country),
    p_investment_statuses: nonEmpty(f.investedStatus),
    p_years: nonEmpty(exactYears),
    p_years_before: beforeYears.length > 0 ? Math.max(...beforeYears) : undefined,
  };
}

export async function listCompanies(
  query: ListCompaniesQuery,
): Promise<{ items: CompanyCard[]; meta: PageMeta }> {
  const { from, to } = pageRange(query);
  const args = searchArgs(query);

  let request = supabaseAdmin.rpc('search_companies', args, { count: 'exact' });
  for (const [column, direction] of sortOrders[query.sort]) {
    request = request.order(column, { ascending: direction === 'asc' });
  }
  const { data, count, error } = await request.order('id').range(from, to);

  // PostgREST answers 416 (PGRST103) when the page starts past the last row.
  if (error?.code === 'PGRST103') {
    const { count: total, error: countError } = await supabaseAdmin.rpc('search_companies', args, {
      count: 'exact',
      head: true,
    });
    if (countError) throw countError;
    return { items: [], meta: { page: query.page, pageSize: query.pageSize, total: total ?? 0 } };
  }
  if (error) throw error;

  return {
    items: data.map(toCard),
    meta: { page: query.page, pageSize: query.pageSize, total: count ?? data.length },
  };
}

async function findCompanyRow(id: string): Promise<CompanyCardRow> {
  const { data, error } = await supabaseAdmin
    .from('company_cards')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Company not found');
  return data;
}

export async function assertCompanyExists(id: string): Promise<void> {
  const { count, error } = await supabaseAdmin
    .from('companies')
    .select('id', { count: 'exact', head: true })
    .eq('id', id)
    .is('deleted_at', null);
  if (error) throw error;
  if (!count) throw new HttpError(404, 'Company not found');
}

export async function getCompany(id: string, user: Member | undefined): Promise<CompanyDetail> {
  const row = await findCompanyRow(id);
  const access = accessLevel(user);
  return {
    ...toCard(row),
    access,
    scorecard: toScorecard(row),
    analytics:
      access === 'FULL'
        ? {
            resolutionLens: toResolutionLens(row),
            reviewsLast30Days: row.reviews_30d ?? 0,
            scoreChange12m: row.score_change_12m ?? 0,
            lastReviewAt: row.last_review_at,
          }
        : null,
  };
}

export async function compareCompanies(
  ids: string[],
  user: Member,
): Promise<CompanyComparison[]> {
  const { data, error } = await supabaseAdmin.from('company_cards').select('*').in('id', ids);
  if (error) throw error;

  const byId = new Map(data.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new HttpError(404, `Company not found: ${missing.join(', ')}`);

  const full = accessLevel(user) === 'FULL';
  return ids.map((id) => {
    const row = byId.get(id)!;
    const card = toCard(row);
    return {
      id: card.id,
      name: card.name,
      assetClass: card.assetClass,
      totalReviews: card.totalReviews,
      rating: card.rating,
      sentimentSplit: card.sentimentSplit,
      scorecard: toScorecard(row),
      resolutionLens: full ? toResolutionLens(row) : null,
      scoreChange12m: full ? (row.score_change_12m ?? 0) : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------------------------

/** 'YYYY-MM' for a UTC year and 0-based month index (which may overflow either way). */
function monthKey(year: number, monthIndex: number): string {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthsBetween(start: string, end: string): string[] {
  const [sy, sm] = start.split('-').map(Number) as [number, number];
  const months: string[] = [];
  for (let i = 0; ; i++) {
    const key = monthKey(sy, sm - 1 + i);
    months.push(key);
    if (key >= end) return months;
  }
}

const round = (n: number, digits: number) => Number(n.toFixed(digits));

export async function getCompanyTrends(id: string, range: TrendRange): Promise<CompanyTrends> {
  await assertCompanyExists(id);

  const { data, error } = await supabaseAdmin
    .from('company_trend_points')
    .select('month, review_count, overall_sum, positive_count')
    .eq('company_id', id)
    .order('month');
  if (error) throw error;

  const now = new Date();
  const current = monthKey(now.getUTCFullYear(), now.getUTCMonth());
  const points = data.map((p) => ({ ...p, month: p.month.slice(0, 7) }));
  const first = points[0];

  const windowStart =
    range === 'ALL'
      ? (first?.month ?? current)
      : monthKey(now.getUTCFullYear(), now.getUTCMonth() - (range === '12M' ? 11 : 23));

  // Cumulative totals up to (not including) the window, i.e. the "12M/24M ago" baseline.
  let count = 0;
  let overall = 0;
  let positive = 0;
  for (const p of points) {
    if (p.month >= windowStart) break;
    count += p.review_count;
    overall += p.overall_sum;
    positive += p.positive_count;
  }
  const baseline = {
    overall: count > 0 ? overall / count : null,
    positive: count > 0 ? (100 * positive) / count : null,
  };

  const byMonth = new Map(points.map((p) => [p.month, p]));
  const overallPoints: TrendSeries['points'] = [];
  const positivePoints: TrendSeries['points'] = [];
  let windowCount = 0;

  for (const month of monthsBetween(windowStart, current)) {
    const p = byMonth.get(month);
    if (p) {
      count += p.review_count;
      overall += p.overall_sum;
      positive += p.positive_count;
      windowCount += p.review_count;
    }
    overallPoints.push({ month, value: count > 0 ? round(overall / count, 2) : null });
    positivePoints.push({ month, value: count > 0 ? round((100 * positive) / count, 1) : null });
  }

  const series = (pts: TrendSeries['points'], base: number | null, digits: number): TrendSeries => {
    const value = pts.at(-1)?.value ?? null;
    // For ALL the baseline is the first month of the series ("since launch").
    const start = range === 'ALL' ? (pts.find((p) => p.value !== null)?.value ?? null) : base;
    return {
      value,
      change: value !== null && start !== null ? round(value - start, digits) : null,
      points: pts,
    };
  };

  return {
    range,
    reviewCount: windowCount,
    overallSatisfaction: series(overallPoints, baseline.overall, 2),
    positiveSentiment: series(positivePoints, baseline.positive, 1),
  };
}
