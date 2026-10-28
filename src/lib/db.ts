import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { DB_FUNCTIONS, READ_ONLY_DB_FUNCTIONS, type DbArgs, type DbFunction, type DbResult } from './dbFunctions';
import { supabaseAdmin } from './supabase';

// The only way into the database is supabase-js with the service-role key. The private "app"
// schema (accounts, sessions, OTP codes, profiles, files, KYC, ratings, representations, audit
// log, rate limits) is not exposed by the Supabase API: it is reached through the public.app_*
// database functions, which only the service role may call. Their arguments and results are
// declared in ./dbFunctions.ts and checked on every call.

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

/** The database could not be reached (network failure). Answered as 503 so the app can retry. */
export class DatabaseUnavailableError extends AppError {
  constructor(fn: DbFunction, detail: string) {
    super(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Please try again.');
    this.cause = `${fn}: ${detail}`;
  }
}

// supabase-js reports a failed connection (DNS, reset, timeout) with an empty SQLSTATE.
const isNetworkFailure = (error: { code: string; message: string }) =>
  error.code === '' && /fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(error.message);

const READ_ATTEMPTS = 3;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How a function call reaches the database. The database tests swap this for PGlite. */
export const dbTransport = {
  async rpc(fn: DbFunction, args: Record<string, unknown>): Promise<unknown> {
    // Reads are retried after a network failure; a write is never sent twice, since the failed
    // attempt may already have been applied.
    const attempts = READ_ONLY_DB_FUNCTIONS.has(fn) ? READ_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt++) {
      // The app_* functions are typed by DB_FUNCTIONS, not by the generated public schema types.
      const { data, error } = await supabaseAdmin.rpc(fn as never, args as never);
      if (!error) return data;
      if (!isNetworkFailure(error)) throw new DatabaseError(error.code, error.message);
      if (attempt >= attempts) throw new DatabaseUnavailableError(fn, error.message);
      await pause(150 * attempt);
    }
  },
};

/**
 * Calls one app_* database function (one transaction). The arguments are checked against its
 * declared shape before the call, and the result after it, so a mismatch never reaches a response.
 */
export async function callDb<F extends DbFunction>(fn: F, args: DbArgs<F>): Promise<DbResult<F>> {
  const spec = DB_FUNCTIONS[fn];
  const input = spec.args.safeParse(args);
  if (!input.success) {
    throw new Error(`Invalid arguments for ${fn}: ${z.prettifyError(input.error)}`);
  }
  const output = spec.result.safeParse(await dbTransport.rpc(fn, input.data));
  if (!output.success) {
    throw new Error(`Unexpected result from ${fn}: ${z.prettifyError(output.error)}`);
  }
  return output.data as DbResult<F>;
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof DatabaseError && err.code === '23505';
}

/** A unique violation of the named constraint or unique index. */
export function isUniqueViolationOf(err: unknown, name: string): boolean {
  return isUniqueViolation(err) && (err as DatabaseError).constraint === name;
}
