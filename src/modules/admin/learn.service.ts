import { audit } from '../../lib/audit';
import type { Member } from '../../lib/membership';
import { containsPattern, fetchPage, supabaseAdmin, unwrap } from '../../lib/supabase';
import { assertNoFieldErrors } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import type { Database, Tables } from '../../types/database';
import { compact, notFound } from './admin.shared';
import type { CreateLearnInput, ListAdminLearnQuery, UpdateLearnInput } from './content.schemas';
import { missingUploads, UPLOAD_TARGET_CONFIG } from './uploads.service';

// Learn content as GIG staff manage it: drafts and archived items included. "Deleting" archives
// an item, keeping its ratings.

const REPORTS_BUCKET = UPLOAD_TARGET_CONFIG.LEARN_REPORT.bucket;

const learnNotFound = () => notFound('Learn item');

function toLearnItem(row: Tables<'learn_items'>) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    format: row.format,
    category: row.category,
    access: row.access,
    thumbnailUrl: row.thumbnail_url,
    contentUrl: row.content_url,
    durationSeconds: row.duration_seconds,
    downloadPath: row.download_path,
    ratingAvg: row.rating_avg,
    ratingCount: row.rating_count,
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function learnColumns(
  input: UpdateLearnInput,
): Database['public']['Tables']['learn_items']['Update'] {
  return compact({
    title: input.title,
    summary: input.summary,
    format: input.format,
    category: input.category,
    access: input.access,
    thumbnail_url: input.thumbnailUrl,
    content_url: input.contentUrl,
    duration_seconds: input.durationSeconds,
    download_path: input.downloadPath,
    status: input.status,
  });
}

async function findLearnRow(id: string): Promise<Tables<'learn_items'>> {
  const row = unwrap(
    await supabaseAdmin.from('learn_items').select('*').eq('id', id).maybeSingle(),
  );
  if (!row) throw learnNotFound();
  return row;
}

async function assertReportUploaded(downloadPath: string | null | undefined): Promise<void> {
  if (!downloadPath) return;
  assertNoFieldErrors(
    await missingUploads(REPORTS_BUCKET, [{ field: 'downloadPath', path: downloadPath }]),
  );
}

export async function listLearnItems(query: ListAdminLearnQuery) {
  const build = (head: boolean) => {
    let q = supabaseAdmin.from('learn_items').select('*', { count: 'exact', head });
    if (query.q) q = q.ilike('title', containsPattern(query.q));
    if (query.filter?.status) q = q.in('status', query.filter.status);
    if (query.filter?.format) q = q.in('format', query.filter.format);
    if (query.filter?.access) q = q.in('access', query.filter.access);
    return q;
  };
  const { rows, meta } = await fetchPage(query, {
    rows: (from, to) =>
      build(false).order('created_at', { ascending: false }).order('id').range(from, to),
    count: () => build(true),
  });
  return { items: rows.map(toLearnItem), meta };
}

export async function getLearnItem(id: string) {
  return toLearnItem(await findLearnRow(id));
}

export async function createLearnItem(actor: Member, input: CreateLearnInput, ctx: ClientContext) {
  await assertReportUploaded(input.downloadPath);
  const row = unwrap(
    await supabaseAdmin
      .from('learn_items')
      .insert({
        ...learnColumns(input),
        title: input.title,
        format: input.format,
        published_at: input.status === 'PUBLISHED' ? new Date().toISOString() : null,
      })
      .select('*')
      .single(),
  );
  await audit(ctx, 'admin.learn.created', {
    userId: actor.userId,
    metadata: { learnItem: row.id },
  });
  return toLearnItem(row);
}

export async function updateLearnItem(
  actor: Member,
  id: string,
  input: UpdateLearnInput,
  ctx: ClientContext,
) {
  const current = await findLearnRow(id);
  await assertReportUploaded(input.downloadPath);

  const columns = learnColumns(input);
  // Publishing stamps the first publication date.
  if (input.status === 'PUBLISHED' && current.published_at === null) {
    columns.published_at = new Date().toISOString();
  }
  const row = unwrap(
    await supabaseAdmin.from('learn_items').update(columns).eq('id', id).select('*').single(),
  );
  await audit(ctx, 'admin.learn.updated', {
    userId: actor.userId,
    metadata: { learnItem: id, fields: Object.keys(input).sort() },
  });
  return toLearnItem(row);
}

/** Archives the item: it leaves the member app; its ratings are kept. */
export async function archiveLearnItem(
  actor: Member,
  id: string,
  ctx: ClientContext,
): Promise<void> {
  const rows = unwrap(
    await supabaseAdmin
      .from('learn_items')
      .update({ status: 'ARCHIVED' })
      .eq('id', id)
      .neq('status', 'ARCHIVED')
      .select('id'),
  );
  if (rows.length === 0) throw learnNotFound();
  await audit(ctx, 'admin.learn.deleted', { userId: actor.userId, metadata: { learnItem: id } });
}
