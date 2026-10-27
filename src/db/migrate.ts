// Applies supabase/migrations/*.sql in name order, once each, inside a transaction.
// Usage: npm run db:migrate   (reads DATABASE_URL from .env)
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

const dir = path.resolve('supabase/migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { ssl: 'require', max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql`create schema if not exists migrations`;
    await sql`revoke all on schema migrations from public`;
    await sql`
      create table if not exists migrations.applied (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`;
    // Only one migrator at a time.
    await sql`select pg_advisory_lock(hashtext('gig-migrations'))`;

    const applied = new Map(
      (await sql<{ name: string; checksum: string }[]>`select name, checksum from migrations.applied`).map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    for (const name of files) {
      const content = await readFile(path.join(dir, name), 'utf8');
      const checksum = createHash('sha256').update(content).digest('hex');
      const previous = applied.get(name);

      if (previous === checksum) continue;
      if (previous) {
        throw new Error(`${name} was changed after it was applied. Add a new migration instead.`);
      }

      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx.unsafe('insert into migrations.applied (name, checksum) values ($1, $2)', [name, checksum]);
      });
      console.log(`applied ${name}`);
    }
    console.log('migrations up to date');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
