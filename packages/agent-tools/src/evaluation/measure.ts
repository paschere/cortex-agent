/**
 * The one part that costs money: turning the suite into cosines against the
 * live API.
 *
 * IT RUNS BY HAND, AND RARELY. Once per embedding-model change, once when the
 * corpus or the questions move, once when a tool in a graded family is
 * rewritten. Every other run replays what this produced. That asymmetry is the
 * design: measuring is expensive and infrequent, grading is free and constant,
 * and confusing the two is how continuous evaluation ends up being neither.
 *
 * IT USES THE PRODUCTION EMBEDDER, WITH THE PRODUCTION INPUT TYPES. Passages go
 * through `embedDocuments` and questions through `embedQuery`, because that
 * asymmetry is worth 0.03 to 0.08 of cosine — measured, in `kb/relevance.ts` —
 * and a measurement that sent both sides the same way would be describing a
 * retrieval system nobody runs. Tool texts go through `embedDocuments` for the
 * same reason: that is what `backfillToolVectors` does.
 *
 * IT WRITES DOWN WHAT IT SPENT. `usage` carries the tokens the provider says it
 * charged for and what that is in dollars at the price `embedding-providers.ts`
 * has verified. The point is not accounting, it is that "this is cheap" should
 * be a number in a file rather than a belief — the last time nobody checked,
 * one document exhausted the account.
 */

import { writeFileSync } from 'node:fs';
import { approxTokens } from '../kb/chunker';
import { embedDocuments, embedQuery, embeddingConfig, embeddingModelId } from '../kb/embedder';
import { type SelectableTool, toolEmbedText, toolFamily } from '../tool-selection';
import { cosine } from '../tool-selection/rank';
import { hashText } from '../tool-selection/store';
import { corpusChunks } from './corpus';
import { SELECTION_CASES, suiteDigest, suiteQueries } from './suite';
import { type FixtureTool, type VectorFixture, fixturePath } from './vectors';

export interface MeasureOptions {
  /** Everything the ranker could be offered. Usually `listTools()`. */
  tools: readonly SelectableTool[];
  /** Write the fixture to disk. False returns it without touching the repo. */
  write?: boolean;
  /** Progress, so a two-minute measurement does not look hung. */
  log?: (line: string) => void;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The provider's free tier, verified against the live API on 2026-08-07: three
 * requests and ten thousand tokens per minute, until a payment method is added.
 *
 * WHY THIS IS HERE AND NOT IN `embedder.ts`. Production never approaches these
 * limits — it embeds a document on upload and a query per turn — and putting a
 * throttle on the retrieval path to serve a measurement that runs four times a
 * year would be paying for this file on every question anybody asks. So the
 * pacing lives with the thing that needs pacing.
 *
 * IT ALSO RETRIES WHAT THE EMBEDDER WILL NOT. The refusal comes back as a 429
 * whose body says "add a payment method", and `describeFailure` reads the word
 * "payment" and correctly concludes that repeating the request cannot help —
 * which is right for an ingest and wrong here, because waiting out the window
 * DOES help. That classification is not this package's to change, so the wait
 * is implemented on this side.
 */
const FREE_TIER = { requestsPerMinute: 3, tokensPerMinute: 10_000 } as const;
const WINDOW_MS = 60_000;
/**
 * A margin under the token ceiling, because `approxTokens` is an estimate and
 * measured about a third low on this corpus — 21 fragments it called 9 000 the
 * provider charged 9 157 for, and the Spanish contract text is worse than the
 * average. Half the nominal allowance leaves room for that without needing the
 * estimator to be right.
 */
const TOKENS_PER_REQUEST = 3_000;

/** How long to wait out a refusal, and how many times to try again. */
const COOLDOWN_MS = 65_000;
const ATTEMPTS = 5;

class Pacer {
  private readonly seen: Array<{ at: number; tokens: number }> = [];

  constructor(private readonly log: (line: string) => void) {}

  private trim(now: number): void {
    while (this.seen.length > 0 && now - (this.seen[0]?.at ?? 0) > WINDOW_MS) this.seen.shift();
  }

  /** Forget the window, after a refusal has already made us wait one out. */
  reset(): void {
    this.seen.length = 0;
  }

  /** Block until this request fits inside both ceilings, then record it. */
  async take(tokens: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.trim(now);
      const used = this.seen.reduce((sum, s) => sum + s.tokens, 0);
      const fits =
        this.seen.length < FREE_TIER.requestsPerMinute &&
        used + tokens <= FREE_TIER.tokensPerMinute;
      if (fits) {
        this.seen.push({ at: now, tokens });
        return;
      }
      const oldest = this.seen[0]?.at ?? now;
      const wait = Math.max(1_000, WINDOW_MS - (now - oldest) + 500);
      this.log(`Esperando ${Math.round(wait / 1000)} s por el límite del plan gratuito…`);
      await pause(wait);
    }
  }
}

/** Group texts so no request exceeds the per-minute token allowance. */
function batchByTokens(texts: string[]): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let budget = 0;
  for (const [i, text] of texts.entries()) {
    const cost = approxTokens(text);
    if (current.length > 0 && budget + cost > TOKENS_PER_REQUEST) {
      groups.push(current);
      current = [];
      budget = 0;
    }
    current.push(i);
    budget += cost;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Embed everything; store only the numbers something reads.
 *
 * EVERY TOOL IS EMBEDDED, without exception. It is tempting to embed only the
 * families the suite asserts on — it would be faster and cheaper — and it would
 * also guarantee they win, because `rankTools` scores families AGAINST EACH
 * OTHER and a catalogue containing only the expected answers has no wrong
 * answer to lose to. The whole `gmail`-versus-`meetings` finding depends on
 * `meetings` being in the running. So the temptation was considered and
 * refused, and this paragraph is here so it is not reconsidered.
 *
 * WHAT IS NOT STORED is the cross product. Per-tool cosines are kept only for
 * the five selection queries; the twenty-two retrieval questions never reach
 * the ranker in this suite, and keeping 127 × 27 numbers instead of 127 × 5
 * would quintuple a file people are meant to be able to open and read.
 */
export async function measure({
  tools,
  write = false,
  log = () => {},
}: MeasureOptions): Promise<VectorFixture> {
  const cfg = embeddingConfig();
  if ('error' in cfg) throw new Error(cfg.error);
  if (!cfg.keyConfigured) {
    throw new Error(
      `No hay llave de ${cfg.provider.label} (${cfg.apiKeyEnv}) en este entorno, así que no se puede medir nada contra la API real.`,
    );
  }
  const modelId = embeddingModelId();
  const queries = suiteQueries();
  const chunks = corpusChunks();

  log(
    `Midiendo contra ${modelId}: ${chunks.length} fragmentos, ${queries.length} preguntas, ${tools.length} herramientas.`,
  );

  let tokens = 0;
  const pacer = new Pacer(log);

  /**
   * One paced, retried call.
   *
   * THE PACER IS THE OPTIMISM AND THIS IS THE HONESTY. Token estimates are
   * estimates, the provider counts differently, and the free tier's window does
   * not start when we think it does — so the pacer keeps the run mostly out of
   * trouble and this loop deals with the times it was wrong. On a refusal it
   * waits out a whole window and tries again, because the refusal here is a
   * rate limit wearing a billing message, and waiting is exactly what fixes it.
   * Five attempts, and then it gives up loudly: a measurement that silently
   * dropped a batch would produce a fixture with a hole in it, and a hole in a
   * fixture reads as a low cosine, which reads as a retrieval failure.
   */
  const attempt = async <T>(
    what: string,
    call: () => Promise<{ ok: boolean; reason?: string } & T>,
  ): Promise<T> => {
    let last = 'sin intentos';
    for (let i = 0; i < ATTEMPTS; i++) {
      const result = await call();
      if (result.ok) return result;
      last = result.reason ?? 'sin motivo';
      log(
        `${what}: rechazado (${last}). Esperando ${COOLDOWN_MS / 1000} s y reintentando (${i + 1}/${ATTEMPTS}).`,
      );
      await pause(COOLDOWN_MS);
      pacer.reset();
    }
    throw new Error(`No se pudieron embeber ${what} después de ${ATTEMPTS} intentos: ${last}`);
  };

  const embedGroup = async (texts: string[], what: string): Promise<number[][]> => {
    const embedded = await attempt(what, async () => {
      await pacer.take(texts.reduce((sum, t) => sum + approxTokens(t), 0));
      return embedDocuments(texts) as Promise<{
        ok: boolean;
        reason?: string;
        data?: number[][];
        usage?: { tokens: number };
      }>;
    });
    tokens += embedded.usage?.tokens ?? 0;
    return embedded.data ?? [];
  };

  const chunkTexts = chunks.map((c) => c.content);
  const passageVecs: number[][] = [];
  for (const [n, group] of batchByTokens(chunkTexts).entries()) {
    passageVecs.push(
      ...(await embedGroup(
        group.map((i) => chunkTexts[i] as string),
        'los fragmentos',
      )),
    );
    log(`Fragmentos: ${passageVecs.length}/${chunkTexts.length} (grupo ${n + 1}).`);
  }

  // Tool descriptions are paragraphs and there are over a hundred of them, so
  // the whole catalogue is tens of thousands of tokens. `embedInBatches` splits
  // by the provider's per-REQUEST limits, which is a different ceiling and does
  // not help against a per-MINUTE one.
  const toolTexts = tools.map((t) => toolEmbedText(t));
  const toolVecs: number[][] = [];
  for (const group of batchByTokens(toolTexts)) {
    toolVecs.push(
      ...(await embedGroup(
        group.map((i) => toolTexts[i] as string),
        'las herramientas',
      )),
    );
    log(`Herramientas: ${toolVecs.length}/${toolTexts.length}.`);
  }

  // One request per question — `embedQuery` takes a single string, because
  // production embeds one question per turn and this measurement uses the
  // production path or it measures nothing. At three requests a minute that is
  // the slowest stretch of the run by far, and it is still the right trade: a
  // batched shortcut would be a second code path that could disagree with the
  // one that ships.
  const queryVectors: number[][] = [];
  for (const [i, query] of queries.entries()) {
    const embedded = await attempt(`la pregunta «${query}»`, async () => {
      await pacer.take(approxTokens(query));
      return embedQuery(query) as Promise<{
        ok: boolean;
        reason?: string;
        data?: number[];
        usage?: { tokens: number };
      }>;
    });
    tokens += embedded.usage?.tokens ?? 0;
    queryVectors.push(embedded.data ?? []);
    log(`Preguntas: ${i + 1}/${queries.length}.`);
  }

  const selectionQueries = new Set(SELECTION_CASES.map((c) => c.query));

  const queryScores: Record<string, number[]> = {};
  for (const [i, query] of queries.entries()) {
    const qv = queryVectors[i] as number[];
    queryScores[query] = passageVecs.map((pv) => round(cosine(qv, pv)));
  }

  const toolEntries: Record<string, FixtureTool> = {};
  for (const [i, tool] of tools.entries()) {
    const tv = toolVecs[i] as number[];
    const scores: Record<string, number> = {};
    for (const [j, query] of queries.entries()) {
      // Only the selection queries are stored per tool. The retrieval questions
      // never reach the ranker in this suite, and storing 200 tools × 27
      // questions would quadruple the file for numbers nothing reads.
      if (!selectionQueries.has(query)) continue;
      scores[query] = round(cosine(queryVectors[j] as number[], tv));
    }
    toolEntries[tool.id] = {
      textHash: await hashText(toolTexts[i] as string),
      family: toolFamily(tool),
      scores,
    };
  }

  const price = cfg.facts?.pricePerMillionTokensUsd ?? 0;
  const fixture: VectorFixture = {
    modelId,
    measuredOn: new Date().toISOString().slice(0, 10),
    suiteDigest: suiteDigest(),
    usage: { tokens, usd: round((tokens / 1_000_000) * price) },
    chunks: chunks.map((c) => ({
      documentId: c.documentId,
      chunkIndex: c.chunkIndex,
      tokens: c.tokens,
      preview: c.content.slice(0, 90).replaceAll(/\s+/g, ' '),
    })),
    queries: queryScores,
    tools: toolEntries,
  };

  if (write) {
    writeFileSync(fixturePath(modelId), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    log(`Escrito en ${fixturePath(modelId)}.`);
  }
  return fixture;
}
