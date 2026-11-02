// One-off for migration 20261102090000: decrypts the email_enc / phone_enc columns of app.users and
// app.signup_requests into the plain email / phone columns. Needed only on a database that had
// accounts before that migration; 20261102091000 refuses to run until this has been done.
//
//   cd gig-backend
//   node scripts/backfill-contacts.mjs
//
// Reads DATA_ENCRYPTION_KEY from .env (the key the rows were encrypted with) and reaches the linked
// Supabase project through the CLI, like `npm run db:migrate`. Safe to run more than once: it only
// fills rows whose plain values are still empty. Can be deleted once every database has run
// 20261102091000.
import { createDecipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every key the rows may have been encrypted with: the one in .env, plus any in the
// DATA_ENCRYPTION_KEYS environment variable (comma-separated; e.g. the key of the Render service,
// for accounts created through it).
const envText = readFileSync(join(BACKEND, '.env'), 'utf8');
const keyLine = envText.split(/\r?\n/).find((line) => line.startsWith('DATA_ENCRYPTION_KEY='));
const keys = [keyLine?.slice('DATA_ENCRYPTION_KEY='.length), ...(process.env.DATA_ENCRYPTION_KEYS ?? '').split(',')]
  .map((k) => (k ?? '').trim())
  .filter((k) => k.length > 0)
  .map((k) => Buffer.from(k, 'base64'));
if (keys.length === 0) throw new Error('No key: put DATA_ENCRYPTION_KEY in .env or set DATA_ENCRYPTION_KEYS');
for (const key of keys) if (key.length !== 32) throw new Error('A key is not 32 bytes (base64)');

// The API's former decrypt(): AES-256-GCM, v1.<iv>.<tag>.<ciphertext> in base64url, the column
// name bound as additional data. Null when none of the keys fits.
function decrypt(payload, context) {
  const [version, iv, tag, data] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unsupported ciphertext');
  for (const key of keys) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      // Not this key.
    }
  }
  return null;
}

function query(sql) {
  const file = join(tmpdir(), 'gig-backfill-query.sql');
  writeFileSync(file, sql);
  const run = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['supabase', 'db', 'query', '--linked', '--output-format', 'json', '-f', file],
    { cwd: BACKEND, encoding: 'utf8', shell: true },
  );
  // The CLI prints either a bare array of rows or an object with a `rows` array; in both cases
  // the JSON is the whole of stdout from its first bracket.
  const start = run.stdout.search(/[[{]/);
  if (run.status !== 0 || start < 0) throw new Error(`query failed:\n${run.stdout}\n${run.stderr}`);
  const parsed = JSON.parse(run.stdout.slice(start).trim());
  return Array.isArray(parsed) ? parsed : parsed.rows ?? [];
}

const literal = (value) => `'${value.replace(/'/g, "''")}'`;

const updates = [];
let unreadable = 0;
for (const table of ['app.users', 'app.signup_requests']) {
  const rows = query(`select id, email_enc, phone_enc from ${table} where email is null or phone is null`);
  let filled = 0;
  for (const row of rows) {
    const email = decrypt(row.email_enc, 'email');
    const phone = decrypt(row.phone_enc, 'phone');
    if (email === null || phone === null) {
      unreadable += 1;
      console.log(`${table} id ${row.id}: none of the ${keys.length} key(s) decrypts it`);
      continue;
    }
    filled += 1;
    updates.push(`update ${table} set email = ${literal(email)}, phone = ${literal(phone)} where id = ${Number(row.id)};`);
  }
  console.log(`${table}: ${rows.length} row(s) to fill, ${filled} decrypted`);
}

if (updates.length > 0) query(updates.join('\n'));
if (unreadable > 0) {
  console.log(`\n${unreadable} row(s) could not be decrypted. Their accounts were created by a server with a different`);
  console.log('DATA_ENCRYPTION_KEY (e.g. Render: Dashboard -> the service -> Environment). Run again with that key:');
  console.log('  $env:DATA_ENCRYPTION_KEYS = "<that key>"; node scripts/backfill-contacts.mjs');
}

for (const table of ['app.users', 'app.signup_requests']) {
  const [row] = query(`select count(*) as total, count(email) as with_email, count(phone) as with_phone from ${table}`);
  console.log(`${table}: ${row.total} rows, ${row.with_email} with email, ${row.with_phone} with phone`);
}
