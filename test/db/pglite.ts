// An in-memory Postgres (PGlite) with every migration and the seed applied, plus minimal
// stand-ins for what Supabase provides (roles, auth.users, storage.buckets).

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

export async function createTestDatabase(): Promise<PGlite> {
  // NUMERIC (oid 1700) as numbers, the way PostgREST returns them to the API.
  const db = new PGlite({
    extensions: { pg_trgm },
    parsers: { 1700: (value: string) => Number(value) },
  });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema extensions; create schema auth; create schema storage;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb);
    create table storage.buckets (id text primary key, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);
  `);
  const dir = join(ROOT, 'supabase', 'migrations');
  for (const file of readdirSync(dir).sort()) {
    await db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  await db.exec(readFileSync(join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
  return db;
}

/** Creates a GIG user and returns its internal id. */
export async function createUser(db: PGlite, publicId: string): Promise<number> {
  await db.query('insert into auth.users (id) values ($1)', [publicId]);
  const { rows } = await db.query<{ id: number }>(
    'insert into public.users (auth_user_id, public_id) values ($1, $1) returning id',
    [publicId],
  );
  const row = rows[0];
  if (!row) throw new Error('user not created');
  return Number(row.id);
}

/** Expects `promise` to fail with the given Postgres error code (and message, if given). */
export async function dbError(
  promise: Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  const error = await promise.then(
    () => null,
    (e: { code?: string; message: string }) => e,
  );
  if (!error) throw new Error('expected a database error');
  return error;
}
