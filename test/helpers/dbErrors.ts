// Database errors as callDb raises them (supabase-js reports the SQLSTATE and Postgres's message),
// for the HTTP tests.

import { DatabaseError } from '../../src/lib/db';

/** A unique violation of the named constraint or unique index (SQLSTATE 23505). */
export function uniqueViolation(constraint: string): DatabaseError {
  return new DatabaseError('23505', `duplicate key value violates unique constraint "${constraint}"`);
}

/** The value as it appears in a JSON response (dates become ISO strings). */
export function asJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}
