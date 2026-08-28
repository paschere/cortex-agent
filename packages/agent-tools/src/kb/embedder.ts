/**
 * Brain Knowledge embeddings. One provider is chosen by configuration; the
 * batching, retrying, normalising and accounting around it are the same
 * whichever one answers.
 *
 * WHAT HAPPENED, AND WHY THIS FILE LOOKS LIKE THIS NOW. The deployment ran
 * `voyage-3-large`: $0.18 per million tokens and, verified against Voyage's live
 * pricing page, absent from both of their free-token lists — the most expensive
 * model in the catalogue and the only tier with no free allowance. A single
 * document exhausted the account, helped along by an Inngest retry bug that
 * re-embedded whole documents up to four times. Two things follow from that, and
 * both are load-bearing here:
 *
 *   1. The default is now `voyage-4-lite` — nine times cheaper, 200 million free
 *      tokens, and 1024 dimensions natively, so the HNSW index never moves. The
 *      model is configuration, not a literal, and `embedding-providers.ts`
 *      carries the verified price and free-token facts for every option so that
 *      "this model has no free tier" is something the product can SAY rather
 *      than something someone discovers when the service stops.
 *   2. Failures are classified. A rate limit and an outage are worth retrying;
 *      a rejected key, a malformed request and an exhausted quota are not.
 *      Retrying against a quota that is gone is spending money with no chance of
 *      winning, and it is exactly what a naive `retries: 3` does.
 *
 * WHY TWO FUNCTIONS INSTEAD OF A FLAG. Most of these providers are trained
 * asymmetrically: a passage indexed as a `document` and a question sent as a
 * `query` are placed in the same space on purpose, and using one type on both
 * sides measurably degrades recall. That is a silent failure — nothing errors,
 * results just get worse — so the choice is not expressible as an argument.
 * `embedDocuments` indexes, `embedQuery` retrieves, and there is no third way to
 * call the API.
 *
 * WHY IT NEVER THROWS. Like the Apollo and BambooHR clients, every failure is
 * returned rather than raised. A missing key, a rotated key and a rate limit are
 * operating conditions of a third party, not bugs in a turn: retrieval degrades
 * to keyword-only search (see `searchSpaces`) and ingestion records a sentence a
 * human can act on in `kb_documents.error_message`, instead of a stack trace
 * ending a Cortex turn.
 *
 * WHY EVERY VECTOR IS STAMPED WITH ITS MODEL. Two models' vectors are
 * coordinates in unrelated spaces. Mixed in one column they do not error, they
 * RANK — and a similarity computed across them looks exactly like a real one.
 * `embeddingModelId()` is what `kb_chunks.embedding_model` stores and what
 * `kb_search_scoped` filters on, so changing provider makes the old vectors
 * invisible to search and visible to the reindexer, in that order. See
 * migration 0074.
 */

import {
  DEFAULT_EMBEDDING_PROVIDER,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_PROVIDERS,
  type EmbedInputType,
  type EmbeddingModelFacts,
  type EmbeddingProvider,
  type EmbeddingProviderId,
  PRICES_CHECKED_ON,
  isEmbeddingProviderId,
  qualifyModel,
} from './embedding-providers';

export {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_PROVIDERS,
  PRICES_CHECKED_ON,
  type EmbeddingProviderId,
  type EmbeddingModelFacts,
};

/** 429 and 5xx are transient by definition; four attempts spans ~7s of backoff. */
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/** Deliberately pessimistic: a rejected 400 costs a batch, a small batch a round trip. */
const CHARS_PER_TOKEN = 3.5;

/** Soft failure: never thrown, always returned. `reason` is user-facing prose. */
export interface EmbedFailure {
  ok: false;
  /** False only when the key is absent or misconfigured — what ops can fix directly. */
  configured: boolean;
  /**
   * False when repeating this request cannot help: no key, a rejected key, an
   * exhausted quota, a request the provider called invalid. Callers running
   * inside a retrying job MUST consult this before throwing — see
   * `ingest-document.ts` and `reindex-embeddings.ts`.
   */
  retryable: boolean;
  reason: string;
}

/** What one embedding call actually cost, for `kb_embedding_usage`. */
export interface EmbedUsage {
  provider: EmbeddingProviderId;
  model: string;
  /** Provider-qualified, e.g. `voyage:voyage-4-lite`. */
  modelId: string;
  texts: number;
  requests: number;
  tokens: number;
  /** True when `tokens` is our own estimate because the provider reported none. */
  estimated: boolean;
}

export type EmbedResult<T> = { ok: true; data: T; usage: EmbedUsage } | EmbedFailure;

/** The live configuration, resolved fresh on every call. */
export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  /** What goes in `kb_chunks.embedding_model`. */
  modelId: string;
  /** Verified price and free-tier facts, or null for a model we do not know. */
  facts: EmbeddingModelFacts | null;
  /** Whether this deployment holds the key this provider needs. */
  keyConfigured: boolean;
  apiKeyEnv: string;
}

/**
 * Read from `process.env` on every call rather than cached at import time. It is
 * two string lookups next to an HTTP request, and it means a deployment can be
 * repointed by changing an environment variable — and a test by setting one —
 * without a module reset.
 */
export function embeddingConfig(): EmbeddingConfig | { error: string } {
  const raw = (process.env.EMBEDDING_PROVIDER ?? '').trim().toLowerCase();
  if (raw && !isEmbeddingProviderId(raw)) {
    return {
      error: `EMBEDDING_PROVIDER is set to "${raw}", which is not a provider Cortex knows. Valid values are ${Object.keys(EMBEDDING_PROVIDERS).join(', ')}. Nothing will be embedded until it is corrected — the alternative, quietly falling back to the default, would mean writing vectors from a model nobody chose.`,
    };
  }
  const providerId: EmbeddingProviderId = raw
    ? (raw as EmbeddingProviderId)
    : DEFAULT_EMBEDDING_PROVIDER;
  const provider = EMBEDDING_PROVIDERS[providerId];
  const model = (process.env.EMBEDDING_MODEL ?? '').trim() || provider.defaultModel;
  return {
    provider,
    model,
    modelId: qualifyModel(providerId, model),
    facts: provider.catalog[model] ?? null,
    keyConfigured: !!process.env[provider.apiKeyEnv],
    apiKeyEnv: provider.apiKeyEnv,
  };
}

/**
 * The model identifier every vector written by this deployment is stamped with,
 * and the one search filters by. Falls back to the default provider's default
 * model when the configuration is broken — callers use this for filtering and
 * reporting, where a stable string beats an exception; the embedding path itself
 * refuses to run at all in that state.
 */
export function embeddingModelId(): string {
  const cfg = embeddingConfig();
  if ('error' in cfg) {
    const fallback = EMBEDDING_PROVIDERS[DEFAULT_EMBEDDING_PROVIDER];
    return qualifyModel(DEFAULT_EMBEDDING_PROVIDER, fallback.defaultModel);
  }
  return cfg.modelId;
}

function notConfiguredReason(cfg: EmbeddingConfig): string {
  return `Brain Knowledge cannot be indexed or searched by meaning right now — this deployment has no ${cfg.provider.label} API key (${cfg.apiKeyEnv}), so nothing can be turned into an embedding. Someone on the ops team needs to add it; until then only keyword matching works.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Honour `Retry-After` when the provider sends one — it knows when the window
 * opens, and guessing shorter just burns another request against the same limit.
 */
function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * L2-normalise. Cosine distance (the operator the HNSW index is built on) does
 * not care, but this is not merely defensive for every provider: Google
 * documents that `gemini-embedding-001` is normalised only at its native 3072
 * dimensions and that a reduced `outputDimensionality` must be normalised by the
 * caller. Doing it for everybody costs one pass and removes a per-provider
 * footgun from every future addition to the registry.
 */
function l2Normalize(values: number[]): number[] {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0 || norm === 1) return values;
  return values.map((v) => v / norm);
}

/**
 * Split on whichever ceiling — count or tokens — is reached first, returning
 * half-open index ranges rather than copies of the text.
 *
 * EXPORTED ON PURPOSE. A batch is the unit of money: one request, one charge,
 * one thing that can fail and be repaid. Callers that persist as they go (the
 * Inngest jobs) need the same boundaries the transport uses, so that "this batch
 * is done" is a fact they can record and never repeat.
 */
export function planEmbeddingBatches(
  texts: string[],
  provider?: EmbeddingProvider,
): Array<{ start: number; end: number }> {
  const cfg = embeddingConfig();
  const p =
    provider ?? ('error' in cfg ? EMBEDDING_PROVIDERS[DEFAULT_EMBEDDING_PROVIDER] : cfg.provider);
  const batches: Array<{ start: number; end: number }> = [];
  let start = 0;
  let tokens = 0;

  for (let i = 0; i < texts.length; i++) {
    const cost = estimateTokens(texts[i] ?? '');
    const size = i - start;
    if (size > 0 && (size >= p.maxTextsPerRequest || tokens + cost > p.maxTokensPerRequest)) {
      batches.push({ start, end: i });
      start = i;
      tokens = 0;
    }
    tokens += cost;
  }
  if (start < texts.length) batches.push({ start, end: texts.length });
  return batches;
}

function emptyUsage(cfg: EmbeddingConfig): EmbedUsage {
  return {
    provider: cfg.provider.id,
    model: cfg.model,
    modelId: cfg.modelId,
    texts: 0,
    requests: 0,
    tokens: 0,
    estimated: false,
  };
}

/** One provider request, with retries for the failures that retrying can fix. */
async function embedBatch(
  texts: string[],
  inputType: EmbedInputType,
  cfg: EmbeddingConfig,
  key: string,
): Promise<EmbedResult<number[][]>> {
  const { provider } = cfg;
  const plan = provider.buildRequest({ texts, inputType, model: cfg.model, key });
  let lastFailure: EmbedFailure = {
    ok: false,
    configured: true,
    retryable: true,
    reason: `${provider.label} did not answer the embedding request.`,
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(plan.url, {
        method: 'POST',
        headers: plan.headers,
        body: JSON.stringify(plan.body),
      });
    } catch {
      lastFailure = {
        ok: false,
        configured: true,
        retryable: true,
        reason: `I could not reach ${provider.label} at all just now. It may be a network blip — worth another try in a moment.`,
      };
      if (attempt + 1 < MAX_ATTEMPTS) await sleep(backoffMs(attempt, null));
      continue;
    }

    if (response.ok) {
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return {
          ok: false,
          configured: true,
          // A 200 we cannot parse is not a rate limit; repeating it will produce
          // the same unparseable answer and the same charge.
          retryable: false,
          reason: `${provider.label} answered with something I could not read. That usually means their API changed shape.`,
        };
      }

      const vectors = provider.parseVectors(parsed, texts.length);
      if (typeof vectors === 'string') {
        return { ok: false, configured: true, retryable: false, reason: vectors };
      }

      const reported = provider.reportedTokens(parsed);
      return {
        ok: true,
        data: vectors.map(l2Normalize),
        usage: {
          provider: provider.id,
          model: cfg.model,
          modelId: cfg.modelId,
          texts: texts.length,
          requests: 1,
          tokens: reported ?? texts.reduce((sum, t) => sum + estimateTokens(t), 0),
          estimated: reported === null,
        },
      };
    }

    const body = await response.text().catch(() => '');
    const described = provider.describeFailure(response.status, body);
    lastFailure = {
      ok: false,
      configured: true,
      retryable: described.retryable,
      reason: described.reason,
    };

    // Anything the provider has DECIDED about this request — a bad key, an empty
    // account, an invalid body — will be decided the same way next time.
    // Repeating it would only spend quota, and in the quota case there is none
    // left to spend.
    if (!described.retryable) return lastFailure;
    if (attempt + 1 < MAX_ATTEMPTS) {
      await sleep(backoffMs(attempt, response.headers?.get?.('retry-after') ?? null));
    }
  }

  return lastFailure;
}

/**
 * Embed `texts` one provider request at a time, handing each finished batch to
 * `onBatch` BEFORE the next one is sent.
 *
 * THIS IS THE FUNCTION THAT MAKES A RETRY CHEAP. The bug this file was rewritten
 * after was not that embedding failed; it was that a failure in batch 15 of 20
 * threw away the fourteen batches already paid for, and the retry bought them
 * again. So the result of every batch leaves this function the moment it exists,
 * and the caller persists it. A failure then costs exactly one batch — the one
 * that failed — and everything before it is already in the database and will
 * never be embedded again.
 *
 * `onBatch` is awaited, so a caller whose write fails stops the run rather than
 * racing ahead spending money on work it cannot store.
 */
export async function embedInBatches(
  texts: string[],
  onBatch: (batch: {
    start: number;
    end: number;
    vectors: number[][];
    usage: EmbedUsage;
  }) => Promise<void>,
): Promise<{ embedded: number; usage: EmbedUsage; failure: EmbedFailure | null }> {
  const cfg = embeddingConfig();
  if ('error' in cfg) {
    const fallback = EMBEDDING_PROVIDERS[DEFAULT_EMBEDDING_PROVIDER];
    return {
      embedded: 0,
      usage: {
        provider: DEFAULT_EMBEDDING_PROVIDER,
        model: fallback.defaultModel,
        modelId: qualifyModel(DEFAULT_EMBEDDING_PROVIDER, fallback.defaultModel),
        texts: 0,
        requests: 0,
        tokens: 0,
        estimated: false,
      },
      failure: { ok: false, configured: false, retryable: false, reason: cfg.error },
    };
  }

  const total = emptyUsage(cfg);
  if (texts.length === 0) return { embedded: 0, usage: total, failure: null };

  const key = process.env[cfg.provider.apiKeyEnv];
  if (!key) {
    return {
      embedded: 0,
      usage: total,
      failure: {
        ok: false,
        configured: false,
        retryable: false,
        reason: notConfiguredReason(cfg),
      },
    };
  }

  let embedded = 0;
  for (const { start, end } of planEmbeddingBatches(texts, cfg.provider)) {
    const result = await embedBatch(texts.slice(start, end), 'document', cfg, key);
    if (!result.ok) return { embedded, usage: total, failure: result };

    total.texts += result.usage.texts;
    total.requests += result.usage.requests;
    total.tokens += result.usage.tokens;
    total.estimated ||= result.usage.estimated;

    await onBatch({ start, end, vectors: result.data, usage: result.usage });
    embedded = end;
  }
  return { embedded, usage: total, failure: null };
}

async function embedAll(
  texts: string[],
  inputType: EmbedInputType,
): Promise<EmbedResult<number[][]>> {
  const cfg = embeddingConfig();
  if ('error' in cfg) {
    return { ok: false, configured: false, retryable: false, reason: cfg.error };
  }
  if (texts.length === 0) return { ok: true, data: [], usage: emptyUsage(cfg) };

  const key = process.env[cfg.provider.apiKeyEnv];
  if (!key) {
    return { ok: false, configured: false, retryable: false, reason: notConfiguredReason(cfg) };
  }

  const results: number[][] = [];
  const total = emptyUsage(cfg);
  for (const { start, end } of planEmbeddingBatches(texts, cfg.provider)) {
    const embedded = await embedBatch(texts.slice(start, end), inputType, cfg, key);
    // A partial batch is not a partial result: chunk i must line up with vector
    // i, so one bad batch fails the call rather than silently shifting the rest.
    // Callers that cannot afford to lose the finished batches use
    // `embedInBatches` instead, which persists as it goes.
    if (!embedded.ok) return embedded;
    results.push(...embedded.data);
    total.texts += embedded.usage.texts;
    total.requests += embedded.usage.requests;
    total.tokens += embedded.usage.tokens;
    total.estimated ||= embedded.usage.estimated;
  }
  return { ok: true, data: results, usage: total };
}

/**
 * Embed passages for INDEXING. Returns one 1024-dimensional unit vector per
 * input, in input order.
 *
 * Note for anything running inside a retrying background job: this call is
 * atomic in its result but not in its cost — it may make several paid requests
 * and returns nothing at all if the last one fails. Use `embedInBatches` there.
 */
export function embedDocuments(texts: string[]): Promise<EmbedResult<number[][]>> {
  return embedAll(texts, 'document');
}

/**
 * Embed one search phrase for RETRIEVAL. Never use this for anything being
 * written to `kb_chunks` — see the note on asymmetry above.
 */
export async function embedQuery(text: string): Promise<EmbedResult<number[]>> {
  const embedded = await embedAll([text], 'query');
  if (!embedded.ok) return embedded;
  const vector = embedded.data[0];
  if (!vector) {
    return {
      ok: false,
      configured: true,
      retryable: false,
      reason: 'The embedding provider returned no vector for that query.',
    };
  }
  return { ok: true, data: vector, usage: embedded.usage };
}
