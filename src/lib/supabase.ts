import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { env } from '../config/env';
import type { Database } from '../types/database';

// Server-side admin client: bypasses Row Level Security. Never expose this key to the app.
export const supabaseAdmin = createClient<Database>(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { autoRefreshToken: false, persistSession: false },
  },
);

// Per-request client that acts as the signed-in user, so RLS policies apply.
export function supabaseForUser(accessToken: string) {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

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
