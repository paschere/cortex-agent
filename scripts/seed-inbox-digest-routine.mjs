#!/usr/bin/env node
/**
 * Seed the ONE global routine that delivers daily inbox digests.
 *
 * Unlike the reporting routines in seed-global-routines.mjs, this is not a
 * playbook a human would run by hand — it is a dispatcher. It wakes every 30
 * minutes, asks who has asked for a digest at about this local time, and hands
 * each of them to `inbox.deliver_digest`, which builds that person's digest
 * from their own mailbox and delivers it to them.
 *
 * Consequences of that shape, all deliberate:
 *   - cron is every half hour in UTC, because the delivery time is per person
 *     and expressed in that person's own zone;
 *   - allow_unattended_writes = true, because delivering IS a write and there
 *     is no human at 07:30 to approve it. The authorization is the opt-in each
 *     person made themselves in Settings — no opt-in, no delivery;
 *   - notify_email / notify_conversation = false, because the routine already
 *     delivered to the people who matter. Nobody needs a copy of "6 digests
 *     went out", least of all by mail.
 *
 * The agent never sees anyone's mail: `inbox.deliver_digest` returns counts and
 * destinations only, and the instruction below forbids opening a mailbox by any
 * other route.
 *
 * Usage:
 *   node scripts/seed-inbox-digest-routine.mjs [--dry-run] [postgres://...]
 *
 * Connection string: first non-flag argument, else $SUPABASE_DB_URL.
 *
 * Idempotent: the scheduled job is matched by name, so re-running updates the
 * existing row in place and never duplicates. Safe to run on every deploy.
 */
// This script lives outside any workspace package, so bare ESM imports don't
// resolve — pull `pg` from the web app's dependencies (same trick as
// scripts/seed-global-routines.mjs).
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { Client } = require('pg');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const rawUrl = args.find((a) => !a.startsWith('--')) ?? process.env.SUPABASE_DB_URL;

if (!rawUrl) {
  console.error(
    'Missing connection string. Pass it as an argument or set SUPABASE_DB_URL.\n' +
      '  node scripts/seed-inbox-digest-routine.mjs [--dry-run] postgres://...',
  );
  process.exit(1);
}

// pg-connection-string treats sslmode=require as verify-full and its parsed ssl
// config wins over the explicit `ssl` option — so strip sslmode from the URL and
// pass the ssl object ourselves. Supabase's pooler presents a cert signed by
// Supabase's own CA, which Node doesn't trust out of the box. Disabling
// verification is scoped to this one connection (never NODE_TLS_REJECT_UNAUTHORIZED).
// Same pattern as apps/web/lib/auth.ts.
const connectionString = rawUrl
  .replace(/[?&]sslmode=[^&]*/g, (m) => (m.startsWith('?') ? '?' : ''))
  .replace(/\?&/, '?')
  .replace(/\?$/, '');

const JOB_NAME = 'Daily inbox digests';
const CRON = '*/30 * * * *';
// UTC, not Bogotá: the cron is a heartbeat, and each person's real delivery
// time is resolved from their own `user_preferences.timezone`.
const TIMEZONE = 'UTC';

const INSTRUCTION = [
  'Deliver the daily inbox digests that are due right now.',
  '',
  '1. Call inbox.due_digests with windowMinutes = 30. It returns the people whose chosen local delivery time falls inside this half-hour window, and it has already excluded anyone who never turned the digest on and anyone who received one earlier today.',
  '2. If the list is empty, stop. Report "No digests were due this half hour." and nothing else.',
  '3. Otherwise call inbox.deliver_digest once per person, passing that person\'s userId and nothing else. Continue through the whole list even if one of them fails.',
  '4. Report, in one line each: who received a digest and through which channel, and who was skipped or failed and why.',
  '',
  'Rules:',
  "- You must never read, open, quote, summarize or repeat the contents of anyone's mailbox. Delivering the digest goes straight from Cortex to the mailbox's owner; all you ever see back is a count and a destination. Do not use any other mail tool in this routine.",
  '- Deliver only to the owner of each mailbox. Never send, forward or copy a digest to anyone else, including whoever owns this routine.',
  '- A skip is a normal outcome, not a failure: someone may have turned the digest off, or already have today\'s. Report it plainly and move on.',
  '- The report is for humans: business language, first names, no tool names, no ids, no technical detail. If everything went out cleanly, say so in one line.',
].join('\n');

/** Next firing instant of an every-N-minutes cron, strictly after `from`. */
function nextHalfHour(from = new Date()) {
  const next = new Date(from.getTime());
  next.setUTCSeconds(0, 0);
  const minutes = next.getUTCMinutes();
  // Advance to the next :00 or :30 boundary strictly in the future.
  next.setUTCMinutes(minutes < 30 ? 30 : 60);
  return next;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  // Owner: every tool call must stay attributable to a real account, even
  // though this routine acts on other people's behalf.
  const ownerRes = await client.query(
    `select id, email, role from public.users
      order by (role = 'org_admin') desc, created_at asc
      limit 1`,
  );
  if (ownerRes.rows.length === 0) throw new Error('No users found — cannot own the routine.');
  const owner = ownerRes.rows[0];

  const agentRes = await client.query(
    `select id, name from public.agents where slug = 'cortex' limit 1`,
  );
  if (agentRes.rows.length === 0) throw new Error("No agent with slug 'cortex' — cannot schedule.");
  const agent = agentRes.rows[0];

  const nextRun = nextHalfHour();

  // Informational: how many people have actually opted in so far.
  let optedIn = 0;
  try {
    const prefRes = await client.query(
      `select count(*)::int as n from public.user_preferences where inbox_digest_enabled = true`,
    );
    optedIn = prefRes.rows[0]?.n ?? 0;
  } catch {
    optedIn = -1; // table missing — migration 0043 has not been applied here
  }

  console.log(`Owner   : ${owner.email} (${owner.role})`);
  console.log(`Agent   : ${agent.name}`);
  console.log(`Cron    : ${CRON} (${TIMEZONE})`);
  console.log(`Next run: ${nextRun.toISOString()}`);
  console.log(
    `Opted in: ${optedIn < 0 ? 'unknown — public.user_preferences is missing (apply migration 0043)' : `${optedIn} user(s)`}`,
  );
  console.log(`Mode    : ${DRY_RUN ? 'DRY RUN — no writes' : 'WRITING'}\n`);

  if (DRY_RUN) {
    console.log(`── ✉️  ${JOB_NAME}`);
    console.log('   kind=agent  is_global=true  allow_unattended_writes=true');
    console.log('   notify_email=false  notify_conversation=false  recipients=[]');
    console.log('   instruction:');
    console.log(
      INSTRUCTION.split('\n')
        .map((l) => `     ${l}`)
        .join('\n'),
    );
    console.log('\nNothing was written (dry run).');
  } else {
    // No unique constraint on name, so match by name explicitly.
    const existing = await client.query(
      `select id from public.scheduled_jobs where name = $1 limit 1`,
      [JOB_NAME],
    );

    let action;
    if (existing.rows.length > 0) {
      await client.query(
        `update public.scheduled_jobs set
           user_id = $2, agent_id = $3, kind = 'agent', tool_id = null, tool_input = null,
           instruction = $4, schedule_kind = 'cron', cron = $5, timezone = $6,
           run_at = null, next_run_at = $7, status = 'active',
           allow_unattended_writes = true, notify_conversation = false, notify_email = false,
           is_global = true, recipients = '{}'::text[], updated_at = now()
         where id = $1`,
        [existing.rows[0].id, owner.id, agent.id, INSTRUCTION, CRON, TIMEZONE, nextRun.toISOString()],
      );
      action = 'updated';
    } else {
      await client.query(
        `insert into public.scheduled_jobs
           (user_id, agent_id, name, kind, instruction, schedule_kind, cron, timezone,
            next_run_at, status, allow_unattended_writes, notify_conversation, notify_email,
            is_global, recipients)
         values ($1, $2, $3, 'agent', $4, 'cron', $5, $6, $7, 'active', true, false, false, true, '{}'::text[])`,
        [owner.id, agent.id, JOB_NAME, INSTRUCTION, CRON, TIMEZONE, nextRun.toISOString()],
      );
      action = 'created';
    }

    console.log(`✉️  "${JOB_NAME}" ${action}.`);
    console.log(`   Next run ${nextRun.toISOString()} — then every 30 minutes.`);
    if (optedIn === 0) {
      console.log(
        '   Nobody has turned the digest on yet, so every run will be a no-op until someone does (Settings → Daily inbox digest).',
      );
    }
  }
} finally {
  await client.end();
}
