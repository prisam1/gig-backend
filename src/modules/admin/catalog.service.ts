import { audit } from '../../lib/audit';
import type { Member } from '../../lib/membership';
import { containsPattern, fetchPage, supabaseAdmin, unwrap } from '../../lib/supabase';
import { assertNoFieldErrors } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import type { Database, Tables } from '../../types/database';
import { compact, isSupabaseUniqueViolation, notFound, slugify, slugTaken } from './admin.shared';
import {
  issuerRangeErrors,
  type CreateCompanyInput,
  type CreateIssuerInput,
  type ListCompaniesQuery,
  type ListIssuersQuery,
  type UpdateCompanyInput,
  type UpdateIssuerInput,
} from './content.schemas';

// Companies (reviewed) and issuers (rated) as GIG staff manage them. Deleting is a soft delete:
// the row leaves every public list but its reviews, ratings and stats are kept.

type Tag = { tag: string; sort_order: number };

const byOrder = (tags: Tag[]) =>
  [...tags]
    .sort((a, b) => a.sort_order - b.sort_order || a.tag.localeCompare(b.tag))
    .map((t) => t.tag);

// ---------------------------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------------------------

const COMPANY_SELECT = '*, company_tags(tag, sort_order)';

type CompanyRow = Tables<'companies'> & { company_tags: Tag[] };

function toCompany(row: CompanyRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    assetClass: row.asset_class,
    country: row.country,
    logoUrl: row.logo_url,
    description: row.description,
    verified: row.verified,
    tags: byOrder(row.company_tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
export type AdminCompany = ReturnType<typeof toCompany>;

function companyColumns(
  input: UpdateCompanyInput,
): Database['public']['Tables']['companies']['Update'] {
  return compact({
    slug: input.slug,
    name: input.name,
    asset_class: input.assetClass,
    country: input.country,
    logo_url: input.logoUrl,
    description: input.description,
    verified: input.verified,
  });
}

async function replaceCompanyTags(companyId: string, tags: string[]): Promise<void> {
  unwrap(await supabaseAdmin.from('company_tags').delete().eq('company_id', companyId));
  if (tags.length === 0) return;
  unwrap(
    await supabaseAdmin
      .from('company_tags')
      .insert(tags.map((tag, i) => ({ company_id: companyId, tag, sort_order: i }))),
  );
}

export async function listCompanies(query: ListCompaniesQuery) {
  const build = (head: boolean) => {
    let q = supabaseAdmin.from('companies').select(COMPANY_SELECT, { count: 'exact', head });
    if (query.state === 'ACTIVE') q = q.is('deleted_at', null);
    if (query.state === 'DELETED') q = q.not('deleted_at', 'is', null);
    if (query.q) q = q.ilike('name', containsPattern(query.q));
    if (query.filter?.assetClass) q = q.in('asset_class', query.filter.assetClass);
    if (query.filter?.country) q = q.in('country', query.filter.country);
    if (query.filter?.verified !== undefined) q = q.eq('verified', query.filter.verified);
    return q;
  };
  const { rows, meta } = await fetchPage(query, {
    rows: (from, to) =>
      build(false)
        .order(query.sort === 'name' ? 'name' : 'created_at', { ascending: query.sort === 'name' })
        .order('id')
        .range(from, to),
    count: () => build(true),
  });
  return { items: rows.map(toCompany), meta };
}

/** Includes deleted companies, so staff can see what was removed. */
export async function getCompany(id: string): Promise<AdminCompany> {
  const row = unwrap(
    await supabaseAdmin.from('companies').select(COMPANY_SELECT).eq('id', id).maybeSingle(),
  );
  if (!row) throw notFound('Company');
  return toCompany(row);
}

async function activeCompany(id: string): Promise<AdminCompany> {
  const company = await getCompany(id);
  if (company.deletedAt !== null) throw notFound('Company');
  return company;
}

export async function createCompany(actor: Member, input: CreateCompanyInput, ctx: ClientContext) {
  let created;
  try {
    created = unwrap(
      await supabaseAdmin
        .from('companies')
        .insert({
          slug: input.slug ?? slugify(input.name),
          name: input.name,
          asset_class: input.assetClass,
          country: input.country,
          logo_url: input.logoUrl,
          description: input.description,
          verified: input.verified,
        })
        .select('id')
        .single(),
    );
  } catch (error) {
    if (isSupabaseUniqueViolation(error, 'companies_slug_key')) throw slugTaken();
    throw error;
  }
  await replaceCompanyTags(created.id, input.tags);
  await audit(ctx, 'admin.company.created', {
    userId: actor.userId,
    metadata: { company: created.id },
  });
  return getCompany(created.id);
}

export async function updateCompany(
  actor: Member,
  id: string,
  input: UpdateCompanyInput,
  ctx: ClientContext,
) {
  await activeCompany(id);
  const columns = companyColumns(input);
  if (Object.keys(columns).length > 0) {
    try {
      unwrap(await supabaseAdmin.from('companies').update(columns).eq('id', id));
    } catch (error) {
      if (isSupabaseUniqueViolation(error, 'companies_slug_key')) throw slugTaken();
      throw error;
    }
  }
  if (input.tags) await replaceCompanyTags(id, input.tags);
  await audit(ctx, 'admin.company.updated', {
    userId: actor.userId,
    metadata: { company: id, fields: Object.keys(input).sort() },
  });
  return getCompany(id);
}

export async function deleteCompany(actor: Member, id: string, ctx: ClientContext): Promise<void> {
  const rows = unwrap(
    await supabaseAdmin
      .from('companies')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id'),
  );
  if (rows.length === 0) throw notFound('Company');
  await audit(ctx, 'admin.company.deleted', { userId: actor.userId, metadata: { company: id } });
}

// ---------------------------------------------------------------------------------------------
// Issuers
// ---------------------------------------------------------------------------------------------

const ISSUER_SELECT = '*, issuer_tags(tag, sort_order)';

type IssuerRow = Tables<'issuers'> & { issuer_tags: Tag[] };

function toIssuer(row: IssuerRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    instrument: row.instrument,
    assetType: row.asset_type,
    exchange: row.exchange,
    openDate: row.open_date,
    closeDate: row.close_date,
    isListed: row.is_listed,
    minLot: row.min_lot,
    lotUnit: row.lot_unit,
    priceMin: row.price_min,
    priceMax: row.price_max,
    offerSize: row.offer_size,
    currency: row.currency,
    useOfFunds: row.use_of_funds,
    lockIn: row.lock_in,
    prePostRatio: row.pre_post_ratio,
    tags: byOrder(row.issuer_tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
export type AdminIssuer = ReturnType<typeof toIssuer>;

function issuerColumns(
  input: UpdateIssuerInput,
): Database['public']['Tables']['issuers']['Update'] {
  return compact({
    slug: input.slug,
    name: input.name,
    instrument: input.instrument,
    asset_type: input.assetType,
    exchange: input.exchange,
    open_date: input.openDate,
    close_date: input.closeDate,
    is_listed: input.isListed,
    min_lot: input.minLot,
    lot_unit: input.lotUnit,
    price_min: input.priceMin,
    price_max: input.priceMax,
    offer_size: input.offerSize,
    currency: input.currency,
    use_of_funds: input.useOfFunds,
    lock_in: input.lockIn,
    pre_post_ratio: input.prePostRatio,
  });
}

async function replaceIssuerTags(issuerId: string, tags: string[]): Promise<void> {
  unwrap(await supabaseAdmin.from('issuer_tags').delete().eq('issuer_id', issuerId));
  if (tags.length === 0) return;
  unwrap(
    await supabaseAdmin
      .from('issuer_tags')
      .insert(tags.map((tag, i) => ({ issuer_id: issuerId, tag, sort_order: i }))),
  );
}

export async function listIssuers(query: ListIssuersQuery) {
  const build = (head: boolean) => {
    let q = supabaseAdmin.from('issuers').select(ISSUER_SELECT, { count: 'exact', head });
    if (query.state === 'ACTIVE') q = q.is('deleted_at', null);
    if (query.state === 'DELETED') q = q.not('deleted_at', 'is', null);
    if (query.q) q = q.ilike('name', containsPattern(query.q));
    if (query.filter?.assetType) q = q.in('asset_type', query.filter.assetType);
    if (query.filter?.listed !== undefined) q = q.eq('is_listed', query.filter.listed);
    return q;
  };
  const { rows, meta } = await fetchPage(query, {
    rows: (from, to) =>
      build(false).order('created_at', { ascending: false }).order('id').range(from, to),
    count: () => build(true),
  });
  return { items: rows.map(toIssuer), meta };
}

export async function getIssuer(id: string): Promise<AdminIssuer> {
  const row = unwrap(
    await supabaseAdmin.from('issuers').select(ISSUER_SELECT).eq('id', id).maybeSingle(),
  );
  if (!row) throw notFound('Issuer');
  return toIssuer(row);
}

export async function createIssuer(actor: Member, input: CreateIssuerInput, ctx: ClientContext) {
  assertNoFieldErrors(issuerRangeErrors(input));
  let created;
  try {
    created = unwrap(
      await supabaseAdmin
        .from('issuers')
        .insert({
          ...issuerColumns(input),
          slug: input.slug ?? slugify(input.name),
          name: input.name,
          instrument: input.instrument,
          asset_type: input.assetType,
        })
        .select('id')
        .single(),
    );
  } catch (error) {
    if (isSupabaseUniqueViolation(error, 'issuers_slug_key')) throw slugTaken();
    throw error;
  }
  await replaceIssuerTags(created.id, input.tags);
  await audit(ctx, 'admin.issuer.created', {
    userId: actor.userId,
    metadata: { issuer: created.id },
  });
  return getIssuer(created.id);
}

export async function updateIssuer(
  actor: Member,
  id: string,
  input: UpdateIssuerInput,
  ctx: ClientContext,
) {
  const current = await getIssuer(id);
  if (current.deletedAt !== null) throw notFound('Issuer');
  // The ranges must hold for the values the issuer will have after this change.
  assertNoFieldErrors(issuerRangeErrors({ ...current, ...compact(input) }));

  const columns = issuerColumns(input);
  if (Object.keys(columns).length > 0) {
    try {
      unwrap(await supabaseAdmin.from('issuers').update(columns).eq('id', id));
    } catch (error) {
      if (isSupabaseUniqueViolation(error, 'issuers_slug_key')) throw slugTaken();
      throw error;
    }
  }
  if (input.tags) await replaceIssuerTags(id, input.tags);
  await audit(ctx, 'admin.issuer.updated', {
    userId: actor.userId,
    metadata: { issuer: id, fields: Object.keys(input).sort() },
  });
  return getIssuer(id);
}

export async function deleteIssuer(actor: Member, id: string, ctx: ClientContext): Promise<void> {
  const rows = unwrap(
    await supabaseAdmin
      .from('issuers')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id'),
  );
  if (rows.length === 0) throw notFound('Issuer');
  await audit(ctx, 'admin.issuer.deleted', { userId: actor.userId, metadata: { issuer: id } });
}
