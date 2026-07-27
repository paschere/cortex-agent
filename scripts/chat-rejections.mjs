#!/usr/bin/env node
/**
 * Why is the Google Chat app being turned away?
 *
 * Chat tells the person only "Zippy isn't responding" and tells the developer
 * only "the response was invalid", so the reason lives in `security_events`,
 * written by apps/web/app/api/chat-app/google/route.ts on every rejection.
 * This prints the recent ones with the audience Google actually sent, which is
 * the value GOOGLE_CHAT_AUDIENCE has to contain.
 *
 *   node scripts/chat-rejections.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: new URL('../apps/web/.env.local', import.meta.url).pathname.slice(1) });
config({ path: new URL('../.env', import.meta.url).pathname.slice(1) });

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await db
  .from('security_events')
  .select('created_at, reason, signals')
  .eq('tool_id', 'chat.inbound')
  .order('created_at', { ascending: false })
  .limit(10);

if (error) {
  console.error('query failed:', error.message);
  process.exit(1);
}
if (!data?.length) {
  console.log('No Chat rejections recorded yet — send Zippy a message in Google Chat first.');
  process.exit(0);
}

for (const row of data) {
  console.log(`\n${row.created_at}\n  reason: ${row.reason}`);
  console.log(`  signals: ${JSON.stringify(row.signals)}`);
}
