import type { PageMeta } from '../../lib/http';
import { createSignedDownload, fileNameOf, type SignedDownload } from '../../lib/storage';
import { containsPattern, fetchPage, supabaseAdmin, unwrap } from '../../lib/supabase';
import { HttpError } from '../../middleware/errorHandler';
import type { Enums, Tables } from '../../types/database';
import type { AuthUser } from '../../middleware/auth';
import type { LearnSort, ListLearnQuery } from './learn.schemas';

/** Private Storage bucket holding downloadable reports. */
export const LEARN_REPORTS_BUCKET = 'learn-reports';

export interface LearnCard {
  id: string;
  title: string;
  summary: string | null;
  format: Enums<'learn_format'>;
  category: string | null;
  access: Enums<'content_access'>;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  rating: { average: number; count: number };
  /** Has a report to download (verified Prive and Institutional members only). */
  downloadable: boolean;
  /** PREMIUM content the viewer cannot open: verified Prive and Institutional members only. */
  locked: boolean;
  publishedAt: string | null;
}

export interface LearnDetail extends LearnCard {
  /** Stream or article URL; null when locked. */
  contentUrl: string | null;
  /** 5-minute download URL for Full members; null otherwise or when there is no report. */
  download: (SignedDownload & { fileName: string }) | null;
  /** The signed-in member's own rating, if any. */
  myRating: number | null;
}

export interface LearnRatingResult {
  rating: number;
  average: number;
  count: number;
}

type LearnRow = Tables<'learn_items'>;

function isLocked(row: Pick<LearnRow, 'access'>, user: AuthUser | undefined): boolean {
  return row.access === 'PREMIUM' && !(user && user.hasFullAccess);
}

function toCard(row: LearnRow, user: AuthUser | undefined): LearnCard {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    format: row.format,
    category: row.category,
    access: row.access,
    thumbnailUrl: row.thumbnail_url,
    durationSeconds: row.duration_seconds,
    rating: { average: row.rating_avg, count: row.rating_count },
    downloadable: row.download_path !== null,
    locked: isLocked(row, user),
    publishedAt: row.published_at,
  };
}

const learnOrders: Record<LearnSort, ['published_at' | 'rating_avg', boolean][]> = {
  recent: [['published_at', false]],
  top_rated: [
    ['rating_avg', false],
    ['published_at', false],
  ],
};

export async function listLearn(
  query: ListLearnQuery,
  user: AuthUser | undefined,
): Promise<{ items: LearnCard[]; meta: PageMeta }> {
  const filter = query.filter ?? {};

  const build = (head: boolean) => {
    let q = supabaseAdmin
      .from('learn_items')
      .select('*', { count: 'exact', head })
      .eq('status', 'PUBLISHED');
    if (query.q) q = q.ilike('title', containsPattern(query.q));
    if (filter.format?.length) q = q.in('format', filter.format);
    if (filter.category?.length) q = q.in('category', filter.category);
    if (filter.access?.length) q = q.in('access', filter.access);
    return q;
  };

  const { rows, meta } = await fetchPage(query, {
    rows: (from, to) => {
      let q = build(false);
      for (const [column, ascending] of learnOrders[query.sort]) {
        q = q.order(column, { ascending });
      }
      return q.order('id').range(from, to);
    },
    count: () => build(true),
  });
  return { items: rows.map((row) => toCard(row, user)), meta };
}

async function findPublishedItem(id: string): Promise<LearnRow> {
  const row = unwrap(
    await supabaseAdmin
      .from('learn_items')
      .select('*')
      .eq('id', id)
      .eq('status', 'PUBLISHED')
      .maybeSingle(),
  );
  if (!row) throw new HttpError(404, 'Content not found');
  return row;
}

async function findOwnRating(itemId: string, user: AuthUser): Promise<number | null> {
  const row = unwrap(
    await supabaseAdmin
      .from('learn_ratings')
      .select('rating')
      .eq('learn_item_id', itemId)
      .eq('user_id', user.id)
      .maybeSingle(),
  );
  return row?.rating ?? null;
}

/** Reports are downloadable by Full members only. */
async function reportDownload(
  row: LearnRow,
  user: AuthUser | undefined,
): Promise<LearnDetail['download']> {
  if (row.download_path === null || !user || !user.hasFullAccess) return null;
  const fileName = fileNameOf(row.download_path);
  const signed = await createSignedDownload(LEARN_REPORTS_BUCKET, row.download_path, fileName);
  return { ...signed, fileName };
}

export async function getLearnItem(id: string, user: AuthUser | undefined): Promise<LearnDetail> {
  const row = await findPublishedItem(id);
  const card = toCard(row, user);
  const [download, myRating] = await Promise.all([
    reportDownload(row, user),
    user ? findOwnRating(id, user) : null,
  ]);

  return { ...card, contentUrl: card.locked ? null : row.content_url, download, myRating };
}

/** Rates (or re-rates) content the member can open. */
export async function rateLearnItem(
  id: string,
  user: AuthUser,
  rating: number,
): Promise<LearnRatingResult> {
  const item = await findPublishedItem(id);
  if (isLocked(item, user)) {
    throw new HttpError(403, 'Available to verified Prive and Institutional members', {
      code: 'PREMIUM_CONTENT',
    });
  }

  unwrap(
    await supabaseAdmin
      .from('learn_ratings')
      .upsert(
        { learn_item_id: id, user_id: user.id, rating },
        { onConflict: 'learn_item_id,user_id' },
      ),
  );
  // A trigger has refreshed the item's average and count.
  const stats = unwrap(
    await supabaseAdmin
      .from('learn_items')
      .select('rating_avg, rating_count')
      .eq('id', id)
      .single(),
  );
  return { rating, average: stats.rating_avg, count: stats.rating_count };
}
