// Database errors as postgres.js raises them, for the HTTP tests.

import postgres from 'postgres';

/** A unique violation of the named constraint or unique index (SQLSTATE 23505). */
export function uniqueViolation(constraint: string): postgres.PostgresError {
  return Object.assign(Object.create(postgres.PostgresError.prototype) as postgres.PostgresError, {
    name: 'PostgresError' as const,
    code: '23505',
    constraint_name: constraint,
    message: `duplicate key value violates unique constraint "${constraint}"`,
  });
}

/** The value as it appears in a JSON response (dates become ISO strings). */
export function asJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}
