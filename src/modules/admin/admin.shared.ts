import { randomUUID } from 'node:crypto';
import type { PageMeta } from '../../lib/http';
import { DatabaseError as SupabaseError, PG_UNIQUE_VIOLATION } from '../../lib/supabase';
import { AppError, HttpError } from '../../middleware/errorHandler';

/** `?page=&pageSize=` as the app_admin_* functions take it. */
export function limitOffset({ page, pageSize }: { page: number; pageSize: number }) {
  return { p_limit: pageSize, p_offset: (page - 1) * pageSize };
}

export function pageMeta(query: { page: number; pageSize: number }, total: number): PageMeta {
  return { page: query.page, pageSize: query.pageSize, total };
}

type Compact<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** Drops keys whose value is undefined, so a partial update only sets the fields it was given. */
export function compact<T extends Record<string, unknown>>(row: T): Compact<T> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== undefined),
  ) as Compact<T>;
}

/** "Astra Mutuals (India)" -> "astra-mutuals-india". Matches the slug CHECK constraints. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return slug || randomUUID().slice(0, 8);
}

export function notFound(what: string): HttpError {
  return new HttpError(404, `${what} not found`);
}

export function selfAction(): AppError {
  return new AppError(
    409,
    'SELF_ACTION',
    'Staff cannot act on their own account, content or credits',
  );
}

export function slugTaken(): AppError {
  return new AppError(409, 'SLUG_TAKEN', 'This slug is already used', {
    slug: 'Choose a different slug',
  });
}

/** A unique violation reported by supabase-js, optionally of one named constraint. */
export function isSupabaseUniqueViolation(err: unknown, constraint?: string): boolean {
  return (
    err instanceof SupabaseError &&
    err.code === PG_UNIQUE_VIOLATION &&
    (constraint === undefined || err.message.includes(`"${constraint}"`))
  );
}

/** A database result no branch handles: a bug, reported as a 500. */
export function unexpected(fn: string, result: unknown): Error {
  return new Error(`Unexpected result from ${fn}: ${JSON.stringify(result)}`);
}
