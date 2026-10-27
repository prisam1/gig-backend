import { supabaseAdmin } from './supabase';

// The only way into the database is supabase-js with the service-role key. The private "app"
// schema (accounts, sessions, OTP codes, profiles, files, KYC, audit log, rate limits) is not
// exposed by the Supabase API: it is reached through the public.app_* database functions in
// supabase/migrations/20261027160000_app_functions.sql, which only the service role may call.

export class DatabaseError extends Error {
  constructor(
    /** Postgres SQLSTATE, e.g. 23505 for a unique violation. */
    public readonly code: string,
    message: string,
  ) {
    super(`Database error: ${message}`);
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
