#!/usr/bin/env node
/**
 * Kick the Knowledge Base re-embedding job by hand.
 *
 * This used to embed every chunk itself, against Gemini. It no longer does any
 * embedding: the work lives in the `kb-reindex-embeddings` Inngest function
 * (apps/web/inngest/functions/reindex-embeddings.ts), which batches, retries,
 * reports progress and resumes where it stopped. A second implementation here
 * would be a second set of batching and rate-limit rules to keep in step with
 * Voyage, and it would drift.
 *
 * You rarely need this. The job runs on a cron and drains anything with
 * `kb_chunks.embedding is null` on its own — after migration 0057, and after a
 * VOYAGE_API_KEY is added to a deployment that has been storing chunks
 * unvectorised. Use this when you do not want to wait for the next tick.
 *
 * Usage:
 *   node scripts/reembed-kb.mjs                 # production (inn.gs)
 *   node scripts/reembed-kb.mjs --dev           # local Inngest dev server
 *   node scripts/reembed-kb.mjs --url http://…  # any other Inngest host
 *
 * Required env: INNGEST_EVENT_KEY (any non-empty value works against the dev
 * server, which does not authenticate).
 */

const args = process.argv.slice(2);
const DEV = args.includes('--dev');
const urlFlag = args.indexOf('--url');
const BASE = urlFlag !== -1 ? args[urlFlag + 1] : DEV ? 'http://localhost:8288' : 'https://inn.gs';

const eventKey = process.env.INNGEST_EVENT_KEY || (DEV ? 'dev' : '');
if (!eventKey) {
  console.error('Missing INNGEST_EVENT_KEY. Set it, or pass --dev for the local dev server.');
  process.exit(1);
}

const res = await fetch(`${BASE.replace(/\/+$/, '')}/e/${encodeURIComponent(eventKey)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'kb/embeddings.reindex',
    data: { triggeredBy: 'scripts/reembed-kb.mjs' },
  }),
});

if (!res.ok) {
  console.error(`Inngest rejected the event (${res.status}): ${await res.text()}`);
  process.exit(1);
}

console.log(
  'Queued kb/embeddings.reindex. Watch it in the Inngest dashboard — the run reports how many chunks it embedded and how many are left.',
);
