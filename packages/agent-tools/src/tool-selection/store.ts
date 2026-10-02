/**
 * Where tool vectors live.
 *
 * TWO LAYERS, ON PURPOSE.
 *
 *   Postgres (`tool_embeddings`, migration 0065) is the durable copy. It has to
 *   be shared: the vector for `vehicles.lookup_plate` is identical for every
 *   user and every instance, and embedding it once per lambda cold start would
 *   turn a 40ms fixed cost into a per-instance tax paid forever. It also
 *   survives the deploy, which is what makes the steady state cost nothing.
 *
 *   An in-process Map is the hot copy. A warm instance does ZERO database work
 *   for selection; the only network call left on the turn is the query
 *   embedding. A cold instance pays exactly one SELECT, issued in parallel with
 *   that embedding, so it adds no wall-clock latency of its own.
 *
 * WHAT MAKES A VECTOR STALE. The embedded text is hashed and stored next to the
 * vector. Descriptions are edited constantly — they are prompt engineering, and
 * they ship with the code — so "did the text change" is the only reliable
 * trigger for re-embedding. Nothing here is versioned by deploy id: two
 * instances on different releases can share the table safely because they
 * disagree only about rows whose text differs, and the hash says so.
 *
 * WHAT HAPPENS TO A TOOL WITH NO ROW. It is treated as unrankable and therefore
 * always sent (see rank.ts), and a background embed fills the row in. That is
 * the mechanism by which a family deployed at 4pm and an MCP server connected
 * at 4:05 both become reachable without anyone editing a list.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { embedDocuments, embedInBatches, embeddingModelId } from '../kb/embedder';
import { type SelectableTool, toolEmbedText, toolFamily } from './rank';

export const TOOL_EMBEDDINGS_TABLE = 'tool_embeddings';

/**
 * How long an instance trusts "I already looked and there was no row". Long
 * enough that the steady state is free, short enough that an instance which
 * lost the race to embed a new server picks up the winner's row within one
 * coffee break instead of re-embedding it on every turn.
 */
const NEGATIVE_TTL_MS = 10 * 60_000;

/** Guards against a burst of concurrent turns all embedding the same new family. */
const MAX_BACKFILL_PER_CALL = 64;

interface CacheEntry {
  hash: string;
  vector: number[];
}

const CACHE = new Map<string, CacheEntry>();
/** Keys this process has queried for, with the moment it last did so. */
const LOOKED_UP = new Map<string, number>();
/** Keys with an embed request already in flight, so N turns fire one call. */
const IN_FLIGHT = new Set<string>();

/** Test seam. Never called from production paths. */
export function resetToolVectorCache(): void {
  CACHE.clear();
  LOOKED_UP.clear();
  IN_FLIGHT.clear();
}

/**
 * SHA-256 over the embedded text, truncated. Web Crypto rather than
 * `node:crypto` because this module is imported by routes that also run on the
 * edge/Worker runtime, where `node:crypto` is not there. Reached through a
 * structural cast because the three runtimes declare the global in three
 * different type packages.
 */
interface Digester {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

function subtle(): Digester | undefined {
  return (globalThis as unknown as { crypto?: { subtle?: Digester } }).crypto?.subtle;
}

/**
 * The staleness marker for one tool's vector: its text AND the model that
 * embedded it.
 *
 * WHY THE MODEL IS IN HERE. `tool_embeddings` holds vectors that are scored
 * against an `embedQuery` result on every turn, so it has exactly the mixing
 * problem `kb_chunks` has — a voyage-4-lite query vector compared against a
 * voyage-3-large tool vector does not error, it returns a plausible number and
 * ranks on it. Unlike `kb_chunks` this table has no model column to filter on,
 * and it does not need one: the marker here is already "what we embedded
 * changed", and the model is part of what was embedded. Folding it in makes a
 * provider switch look exactly like an edit to every description — a state this
 * module has always handled.
 *
 * WHAT IT COSTS WHEN THE MODEL CHANGES. Every row goes stale at once, so the
 * catalogue is re-embedded in the background, 64 tools per call, once. It is
 * NOT a per-turn cost: `backfillToolVectors` writes the new hash straight back
 * to the table and into the process cache, so the following turn is a cache hit
 * and the steady state is the same single `embedQuery` it always was.
 *
 * WHAT IT COSTS MEANWHILE. Nothing that can hurt. An unrankable tool is
 * INCLUDED, never dropped (see `rankTools`), so during the re-index every
 * family travels — the pre-selection behaviour, which this module's header
 * calls the worst outcome it is allowed to produce. Ranking across two
 * incomparable vector spaces, which is what leaving the model out would do,
 * is not on that list at all: it would silently drop the right family on every
 * turn, forever, and look exactly like working software.
 *
 * This is exported so the tests can build a fixture the same way production
 * does, instead of restating the rule and drifting from it.
 */
export function toolVectorHash(text: string): Promise<string> {
  return hashText(`${embeddingModelId()}\n${text}`);
}

export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const web = subtle();
  // A runtime with no Web Crypto still needs change detection, and throwing
  // here would take the turn down with it — the one thing this module promises
  // never to do. FNV-1a is not a cryptographic hash and does not need to be:
  // it compares a few hundred strings we wrote ourselves against their own
  // previous value.
  if (!web) return fnv1a(text);
  try {
    const view = new Uint8Array(await web.digest('SHA-256', bytes));
    let hex = '';
    // First 16 bytes: 128 bits of change detection over a few hundred rows is
    // far more than enough, and the column stays readable in a psql session.
    for (let i = 0; i < 16; i++) hex += (view[i] as number).toString(16).padStart(2, '0');
    return hex;
  } catch {
    return fnv1a(text);
  }
}

function fnv1a(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv${(h >>> 0).toString(16)}`;
}

/**
 * pgvector comes back over PostgREST as the text `[0.1,0.2,…]`, not as JSON.
 * Arrays are accepted too so a future driver change (or a test double) does not
 * silently start scoring every tool at zero.
 */
function parseVector(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw.every((n) => typeof n === 'number') ? (raw as number[]) : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const parts = trimmed.slice(1, -1).split(',');
  const out = new Array<number>(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const value = Number.parseFloat(parts[i] as string);
    if (!Number.isFinite(value)) return null;
    out[i] = value;
  }
  return out;
}

interface ToolRow {
  tool_key: string;
  text_hash: string;
  embedding: unknown;
}

/**
 * Populate the process cache for every key we have not looked up recently.
 * Never throws: a database hiccup here means "nothing is ranked", which
 * degrades to sending the whole catalogue, not to sending nothing.
 */
async function primeCache(db: SupabaseClient, keys: string[]): Promise<void> {
  const now = Date.now();
  const wanted = keys.filter((k) => {
    if (CACHE.has(k)) return false;
    const seenAt = LOOKED_UP.get(k);
    return seenAt === undefined || now - seenAt > NEGATIVE_TTL_MS;
  });
  if (wanted.length === 0) return;

  try {
    const { data, error } = await db
      .from(TOOL_EMBEDDINGS_TABLE)
      .select('tool_key, text_hash, embedding')
      .in('tool_key', wanted);
    if (error) return;
    for (const row of (data ?? []) as ToolRow[]) {
      const vector = parseVector(row.embedding);
      if (vector) CACHE.set(row.tool_key, { hash: row.text_hash, vector });
    }
  } catch {
    // Selection is an optimisation. It is never a precondition for a turn.
  } finally {
    // Recorded even on failure, so a table that is down does not turn into one
    // query per turn per tool.
    for (const k of wanted) LOOKED_UP.set(k, now);
  }
}

export interface PreparedVectors {
  /** Tool id → vector, for every tool whose stored text still matches. */
  vectors: Map<string, number[]>;
  /** Tools that need embedding: never seen, or their description changed. */
  stale: Array<{ tool: SelectableTool; text: string; hash: string }>;
}

/**
 * Resolve what we know about this candidate set. Awaited on the turn, but at
 * most one small SELECT and only when unfamiliar tools appear.
 */
export async function prepareToolVectors(
  db: SupabaseClient,
  tools: readonly SelectableTool[],
): Promise<PreparedVectors> {
  const texts = await Promise.all(
    tools.map(async (tool) => {
      const text = toolEmbedText(tool);
      return { tool, text, hash: await toolVectorHash(text) };
    }),
  );

  await primeCache(
    db,
    texts.map((t) => t.tool.id),
  );

  const vectors = new Map<string, number[]>();
  const stale: PreparedVectors['stale'] = [];
  for (const entry of texts) {
    const cached = CACHE.get(entry.tool.id);
    if (cached && cached.hash === entry.hash) {
      vectors.set(entry.tool.id, cached.vector);
    } else {
      stale.push(entry);
    }
  }
  return { vectors, stale };
}

/**
 * Embed and persist the tools we could not rank. Fire-and-forget by design: the
 * turn it was discovered on already includes them, so nothing waits on this.
 * Never throws — it is called with `void`.
 */
export async function backfillToolVectors(
  db: SupabaseClient,
  stale: PreparedVectors['stale'],
): Promise<void> {
  const batch = stale.filter((s) => !IN_FLIGHT.has(s.tool.id)).slice(0, MAX_BACKFILL_PER_CALL);
  if (batch.length === 0) return;
  for (const s of batch) IN_FLIGHT.add(s.tool.id);

  try {
    const embedded = await embedDocuments(batch.map((s) => s.text));
    if (!embedded.ok) return;

    const rows = batch.map((s, i) => ({
      tool_key: s.tool.id,
      family: toolFamily(s.tool),
      text_hash: s.hash,
      embedding: embedded.data[i] as number[],
      updated_at: new Date().toISOString(),
    }));

    // Cache first: even if the write loses a race or the table is unreachable,
    // this instance stops re-embedding the same text every turn.
    for (const row of rows) {
      CACHE.set(row.tool_key, { hash: row.text_hash, vector: row.embedding });
    }
    await db.from(TOOL_EMBEDDINGS_TABLE).upsert(rows, { onConflict: 'tool_key' });
  } catch {
    // Same contract as the read path: a failure here costs relevance, never a turn.
  } finally {
    for (const s of batch) IN_FLIGHT.delete(s.tool.id);
  }
}

/**
 * Re-index the catalogue AHEAD of the first turn that needs it.
 *
 * WHY THE TURN-TIME BACKFILL ABOVE IS NOT ENOUGH ON ITS OWN. It is correct — a
 * tool with a stale or missing row is sent unconditionally, then embedded in the
 * background — but it has three soft spots that all bite right after a deploy
 * that rewrote descriptions:
 *
 *   · Until some turn happens to carry the changed tool, its family is unranked
 *     and travels on EVERY turn. One family is harmless; a release that touches
 *     five (views, payments, accounting, trackers…) is five families riding
 *     along on "hola", which is the >40-declaration regime selection exists to
 *     avoid.
 *   · The background embed is fire-and-forget inside a serverless request. The
 *     platform is free to freeze the instance once the response is done, and a
 *     frozen promise does not write its row. Nothing says so.
 *   · It is capped at 64 tools per call and per instance, and a model change
 *     makes the whole catalogue (200+) stale at once.
 *
 * This is the same comparison, done from a job instead of from a turn: read the
 * stored hash of every registry tool, embed only the ones whose text changed or
 * that have no row, persist each paid request as it lands. With nothing changed
 * it is one SELECT of two short columns and zero provider calls. It never
 * throws — the result says what happened, including why it stopped.
 *
 * WHAT IT DOES NOT COVER, ON PURPOSE. Tools proxied from a user's own MCP server
 * and a workspace's custom tools are not in the registry; they are per-account
 * and keep being indexed by the turn that first meets them, as before.
 */
export interface ToolVectorSyncResult {
  /** Tools whose stored hash was compared. */
  checked: number;
  /** Of those, how many had no row or a row for different text. */
  stale: number;
  /** Rows written this run. */
  embedded: number;
  /** Ids still stale after this run (capped, for the log). Empty on success. */
  remaining: string[];
  /** Why the run stopped short, or null. */
  failure: string | null;
}

/** PostgREST puts `in.(…)` in the URL; this keeps one request well under any proxy's limit. */
const SYNC_READ_CHUNK = 100;

export async function syncToolVectors(
  db: SupabaseClient,
  tools: readonly SelectableTool[],
): Promise<ToolVectorSyncResult> {
  const result: ToolVectorSyncResult = {
    checked: tools.length,
    stale: 0,
    embedded: 0,
    remaining: [],
    failure: null,
  };
  if (tools.length === 0) return result;

  const entries = await Promise.all(
    tools.map(async (tool) => {
      const text = toolEmbedText(tool);
      return { tool, text, hash: await toolVectorHash(text) };
    }),
  );

  const stored = new Map<string, string>();
  try {
    for (let i = 0; i < entries.length; i += SYNC_READ_CHUNK) {
      const keys = entries.slice(i, i + SYNC_READ_CHUNK).map((e) => e.tool.id);
      const { data, error } = await db
        .from(TOOL_EMBEDDINGS_TABLE)
        .select('tool_key, text_hash')
        .in('tool_key', keys);
      if (error) {
        result.failure = `No se pudo leer ${TOOL_EMBEDDINGS_TABLE}: ${error.message}`;
        return result;
      }
      for (const row of (data ?? []) as Array<{ tool_key: string; text_hash: string }>) {
        stored.set(row.tool_key, row.text_hash);
      }
    }
  } catch (err) {
    result.failure = `No se pudo leer ${TOOL_EMBEDDINGS_TABLE}: ${(err as Error).message}`;
    return result;
  }

  const stale = entries.filter((e) => stored.get(e.tool.id) !== e.hash);
  result.stale = stale.length;
  if (stale.length === 0) return result;

  try {
    const run = await embedInBatches(
      stale.map((s) => s.text),
      async ({ start, vectors }) => {
        const slice = stale.slice(start, start + vectors.length);
        const rows = slice.map((s, i) => ({
          tool_key: s.tool.id,
          family: toolFamily(s.tool),
          text_hash: s.hash,
          embedding: vectors[i] as number[],
          updated_at: new Date().toISOString(),
        }));
        // Awaited before the next paid request, like the KB reindex: a write
        // that fails stops the run instead of buying vectors it cannot keep.
        const { error } = await db.from(TOOL_EMBEDDINGS_TABLE).upsert(rows, {
          onConflict: 'tool_key',
        });
        if (error)
          throw new Error(`No se pudo guardar en ${TOOL_EMBEDDINGS_TABLE}: ${error.message}`);
        for (const row of rows) {
          CACHE.set(row.tool_key, { hash: row.text_hash, vector: row.embedding });
        }
        result.embedded += rows.length;
      },
    );
    if (run.failure) result.failure = run.failure.reason;
  } catch (err) {
    result.failure = (err as Error).message;
  }

  result.remaining = stale
    .slice(result.embedded)
    .map((s) => s.tool.id)
    .slice(0, 20);
  return result;
}
