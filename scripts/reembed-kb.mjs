#!/usr/bin/env node
/**
 * Re-embed every kb_chunks row with gemini-embedding-001 (768 dims).
 *
 * Why: the KB was originally embedded with Google's text-embedding-004, which
 * was retired from the Gemini API. Query embeddings now come from
 * gemini-embedding-001 (packages/agent-tools/src/kb/embedder.ts), which lives
 * in a different vector space — chunks embedded with the old model are
 * effectively unfindable until re-embedded. Run this ONCE per environment
 * after deploying the embedder change.
 *
 * Usage:
 *   node scripts/reembed-kb.mjs [--dry-run] [--batch 64]
 *
 * Required env (or pass via shell):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_GENERATIVE_AI_API_KEY
 *
 * Idempotent and resumable: processes chunks in stable id order; re-running
 * re-embeds everything (harmless — same model, same output). Rate-limited by
 * batch size; ~100 texts per Gemini request.
 */
// Resolve @supabase/supabase-js from the web app's dependencies (this script
// lives outside any workspace package, so bare ESM imports don't resolve).
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BATCH = Number(args[args.indexOf('--batch') + 1]) || 64;

const ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents';
const DIMENSIONS = 768;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!url || !serviceKey || !geminiKey) {
  console.error(
    'Missing env. Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_GENERATIVE_AI_API_KEY',
  );
  process.exit(1);
}

const db = createClient(url, serviceKey);

function l2Normalize(values) {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  return norm === 0 ? values : values.map((v) => v / norm);
}

async function embedBatch(texts) {
  const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(geminiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: texts.map((t) => ({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: t }] },
        outputDimensionality: DIMENSIONS,
      })),
    }),
  });
  if (!res.ok) throw new Error(`Embed failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.embeddings.map((e) => l2Normalize(e.values));
}

const { count } = await db.from('kb_chunks').select('id', { count: 'exact', head: true });
console.log(`kb_chunks total: ${count ?? 0}${DRY_RUN ? ' (dry run — no writes)' : ''}`);

let processed = 0;
let lastId = '00000000-0000-0000-0000-000000000000';

for (;;) {
  const { data: rows, error } = await db
    .from('kb_chunks')
    .select('id, content')
    .gt('id', lastId)
    .order('id', { ascending: true })
    .limit(BATCH);
  if (error) throw new Error(`Fetch failed: ${error.message}`);
  if (!rows || rows.length === 0) break;

  const embeddings = await embedBatch(rows.map((r) => r.content ?? ''));

  if (!DRY_RUN) {
    for (let i = 0; i < rows.length; i++) {
      const { error: upErr } = await db
        .from('kb_chunks')
        .update({ embedding: JSON.stringify(embeddings[i]) })
        .eq('id', rows[i].id);
      if (upErr) throw new Error(`Update failed for ${rows[i].id}: ${upErr.message}`);
    }
  }

  processed += rows.length;
  lastId = rows[rows.length - 1].id;
  console.log(`  ${processed}/${count ?? '?'} re-embedded`);
}

console.log(`Done. ${processed} chunks ${DRY_RUN ? 'would be' : ''} re-embedded.`);
