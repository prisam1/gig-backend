import type { PageMeta } from '../../lib/http';
import { fetchPage, supabaseAdmin, unwrap } from '../../lib/supabase';
import { HttpError } from '../../middleware/errorHandler';
import type { Enums } from '../../types/database';
import type { User } from '../users/users.repository';
import type { ListSavedQuery, SavedItemRef } from './saved.schemas';

type SavedType = Enums<'saved_entity_type'>;

/** What the "Saved" list shows for any kind of item. */
export interface SavedEntitySummary {
  name: string;
  /** Asset class (company), instrument (issuer), type of issue (roadshow) or format (learn). */
  subtitle: string | null;
  imageUrl: string | null;
}

export interface SavedItem {
  type: SavedType;
  id: string;
  savedAt: string;
  /** null when the item has since been removed or unpublished. */
  entity: SavedEntitySummary | null;
}

type SummaryLoader = (ids: string[]) => Promise<Map<string, SavedEntitySummary>>;

// Each loader returns only items that are still visible in the app.
const summaryLoaders: Record<SavedType, SummaryLoader> = {
  async COMPANY(ids) {
    const rows = unwrap(
      await supabaseAdmin
        .from('companies')
        .select('id, name, asset_class, logo_url')
        .in('id', ids)
        .is('deleted_at', null),
    );
    return new Map(
      rows.map((r) => [r.id, { name: r.name, subtitle: r.asset_class, imageUrl: r.logo_url }]),
    );
  },
  async ISSUER(ids) {
    const rows = unwrap(
      await supabaseAdmin
        .from('issuers')
        .select('id, name, instrument')
        .in('id', ids)
        .is('deleted_at', null),
    );
    return new Map(
      rows.map((r) => [r.id, { name: r.name, subtitle: r.instrument, imageUrl: null }]),
    );
  },
  async ROADSHOW(ids) {
    const rows = unwrap(
      await supabaseAdmin
        .from('roadshows')
        .select('id, title, type_of_issue')
        .in('id', ids)
        .eq('status', 'PUBLISHED'),
    );
    return new Map(
      rows.map((r) => [r.id, { name: r.title, subtitle: r.type_of_issue, imageUrl: null }]),
    );
  },
  async LEARN_ITEM(ids) {
    const rows = unwrap(
      await supabaseAdmin
        .from('learn_items')
        .select('id, title, format, thumbnail_url')
        .in('id', ids)
        .eq('status', 'PUBLISHED'),
    );
    return new Map(
      rows.map((r) => [r.id, { name: r.title, subtitle: r.format, imageUrl: r.thumbnail_url }]),
    );
  },
};

/** Summaries for a page of saved rows, loading each type once. */
async function summariesFor(
  rows: { entity_type: SavedType; entity_id: string }[],
): Promise<Map<string, SavedEntitySummary>> {
  const idsByType = new Map<SavedType, string[]>();
  for (const row of rows) {
    idsByType.set(row.entity_type, [...(idsByType.get(row.entity_type) ?? []), row.entity_id]);
  }

  const summaries = new Map<string, SavedEntitySummary>();
  await Promise.all(
    [...idsByType].map(async ([type, ids]) => {
      for (const [id, summary] of await summaryLoaders[type](ids)) {
        summaries.set(`${type}:${id}`, summary);
      }
    }),
  );
  return summaries;
}

export async function listSaved(
  user: User,
  query: ListSavedQuery,
): Promise<{ items: SavedItem[]; meta: PageMeta }> {
  const build = (head: boolean) => {
    const q = supabaseAdmin
      .from('saved_items')
      .select('entity_type, entity_id, created_at', { count: 'exact', head })
      .eq('user_id', user.publicId);
    return query.type?.length ? q.in('entity_type', query.type) : q;
  };

  const { rows, meta } = await fetchPage(query, {
    rows: (from, to) =>
      build(false).order('created_at', { ascending: false }).order('entity_id').range(from, to),
    count: () => build(true),
  });

  const summaries = await summariesFor(rows);
  return {
    items: rows.map((row) => ({
      type: row.entity_type,
      id: row.entity_id,
      savedAt: row.created_at,
      entity: summaries.get(`${row.entity_type}:${row.entity_id}`) ?? null,
    })),
    meta,
  };
}

/** Saves an item; saving it again keeps the original save time. */
export async function saveItem(user: User, ref: SavedItemRef): Promise<SavedItem> {
  const entity = (await summaryLoaders[ref.type]([ref.id])).get(ref.id);
  if (!entity) throw new HttpError(404, 'Item not found');

  unwrap(
    await supabaseAdmin
      .from('saved_items')
      .upsert(
        { user_id: user.publicId, entity_type: ref.type, entity_id: ref.id },
        { onConflict: 'user_id,entity_type,entity_id', ignoreDuplicates: true },
      ),
  );
  const saved = unwrap(
    await supabaseAdmin
      .from('saved_items')
      .select('created_at')
      .eq('user_id', user.publicId)
      .eq('entity_type', ref.type)
      .eq('entity_id', ref.id)
      .single(),
  );
  return { type: ref.type, id: ref.id, savedAt: saved.created_at, entity };
}

/** Removes a saved item. Removing one that is not saved is not an error. */
export async function removeSavedItem(user: User, ref: SavedItemRef): Promise<void> {
  unwrap(
    await supabaseAdmin
      .from('saved_items')
      .delete()
      .eq('user_id', user.publicId)
      .eq('entity_type', ref.type)
      .eq('entity_id', ref.id),
  );
}
