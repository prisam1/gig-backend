import {
  createClient,
  type PostgrestError,
  type PostgrestSingleResponse,
} from '@supabase/supabase-js';
import { env } from '../config/env';
import type { Database } from '../types/database';
import { pageRange, type PageMeta } from './http';

// Server-side admin client for the catalog and reviews tables (public schema) and Supabase Storage.
// Bypasses Row Level Security; never expose this key. The auth module's tables in the private
// "app" schema go through src/lib/db.ts instead.
export const supabaseAdmin = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Postgres error codes the services react to. */
export const PG_UNIQUE_VIOLATION = '23505';

export class DatabaseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`Database error: ${message}`);
  }
}

/**
 * Returns query data, or throws a DatabaseError that keeps the Postgres error code.
 * The data type is inferred from the typed client, so callers need no annotations.
 */
export function unwrap<T>(result: PostgrestSingleResponse<T>): T {
  if (result.error) throw new DatabaseError(result.error.code, result.error.message);
  return result.data;
}

/** An `ilike` pattern matching `text` anywhere, with LIKE wildcards in `text` taken literally. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

/** PostgREST's answer when a page starts past the last row. */
const RANGE_NOT_SATISFIABLE = 'PGRST103';

interface ListResponse<T> {
  data: T[] | null;
  count: number | null;
  error: PostgrestError | null;
}

interface CountResponse {
  count: number | null;
  error: PostgrestError | null;
}

/**
 * Runs a paged list query. `rows` gets the inclusive range to read (and must request
 * `count: 'exact'`); `count` is the same filter as a head-only query, used when the page is past
 * the end so the total is still reported.
 */
export async function fetchPage<T>(
  page: { page: number; pageSize: number },
  query: {
    rows: (from: number, to: number) => PromiseLike<ListResponse<T>>;
    count: () => PromiseLike<CountResponse>;
  },
): Promise<{ rows: T[]; meta: PageMeta }> {
  const { from, to } = pageRange(page);
  const meta = { page: page.page, pageSize: page.pageSize };
  const { data, count, error } = await query.rows(from, to);

  if (error?.code === RANGE_NOT_SATISFIABLE) {
    const head = await query.count();
    if (head.error) throw new DatabaseError(head.error.code, head.error.message);
    return { rows: [], meta: { ...meta, total: head.count ?? 0 } };
  }
  if (error) throw new DatabaseError(error.code, error.message);
  return { rows: data ?? [], meta: { ...meta, total: count ?? 0 } };
}
