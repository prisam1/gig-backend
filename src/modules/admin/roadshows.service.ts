import { audit } from '../../lib/audit';
import { callDb } from '../../lib/db';
import type { Member } from '../../lib/membership';
import {
  containsPattern,
  DatabaseError,
  fetchPage,
  supabaseAdmin,
  unwrap,
} from '../../lib/supabase';
import { AppError, assertNoFieldErrors, validationError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import type { Database, Tables } from '../../types/database';
import {
  compact,
  isSupabaseUniqueViolation,
  notFound,
  slugify,
  slugTaken,
  unexpected,
} from './admin.shared';
import type {
  CreateRoadshowInput,
  FiscalYearInput,
  ListAdminRoadshowsQuery,
  RoadshowDocumentInput,
  UpdateRoadshowInput,
} from './content.schemas';
import { missingUploads, UPLOAD_TARGET_CONFIG } from './uploads.service';

// Roadshows as GIG staff manage them: drafts and archived ones included. Members see PUBLISHED
// roadshows only. "Deleting" archives a roadshow, since pool members and their credits refer to it.

const roadshowNotFound = () => notFound('Roadshow');

/** The row count of a head-only query; a failed query throws instead of counting as 0. */
function countOf(result: {
  count: number | null;
  error: { code: string; message: string } | null;
}): number {
  if (result.error) throw new DatabaseError(result.error.code, result.error.message);
  return result.count ?? 0;
}

function toRoadshow(row: Tables<'roadshows'>) {
  return {
    id: row.id,
    slug: row.slug,
    issuerId: row.issuer_id,
    title: row.title,
    summary: row.summary,
    typeOfIssue: row.type_of_issue,
    instruments: row.instruments,
    noOfInstruments: row.no_of_instruments,
    offerPrice: row.offer_price,
    currency: row.currency,
    lockIn: row.lock_in,
    maturity: row.maturity,
    convertibility: row.convertibility,
    callable: row.callable,
    couponRate: row.coupon_rate,
    riskFactors: row.risk_factors,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    poolEnabled: row.pool_enabled,
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function roadshowColumns(
  input: UpdateRoadshowInput,
): Database['public']['Tables']['roadshows']['Update'] {
  return compact({
    slug: input.slug,
    issuer_id: input.issuerId,
    title: input.title,
    summary: input.summary,
    type_of_issue: input.typeOfIssue,
    instruments: input.instruments,
    no_of_instruments: input.noOfInstruments,
    offer_price: input.offerPrice,
    currency: input.currency,
    lock_in: input.lockIn,
    maturity: input.maturity,
    convertibility: input.convertibility,
    callable: input.callable,
    coupon_rate: input.couponRate,
    risk_factors: input.riskFactors,
    opens_at: input.opensAt,
    closes_at: input.closesAt,
    pool_enabled: input.poolEnabled,
    status: input.status,
  });
}

async function findRoadshowRow(id: string): Promise<Tables<'roadshows'>> {
  const row = unwrap(await supabaseAdmin.from('roadshows').select('*').eq('id', id).maybeSingle());
  if (!row) throw roadshowNotFound();
  return row;
}

async function assertIssuerExists(issuerId: string): Promise<void> {
  const issuer = unwrap(
    await supabaseAdmin
      .from('issuers')
      .select('id')
      .eq('id', issuerId)
      .is('deleted_at', null)
      .maybeSingle(),
  );
  if (!issuer) throw validationError({ issuerId: 'Unknown issuer' });
}

function closesAfterOpens(opensAt: string | null, closesAt: string): void {
  if (opensAt && new Date(closesAt) <= new Date(opensAt)) {
    throw validationError({ closesAt: 'Must be after the opening date' });
  }
}

const slugConflict = (error: unknown) =>
  isSupabaseUniqueViolation(error, 'roadshows_slug_key') ? slugTaken() : error;

export async function listRoadshows(query: ListAdminRoadshowsQuery) {
  const build = (head: boolean) => {
    let q = supabaseAdmin.from('roadshows').select('*', { count: 'exact', head });
    if (query.q) q = q.ilike('title', containsPattern(query.q));
    if (query.filter?.status) q = q.in('status', query.filter.status);
    return q;
  };
  const { rows, meta } = await fetchPage(query, {
    rows: (from, to) =>
      build(false).order('created_at', { ascending: false }).order('id').range(from, to),
    count: () => build(true),
  });
  return { items: rows.map(toRoadshow), meta };
}

/** A roadshow with its issuer, financials, DD documents and what is waiting for staff. */
export async function getRoadshow(id: string) {
  const row = await findRoadshowRow(id);
  const head = { count: 'exact', head: true } as const;

  const [issuer, financials, documents, members, pendingQuestions, pendingOffers] =
    await Promise.all([
      supabaseAdmin.from('issuers').select('id, name').eq('id', row.issuer_id).maybeSingle(),
      supabaseAdmin
        .from('roadshow_financials')
        .select('*')
        .eq('roadshow_id', id)
        .order('fiscal_year'),
      supabaseAdmin
        .from('roadshow_documents')
        .select('*')
        .eq('roadshow_id', id)
        .order('sort_order')
        .order('created_at'),
      supabaseAdmin.from('pool_members').select('roadshow_id', head).eq('roadshow_id', id),
      supabaseAdmin
        .from('roadshow_questions')
        .select('id', head)
        .eq('roadshow_id', id)
        .eq('status', 'PENDING_MODERATION'),
      supabaseAdmin
        .from('roadshow_offers')
        .select('id', head)
        .eq('roadshow_id', id)
        .eq('status', 'PENDING_REVIEW'),
    ]);

  return {
    ...toRoadshow(row),
    issuer: unwrap(issuer),
    financials: unwrap(financials).map(toFiscalYear),
    documents: unwrap(documents).map(toDocument),
    counts: {
      poolMembers: countOf(members),
      pendingQuestions: countOf(pendingQuestions),
      pendingOffers: countOf(pendingOffers),
    },
  };
}

export async function createRoadshow(
  actor: Member,
  input: CreateRoadshowInput,
  ctx: ClientContext,
) {
  await assertIssuerExists(input.issuerId);
  let created;
  try {
    created = unwrap(
      await supabaseAdmin
        .from('roadshows')
        .insert({
          ...roadshowColumns(input),
          slug: input.slug ?? slugify(input.title),
          issuer_id: input.issuerId,
          title: input.title,
          type_of_issue: input.typeOfIssue,
          instruments: input.instruments,
          closes_at: input.closesAt,
          published_at: input.status === 'PUBLISHED' ? new Date().toISOString() : null,
        })
        .select('id')
        .single(),
    );
  } catch (error) {
    throw slugConflict(error);
  }
  await audit(ctx, 'admin.roadshow.created', {
    userId: actor.userId,
    metadata: { roadshow: created.id },
  });
  return getRoadshow(created.id);
}

export async function updateRoadshow(
  actor: Member,
  id: string,
  input: UpdateRoadshowInput,
  ctx: ClientContext,
) {
  const current = await findRoadshowRow(id);
  if (input.issuerId) await assertIssuerExists(input.issuerId);
  closesAfterOpens(
    input.opensAt === undefined ? current.opens_at : input.opensAt,
    input.closesAt ?? current.closes_at,
  );

  const columns = roadshowColumns(input);
  // Publishing stamps the first publication date.
  if (input.status === 'PUBLISHED' && current.published_at === null) {
    columns.published_at = new Date().toISOString();
  }
  try {
    unwrap(await supabaseAdmin.from('roadshows').update(columns).eq('id', id));
  } catch (error) {
    throw slugConflict(error);
  }
  await audit(ctx, 'admin.roadshow.updated', {
    userId: actor.userId,
    metadata: { roadshow: id, fields: Object.keys(input).sort() },
  });
  return getRoadshow(id);
}

/** Archives the roadshow: it leaves the member app; pool members, questions and offers are kept. */
export async function archiveRoadshow(
  actor: Member,
  id: string,
  ctx: ClientContext,
): Promise<void> {
  const rows = unwrap(
    await supabaseAdmin
      .from('roadshows')
      .update({ status: 'ARCHIVED' })
      .eq('id', id)
      .neq('status', 'ARCHIVED')
      .select('id'),
  );
  if (rows.length === 0) throw roadshowNotFound();
  await audit(ctx, 'admin.roadshow.deleted', { userId: actor.userId, metadata: { roadshow: id } });
}

// ---------------------------------------------------------------------------------------------
// Financials
// ---------------------------------------------------------------------------------------------

function toFiscalYear(row: Tables<'roadshow_financials'>) {
  return {
    fiscalYear: row.fiscal_year,
    revenue: row.revenue,
    ebitda: row.ebitda,
    netProfit: row.net_profit,
    totalAssets: row.total_assets,
    totalLiabilities: row.total_liabilities,
    netWorth: row.net_worth,
    totalDebt: row.total_debt,
    cashAndEquivalents: row.cash_and_equivalents,
    operatingCashFlow: row.operating_cash_flow,
    eps: row.eps,
  };
}

/** Replaces every fiscal year of the roadshow; metrics left out are stored as unknown (null). */
export async function replaceFinancials(
  actor: Member,
  id: string,
  years: FiscalYearInput[],
  ctx: ClientContext,
) {
  await findRoadshowRow(id);

  // Upsert first, then drop the years no longer listed, so a failed write never loses data.
  if (years.length > 0) {
    unwrap(
      await supabaseAdmin.from('roadshow_financials').upsert(
        years.map((y) => ({
          roadshow_id: id,
          fiscal_year: y.fiscalYear,
          revenue: y.revenue ?? null,
          ebitda: y.ebitda ?? null,
          net_profit: y.netProfit ?? null,
          total_assets: y.totalAssets ?? null,
          total_liabilities: y.totalLiabilities ?? null,
          net_worth: y.netWorth ?? null,
          total_debt: y.totalDebt ?? null,
          cash_and_equivalents: y.cashAndEquivalents ?? null,
          operating_cash_flow: y.operatingCashFlow ?? null,
          eps: y.eps ?? null,
        })),
        { onConflict: 'roadshow_id,fiscal_year' },
      ),
    );
  }
  let stale = supabaseAdmin.from('roadshow_financials').delete().eq('roadshow_id', id);
  if (years.length > 0)
    stale = stale.not('fiscal_year', 'in', `(${years.map((y) => y.fiscalYear).join(',')})`);
  unwrap(await stale);

  await audit(ctx, 'admin.roadshow.financials_replaced', {
    userId: actor.userId,
    metadata: { roadshow: id, years: years.map((y) => y.fiscalYear).sort() },
  });
  const rows = unwrap(
    await supabaseAdmin
      .from('roadshow_financials')
      .select('*')
      .eq('roadshow_id', id)
      .order('fiscal_year'),
  );
  return rows.map(toFiscalYear);
}

// ---------------------------------------------------------------------------------------------
// Due-diligence documents
// ---------------------------------------------------------------------------------------------

const DOCUMENTS_BUCKET = UPLOAD_TARGET_CONFIG.ROADSHOW_DOCUMENT.bucket;

function toDocument(row: Tables<'roadshow_documents'>) {
  return {
    id: row.id,
    title: row.title,
    docType: row.doc_type,
    path: row.storage_path,
    sizeBytes: row.size_bytes,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

export async function addRoadshowDocument(
  actor: Member,
  id: string,
  input: RoadshowDocumentInput,
  ctx: ClientContext,
) {
  await findRoadshowRow(id);
  assertNoFieldErrors(
    await missingUploads(DOCUMENTS_BUCKET, [{ field: 'path', path: input.path }]),
  );

  let row;
  try {
    row = unwrap(
      await supabaseAdmin
        .from('roadshow_documents')
        .insert({
          roadshow_id: id,
          title: input.title,
          doc_type: input.docType,
          storage_path: input.path,
          size_bytes: input.sizeBytes,
          sort_order: input.sortOrder,
        })
        .select('*')
        .single(),
    );
  } catch (error) {
    if (isSupabaseUniqueViolation(error, 'roadshow_documents_storage_path_key')) {
      throw new AppError(409, 'DOCUMENT_ALREADY_ATTACHED', 'This file is already attached');
    }
    throw error;
  }
  await audit(ctx, 'admin.roadshow.document_added', {
    userId: actor.userId,
    metadata: { roadshow: id, document: row.id },
  });
  return toDocument(row);
}

export async function removeRoadshowDocument(
  actor: Member,
  id: string,
  docId: string,
  ctx: ClientContext,
) {
  const rows = unwrap(
    await supabaseAdmin
      .from('roadshow_documents')
      .delete()
      .eq('id', docId)
      .eq('roadshow_id', id)
      .select('id'),
  );
  if (rows.length === 0) throw notFound('Document');
  await audit(ctx, 'admin.roadshow.document_removed', {
    userId: actor.userId,
    metadata: { roadshow: id, document: docId },
  });
}

// ---------------------------------------------------------------------------------------------
// Ask Me Anything
// ---------------------------------------------------------------------------------------------

/** Publishes the issuer's answer (replacing any earlier one); answering publishes the question. */
export async function answerQuestion(
  actor: Member,
  roadshowId: string,
  questionId: string,
  input: { answer: string; featured?: boolean | undefined },
  ctx: ClientContext,
) {
  const result = await callDb('app_admin_answer_question', {
    p_actor_id: actor.userId,
    p_roadshow_id: roadshowId,
    p_question_id: questionId,
    p_answer: input.answer,
    p_featured: input.featured ?? null,
    p_ctx: ctx,
  });
  if ('error' in result) {
    switch (result.error) {
      case 'NOT_FOUND':
        throw notFound('Question');
      case 'QUESTION_REJECTED':
        throw new AppError(409, 'QUESTION_REJECTED', 'A rejected question cannot be answered');
      default:
        throw unexpected('app_admin_answer_question', result);
    }
  }
  return result.question;
}
