import { supabaseAdmin } from './supabase';

// The only way into the database is supabase-js with the service-role key. The private "app"
// schema (accounts, sessions, OTP codes, profiles, files, KYC, ratings, representations, audit
// log, rate limits) is not exposed by the Supabase API: it is reached through the public.app_*
// database functions in supabase/migrations/20261027160000_app_functions.sql and
// 20261027190000_ratings_representations_functions.sql, which only the service role may call.

export class DatabaseError extends Error {
  /** The violated constraint or unique index, when Postgres names one. */
  public readonly constraint: string | undefined;

  constructor(
    /** Postgres SQLSTATE, e.g. 23505 for a unique violation. */
    public readonly code: string,
    message: string,
  ) {
    super(`Database error: ${message}`);
    this.constraint = /constraint "([^"]+)"/.exec(message)?.[1];
  }
}

/** Calls one app_* database function. Each call is a single transaction. */
export async function callDb<T>(fn: `app_${string}`, args: Record<string, unknown> = {}): Promise<T> {
  // The app_* functions are not in the generated public types; their results are typed by the caller.
  const { data, error } = await supabaseAdmin.rpc(fn as never, args as never);
  if (error) throw new DatabaseError(error.code, error.message);
  return data as T;
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof DatabaseError && err.code === '23505';
}

/** A unique violation of the named constraint or unique index. */
export function isUniqueViolationOf(err: unknown, name: string): boolean {
  return isUniqueViolation(err) && (err as DatabaseError).constraint === name;
}
