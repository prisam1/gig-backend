import postgres from 'postgres';
import { env } from '../config/env';

// Direct Postgres connection (Supabase session pooler). All app tables live in the private
// "app" schema, which the Supabase Data API and the publishable key cannot reach.
export const sql = postgres(env.DATABASE_URL, {
  ssl: 'require',
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  // Works with both the session and the transaction pooler.
  prepare: false,
  transform: postgres.camel,
  onnotice: () => {},
});

export type Db = postgres.Sql;

// postgres.js types the transaction handle without call signatures; it is callable at runtime.
export function transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return sql.begin((tx) => fn(tx as unknown as Db)) as Promise<T>;
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof postgres.PostgresError && err.code === '23505';
}

/** A unique violation of the named constraint or unique index. */
export function isUniqueViolationOf(err: unknown, name: string): boolean {
  return isUniqueViolation(err) && (err as postgres.PostgresError).constraint_name === name;
}
