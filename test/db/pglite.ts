// An in-memory Postgres (PGlite) with every migration and the seed applied, plus minimal
// stand-ins for what Supabase provides (roles, auth and storage schemas). `callFunction` runs the
// API's app_* database functions against it, the way callDb does through supabase-js.

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
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

const argTypes = new Map<string, Map<string, string>>();

/** Argument name -> SQL type of public.<fn>, read from the catalog once per function. */
async function argumentTypes(db: PGlite, fn: string): Promise<Map<string, string>> {
  let types = argTypes.get(fn);
  if (!types) {
    const { rows } = await db.query<{ name: string; type: string }>(
      `select unnest(p.proargnames) as name, format_type(unnest(p.proargtypes::oid[]), null) as type
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1`,
      [fn],
    );
    types = new Map(rows.map((r) => [r.name, r.type]));
    argTypes.set(fn, types);
  }
  return types;
}

/** A JS value as a text parameter for `type` (PostgREST sends JSON; this mirrors its casts). */
function toParam(value: unknown, type: string): string | null {
  if (value === null || value === undefined) return null;
  if (type === 'jsonb' || type === 'json') return JSON.stringify(value);
  if (type.endsWith('[]')) {
    const items = (value as unknown[]).map((v) => `"${String(v).replace(/["\\]/g, '\\$&')}"`);
    return `{${items.join(',')}}`;
  }
  return String(value);
}

/**
 * What `callDb` does through supabase-js, run directly in PGlite: `select public.<fn>(named args)`.
 * Database errors are rethrown as the API's DatabaseError, as PostgREST reports them.
 */
export async function callFunction(
  db: PGlite,
  fn: string,
  args: Record<string, unknown>,
  toError: (code: string, message: string) => Error,
): Promise<unknown> {
  const types = await argumentTypes(db, fn);
  const names = Object.keys(args);
  for (const name of names) {
    if (!types.has(name)) throw new Error(`public.${fn} has no argument ${name}`);
  }
  const call = names.map((name, i) => `${name} => $${i + 1}::${types.get(name)}`).join(', ');
  try {
    const { rows } = await db.query<{ r: unknown }>(
      `select public.${fn}(${call}) as r`,
      names.map((name) => toParam(args[name], types.get(name)!)),
    );
    return rows[0]?.r ?? null;
  } catch (error) {
    const e = error as { code?: string; message: string };
    throw toError(e.code ?? '', e.message);
  }
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
