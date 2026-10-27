// An in-memory Postgres (PGlite) with every migration and the seed applied, plus minimal
// stand-ins for what Supabase provides (roles, auth and storage schemas). `serve` exposes it on a
// local port, so the API's own postgres.js queries run against it.

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

export async function createTestDatabase(): Promise<PGlite> {
  // NUMERIC (oid 1700) as numbers in direct PGlite queries.
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

/** Serves the database on 127.0.0.1:`port` for postgres.js; call the result to stop. */
export async function serve(db: PGlite, port: number): Promise<() => Promise<void>> {
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  return () => server.stop();
}

/** Creates an auth-module user (app.users) and returns its internal id. */
export async function createUser(db: PGlite, publicId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into app.users (public_id, email_enc, email_hash, phone_country_code, phone_enc,
                            phone_hash, password_hash, email_verified_at, phone_verified_at)
     values ($1::uuid, 'x', $1::text, '+91', 'x', $1::text, 'x', now(), now())
     returning id::text`,
    [publicId],
  );
  const row = rows[0];
  if (!row) throw new Error('user not created');
  return row.id;
}

/** The error `promise` rejects with; fails if it resolves. */
export async function dbError(
  promise: Promise<unknown>,
): Promise<{ code?: string; message: string; constraint_name?: string }> {
  const error = await promise.then(
    () => null,
    (e: { code?: string; message: string; constraint_name?: string }) => e,
  );
  if (!error) throw new Error('expected a database error');
  return error;
}
