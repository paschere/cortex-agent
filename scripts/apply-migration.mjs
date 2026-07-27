#!/usr/bin/env node
/**
 * Apply one migration file to a Postgres database.
 *
 * Supabase's CLI cannot be used on this project (a duplicate 0014 breaks it),
 * so migrations are applied by hand. Two rules this encodes rather than leaves
 * to memory:
 *
 *   - DDL needs the SESSION pooler (port 5432). The transaction pooler (6543,
 *     pgbouncer) silently mangles multi-statement DDL, so a 6543 URL is
 *     rewritten rather than accepted.
 *   - pg-connection-string maps `sslmode=require` to verify-full and its parsed
 *     ssl config beats the explicit option, so sslmode is stripped and ssl is
 *     passed directly. Supabase's pooler presents a cert this client does not
 *     have a root for.
 *
 * Each file runs inside a single transaction: a migration that fails half way
 * leaves nothing behind.
 *
 *   node scripts/apply-migration.mjs <file.sql> [postgres://...]
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { Client } = require('pg');

const [file, rawUrlArg] = process.argv.slice(2);
const rawUrl = rawUrlArg ?? process.env.SUPABASE_DB_URL;
if (!file || !rawUrl) {
  console.error('usage: node scripts/apply-migration.mjs <file.sql> [postgres://...]');
  process.exit(1);
}

const url = new URL(rawUrl);
url.searchParams.delete('sslmode');
url.searchParams.delete('pgbouncer');
if (url.port === '6543') {
  url.port = '5432';
  console.log('note: switched to the session pooler (5432) — DDL cannot run through pgbouncer');
}

const sql = readFileSync(file, 'utf8');
const client = new Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

await client.connect();
try {
  await client.query('begin');
  await client.query(sql);
  await client.query('commit');
  console.log(`applied ${file}`);
} catch (err) {
  await client.query('rollback').catch(() => undefined);
  console.error(`FAILED ${file}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
