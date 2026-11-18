import type { PageMeta } from '../../lib/http';
import { createSignedDownload, fileNameOf, type SignedDownload } from '../../lib/storage';
import { callDb } from '../../lib/db';
import { containsPattern, fetchPage, supabaseAdmin, unwrap } from '../../lib/supabase';
import { HttpError } from '../../middleware/errorHandler';
import type { Enums, Tables } from '../../types/database';
import type { AuthUser } from '../../middleware/auth';
import type { ListRoadshowsQuery, PostOfferInput, RoadshowSort } from './roadshows.schemas';

export type Currency = Enums<'currency_code'>;

/** Private Storage bucket holding the due-diligence PDFs. */
export const ROADSHOW_DOCUMENTS_BUCKET = 'roadshow-documents';

// ---------------------------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------------------------

/** What the app shows for a roadshow, stored as shown (20261118170000_roadshow_section_content.sql). */
export interface RoadshowDisplay {
  order: number;
  companyName: string | null;
  logoText: string;
  verified: string | null;
  industry: string | null;
  avgGigReview: number | null;
  gigRating: number | null;
  avgScore: number | null;
  /** The OPEN / CLOSED badge. */
  listed: boolean;
  /** "2 days left". */
  closeLabel: string | null;
  country: string | null;
  year: number | null;
  tags: string[];
  callable: string | null;
  couponRate: string | null;
}

export interface RoadshowCard {
  id: string;
  slug: string;
  title: string;
  /** null for the app's roadshows: they present a company of their own (see `display`). */
  issuer: { id: string; name: string } | null;
  typeOfIssue: string;
  instruments: string;
  offerPrice: number | null;
  currency: Currency;
  opensAt: string | null;
  closesAt: string;
  /** Opened (or no opening date) and not yet closed. */
  isOpen: boolean;
  poolEnabled: boolean;
  publishedAt: string | null;
  display: RoadshowDisplay;
}

export interface RoadshowDocumentInfo {
  id: string;
  title: string;
  docType: string;
  sizeBytes: number | null;
}

export interface RoadshowDetail extends RoadshowCard {
  summary: string | null;
  issueTerms: {
    noOfInstruments: number | null;
    lockIn: string | null;
    maturity: string | null;
    convertibility: string | null;
    callable: boolean;
    couponRate: number | null;
  };
  riskFactors: string[];
  /** Download through GET /roadshows/:id/documents/:docId (verified Prive and Institutional). */
  documents: RoadshowDocumentInfo[];
  /** Whether the signed-in member is in the Power Pool; null for signed-out visitors. */
  inPool: boolean | null;
  /** The financial summary, Ask Me Anything and Power Pool figures the app shows. */
  content: unknown;
}

export interface FinancialYear {
  fiscalYear: number;
  revenue: number | null;
  ebitda: number | null;
  netProfit: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  netWorth: number | null;
  totalDebt: number | null;
  cashAndEquivalents: number | null;
  operatingCashFlow: number | null;
  eps: number | null;
}

export interface RoadshowFinancials {
  roadshowId: string;
  /** Currency of the amounts below. */
  currency: Currency;
  /** Currency the issuer reports in. */
  reportingCurrency: Currency;
  /** Multiplier from the reporting currency; `asOf` is null when no conversion was needed. */
  fx: { rate: number; asOf: string | null };
  /** The latest 3 fiscal years, oldest first. */
  years: FinancialYear[];
}

export interface DocumentDownload extends SignedDownload {
  id: string;
  title: string;
  fileName: string;
}

export interface RoadshowOffer {
  id: string;
  roadshowId: string;
  status: Enums<'offer_status'>;
  currency: Currency;
  offerPrice: number | null;
  expectedRoi: number | null;
  expectedIrr: number | null;
  entryLoad: number | null;
  exitLoad: number | null;
  lockInMonths: number | null;
  minInvestment: number | null;
  allotmentTerms: string | null;
  paymentTerms: string | null;
  notes: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------------------------

function isOpenAt(row: { opens_at: string | null; closes_at: string }, now = Date.now()): boolean {
  const opened = row.opens_at === null || Date.parse(row.opens_at) <= now;
  return opened && Date.parse(row.closes_at) > now;
}

/** A published roadshow with the fields the other roadshow features need; 404 otherwise. */
export async function findPublishedRoadshow(id: string) {
  const row = unwrap(
    await supabaseAdmin
      .from('roadshows')
      .select('id, title, currency, opens_at, closes_at, pool_enabled')
      .eq('id', id)
      .eq('status', 'PUBLISHED')
      .maybeSingle(),
  );
  if (!row) throw new HttpError(404, 'Roadshow not found');
  return { ...row, isOpen: isOpenAt(row) };
}

export type PublishedRoadshow = Awaited<ReturnType<typeof findPublishedRoadshow>>;

// ---------------------------------------------------------------------------------------------
// List and detail
// ---------------------------------------------------------------------------------------------

const CARD_COLUMNS =
  'id, slug, title, type_of_issue, instruments, offer_price, currency, opens_at, closes_at, pool_enabled, published_at, display_order, company_name, logo_text, verified_label, industry, avg_gig_review, gig_rating, avg_score, listed, close_label, country_label, display_year, tags, callable_label, coupon_rate_label, issuer:issuers(id, name)';

type CardRow = Pick<
  Tables<'roadshows'>,
  | 'id'
  | 'slug'
  | 'title'
  | 'type_of_issue'
  | 'instruments'
  | 'offer_price'
  | 'currency'
  | 'opens_at'
  | 'closes_at'
  | 'pool_enabled'
  | 'published_at'
  | 'display_order'
  | 'company_name'
  | 'logo_text'
  | 'verified_label'
  | 'industry'
  | 'avg_gig_review'
  | 'gig_rating'
  | 'avg_score'
  | 'listed'
  | 'close_label'
  | 'country_label'
  | 'display_year'
  | 'tags'
  | 'callable_label'
  | 'coupon_rate_label'
> & { issuer: { id: string; name: string } | null };

function toCard(row: CardRow): RoadshowCard {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    issuer: row.issuer ? { id: row.issuer.id, name: row.issuer.name } : null,
    typeOfIssue: row.type_of_issue,
    instruments: row.instruments,
    offerPrice: row.offer_price,
    currency: row.currency,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    isOpen: isOpenAt(row),
    poolEnabled: row.pool_enabled,
    publishedAt: row.published_at,
    display: {
      order: row.display_order,
      companyName: row.company_name,
      logoText: row.logo_text,
      verified: row.verified_label,
      industry: row.industry,
      avgGigReview: row.avg_gig_review,
      gigRating: row.gig_rating,
      avgScore: row.avg_score,
      listed: row.listed,
      closeLabel: row.close_label,
      country: row.country_label,
      year: row.display_year,
      tags: row.tags,
      callable: row.callable_label,
      couponRate: row.coupon_rate_label,
    },
  };
}

type OrderColumn = 'closes_at' | 'published_at' | 'gig_rating' | 'avg_score';
const roadshowOrders: Record<RoadshowSort, [OrderColumn, boolean][]> = {
  closing_soon: [['closes_at', true]],
  recent: [['published_at', false]],
  display: [],
  rating_desc: [['gig_rating', false]],
  rating_asc: [['gig_rating', true]],
  avg_score_desc: [['avg_score', false]],
};

export async function listRoadshows(
  query: ListRoadshowsQuery,
): Promise<{ items: RoadshowCard[]; meta: PageMeta }> {
  const now = new Date().toISOString();
  const filter = query.filter ?? {};

  const build = (head: boolean) => {
    let q = supabaseAdmin
      .from('roadshows')
      .select(CARD_COLUMNS, { count: 'exact', head })
      .eq('status', 'PUBLISHED');
    if (query.state === 'OPEN') q = q.gt('closes_at', now);
    if (query.state === 'CLOSED') q = q.lte('closes_at', now);
    if (query.q) {
      const pattern = containsPattern(query.q);
      q = q.or(`search_text.ilike.${pattern},and(search_text.is.null,title.ilike.${pattern})`);
    }
    if (filter.country?.length) q = q.in('country_label', filter.country);
    if (filter.poolEnabled !== undefined) q = q.eq('pool_enabled', filter.poolEnabled);
    if (filter.currency?.length) q = q.in('currency', filter.currency);
    return q;
  };

  const { rows, meta } = await fetchPage(query, {
    rows: (from, to) => {
      let request = build(false);
      for (const [column, ascending] of roadshowOrders[query.sort]) {
        request = request.order(column, { ascending, nullsFirst: false });
      }
      // Ties keep the app's list order.
      return request.order('display_order').order('id').range(from, to);
    },
    count: () => build(true),
  });
  return { items: rows.map(toCard), meta };
}

async function isPoolMember(roadshowId: string, user: AuthUser): Promise<boolean> {
  const result = await supabaseAdmin
    .from('pool_members')
    .select('*', { count: 'exact', head: true })
    .eq('roadshow_id', roadshowId)
    .eq('user_id', user.id);
  unwrap(result);
  return (result.count ?? 0) > 0;
}

export async function getRoadshow(id: string, user: AuthUser | undefined): Promise<RoadshowDetail> {
  const row = unwrap(
    await supabaseAdmin
      .from('roadshows')
      .select(
        `${CARD_COLUMNS}, summary, no_of_instruments, lock_in, maturity, convertibility, callable,
         coupon_rate, risk_factors, roadshow_documents(id, title, doc_type, size_bytes, sort_order)`,
      )
      .eq('id', id)
      .eq('status', 'PUBLISHED')
      .order('sort_order', { referencedTable: 'roadshow_documents' })
      .maybeSingle(),
  );
  if (!row) throw new HttpError(404, 'Roadshow not found');

  return {
    ...toCard(row),
    summary: row.summary,
    issueTerms: {
      noOfInstruments: row.no_of_instruments,
      lockIn: row.lock_in,
      maturity: row.maturity,
      convertibility: row.convertibility,
      callable: row.callable,
      couponRate: row.coupon_rate,
    },
    riskFactors: row.risk_factors,
    documents: row.roadshow_documents.map((d) => ({
      id: d.id,
      title: d.title,
      docType: d.doc_type,
      sizeBytes: d.size_bytes,
    })),
    inPool: user ? await isPoolMember(id, user) : null,
    content: await callDb('app_roadshow_display', { p_roadshow_id: id }),
  };
}

// ---------------------------------------------------------------------------------------------
// Financials
// ---------------------------------------------------------------------------------------------

const FINANCIAL_YEARS = 3;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Rate that converts an amount in `from` into `to`, from the latest fx_rates. */
async function exchangeRate(from: Currency, to: Currency): Promise<RoadshowFinancials['fx']> {
  if (from === to) return { rate: 1, asOf: null };

  const rates = unwrap(
    await supabaseAdmin
      .from('fx_rates')
      .select('currency, per_usd, as_of')
      .in('currency', [from, to]),
  );
  const source = rates.find((r) => r.currency === from);
  const target = rates.find((r) => r.currency === to);
  if (!source || !target) {
    throw new HttpError(503, `No exchange rate for ${from} to ${to}`, {
      code: 'FX_RATE_UNAVAILABLE',
    });
  }
  const asOf = source.as_of < target.as_of ? source.as_of : target.as_of;
  return { rate: target.per_usd / source.per_usd, asOf };
}

function toFinancialYear(row: Tables<'roadshow_financials'>, rate: number): FinancialYear {
  const money = (value: number | null) => (value === null ? null : roundTo(value * rate, 2));
  return {
    fiscalYear: row.fiscal_year,
    revenue: money(row.revenue),
    ebitda: money(row.ebitda),
    netProfit: money(row.net_profit),
    totalAssets: money(row.total_assets),
    totalLiabilities: money(row.total_liabilities),
    netWorth: money(row.net_worth),
    totalDebt: money(row.total_debt),
    cashAndEquivalents: money(row.cash_and_equivalents),
    operatingCashFlow: money(row.operating_cash_flow),
    eps: row.eps === null ? null : roundTo(row.eps * rate, 4),
  };
}

export async function getFinancials(
  roadshowId: string,
  currency: Currency | undefined,
): Promise<RoadshowFinancials> {
  const roadshow = await findPublishedRoadshow(roadshowId);
  const target = currency ?? roadshow.currency;

  const [rows, fx] = await Promise.all([
    supabaseAdmin
      .from('roadshow_financials')
      .select('*')
      .eq('roadshow_id', roadshowId)
      .order('fiscal_year', { ascending: false })
      .limit(FINANCIAL_YEARS)
      .then(unwrap),
    exchangeRate(roadshow.currency, target),
  ]);

  return {
    roadshowId,
    currency: target,
    reportingCurrency: roadshow.currency,
    fx: { rate: roundTo(fx.rate, 8), asOf: fx.asOf },
    years: rows.reverse().map((row) => toFinancialYear(row, fx.rate)),
  };
}

// ---------------------------------------------------------------------------------------------
// Due-diligence documents
// ---------------------------------------------------------------------------------------------

export async function getDocumentDownload(
  roadshowId: string,
  documentId: string,
): Promise<DocumentDownload> {
  await findPublishedRoadshow(roadshowId);
  const doc = unwrap(
    await supabaseAdmin
      .from('roadshow_documents')
      .select('id, title, storage_path')
      .eq('id', documentId)
      .eq('roadshow_id', roadshowId)
      .maybeSingle(),
  );
  if (!doc) throw new HttpError(404, 'Document not found');

  const fileName = fileNameOf(doc.storage_path);
  const download = await createSignedDownload(
    ROADSHOW_DOCUMENTS_BUCKET,
    doc.storage_path,
    fileName,
  );
  return { id: doc.id, title: doc.title, fileName, ...download };
}

// ---------------------------------------------------------------------------------------------
// Institutional offers
// ---------------------------------------------------------------------------------------------

function toOffer(row: Tables<'roadshow_offers'>): RoadshowOffer {
  return {
    id: row.id,
    roadshowId: row.roadshow_id,
    status: row.status,
    currency: row.currency,
    offerPrice: row.offer_price,
    expectedRoi: row.expected_roi,
    expectedIrr: row.expected_irr,
    entryLoad: row.entry_load,
    exitLoad: row.exit_load,
    lockInMonths: row.lock_in_months,
    minInvestment: row.min_investment,
    allotmentTerms: row.allotment_terms,
    paymentTerms: row.payment_terms,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

/** Saved as PENDING_REVIEW; GIG staff publish it to the pool. */
export async function postOffer(
  user: AuthUser,
  roadshowId: string,
  input: PostOfferInput,
): Promise<RoadshowOffer> {
  const roadshow = await findPublishedRoadshow(roadshowId);
  const row = unwrap(
    await supabaseAdmin
      .from('roadshow_offers')
      .insert({
        roadshow_id: roadshowId,
        user_id: user.id,
        currency: input.currency ?? roadshow.currency,
        offer_price: input.offerPrice ?? null,
        expected_roi: input.expectedRoi ?? null,
        expected_irr: input.expectedIrr ?? null,
        entry_load: input.entryLoad ?? null,
        exit_load: input.exitLoad ?? null,
        lock_in_months: input.lockInMonths ?? null,
        min_investment: input.minInvestment ?? null,
        allotment_terms: input.allotmentTerms ?? null,
        payment_terms: input.paymentTerms ?? null,
        notes: input.notes ?? null,
      })
      .select('*')
      .single(),
  );
  return toOffer(row);
}
