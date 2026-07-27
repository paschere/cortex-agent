#!/usr/bin/env node
/**
 * Why is the Google Chat app being turned away?
 *
 * Chat tells the person only "Zippy isn't responding" and tells the developer
 * only "the response was invalid", so the reason lives in `security_events`,
 * written by apps/web/app/api/chat-app/google/route.ts on every rejection.
 * This prints the recent ones together with the audience Google actually sent —
 * the one value GOOGLE_CHAT_AUDIENCE has to contain.
 *
 *   node scripts/chat-rejections.mjs [postgres://...]
 */
// This script lives outside any workspace package, so bare ESM imports don't
// resolve — pull `pg` from the web app's dependencies (same trick as
// scripts/seed-global-routines.mjs).
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { Client } = require('pg');

const rawUrl = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.env.SUPABASE_DB_URL;
if (!rawUrl) {
  console.error('Missing connection string. Pass it as an argument or set SUPABASE_DB_URL.');
  process.exit(1);
}

// pg-connection-string maps sslmode=require to verify-full and its parsed ssl
// config wins over the explicit `ssl` option — strip it and pass ssl ourselves.
const url = new URL(rawUrl);
url.searchParams.delete('sslmode');

const client = new Client({
  connectionString: url.toString(),
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const { rows } = await client.query(
  `select created_at, reason, signals
     from public.security_events
    where tool_id = 'chat.inbound'
    order by created_at desc
    limit 10`,
);
await client.end();

if (rows.length === 0) {
  console.log('No Chat rejections recorded yet — send Zippy a message in Google Chat first.');
  process.exit(0);
}

for (const row of rows) {
  console.log(`\n${row.created_at.toISOString()}`);
  console.log(`  reason:  ${row.reason}`);
  console.log(`  signals: ${JSON.stringify(row.signals)}`);
}
