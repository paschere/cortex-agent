/**
 * Brain Knowledge embeddings — Voyage AI (`voyage-3-large`, 1024 dimensions).
 *
 * WHY VOYAGE AND NOT GEMINI. Generation moved to Claude a while ago, but the
 * embeddings stayed on `gemini-embedding-001` for one reason only: Anthropic
 * ships no embedding endpoint. The consequence was worse than the inconsistency
 * — the Gemini key was never provisioned in production, so the whole KB simply
 * did not index. Voyage is the provider Anthropic points at, it retrieves
 * better than the 768-dim Gemini output we were truncating to, and switching
 * while the corpus is nearly empty costs one background pass. The same switch
 * against a full corpus costs a re-embed of every chunk.
 *
 * WHY TWO FUNCTIONS INSTEAD OF A FLAG. Voyage is trained asymmetrically: a
 * passage indexed as a `document` and a question sent as a `query` are placed
 * in the same space on purpose, and using one type on both sides measurably
 * degrades recall. That is a silent failure — nothing errors, results just get
 * worse — so the choice is not expressible as an argument here. `embedDocuments`
 * indexes, `embedQuery` retrieves, and there is no third way to call the API.
 *
 * WHY IT NEVER THROWS. Like the Apollo and BambooHR clients, every failure is
 * returned rather than raised. A missing key, a rotated key and a rate limit are
 * operating conditions of a third party, not bugs in a turn: retrieval degrades
 * to keyword-only search (see `searchSpaces`) and ingestion records a sentence a
 * human can act on in `kb_documents.error_message`, instead of a stack trace
 * ending a Cortex turn.
 */

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

export const EMBEDDING_MODEL = 'voyage-3-large';

/**
 * Must match the pgvector column dimension (vector(1024), migration 0057).
 * voyage-3-large natively outputs 2048; 1024 is the Matryoshka-truncated size,
 * which keeps ~99% of the retrieval quality at half the index size.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Voyage accepts at most 1,000 texts and 120K tokens per request for
 * voyage-3-large. The token ceiling binds first with KB chunks (~400 tokens
 * each), so batches are capped on both axes and the token estimate is
 * deliberately pessimistic — a rejected 400 costs a whole batch, a slightly
 * small batch costs one extra round trip.
 */
const MAX_TEXTS_PER_REQUEST = 128;
const MAX_TOKENS_PER_REQUEST = 100_000;
const CHARS_PER_TOKEN = 3.5;

/** 429 and 5xx are transient by definition; four attempts spans ~7s of backoff. */
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/** Soft failure: never thrown, always returned. `reason` is user-facing prose. */
export interface EmbedFailure {
  ok: false;
  /** False only when the key is absent — the one case ops can fix directly. */
  configured: boolean;
  reason: string;
}

export type EmbedResult<T> = { ok: true; data: T } | EmbedFailure;

export const NOT_CONFIGURED_REASON =
  'Brain Knowledge cannot be indexed or searched by meaning right now — this deployment has no Voyage API key (VOYAGE_API_KEY), so nothing can be turned into an embedding. Someone on the ops team needs to add it; until then only keyword matching works.';

interface VoyageResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

function describeHttpFailure(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return 'Voyage rejected our API key. It has most likely been rotated or revoked — ops needs to refresh VOYAGE_API_KEY before Brain Knowledge can be embedded again.';
  }
  if (status === 402 || /quota|credit|billing|payment/i.test(body)) {
    return 'The Voyage account is out of credit, so it will not embed anything until someone tops it up. Search still works on keywords in the meantime.';
  }
  if (status === 429) {
    return 'Voyage is rate-limiting us right now — too many embedding requests in a short window. It should clear on its own within a minute.';
  }
  if (status === 400 || status === 422) {
    return 'Voyage turned that embedding request down as invalid. That usually means a single passage was too long even after chunking.';
  }
  if (status >= 500) {
    return 'Voyage is having trouble on their side and did not answer. That normally clears within a few minutes.';
  }
  return `Voyage could not embed that text (it answered ${status}).`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Honour `Retry-After` when Voyage sends one — it knows when the window opens
 * and guessing shorter just burns another request against the same limit.
 */
function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Split on whichever ceiling — count or tokens — is reached first. */
function toBatches(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let tokens = 0;

  for (const text of texts) {
    const cost = estimateTokens(text);
    if (
      current.length > 0 &&
      (current.length >= MAX_TEXTS_PER_REQUEST || tokens + cost > MAX_TOKENS_PER_REQUEST)
    ) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(text);
    tokens += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Voyage documents float embeddings as unit length, but the 1024-dim output is
 * a truncation of the native 2048 and truncation does not preserve norm. Cosine
 * distance (the operator the index is built on) does not care, so this is
 * belt-and-braces for anything that later reaches for a dot product.
 */
function l2Normalize(values: number[]): number[] {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0 || norm === 1) return values;
  return values.map((v) => v / norm);
}

async function embedBatch(
  texts: string[],
  inputType: 'document' | 'query',
  key: string,
): Promise<EmbedResult<number[][]>> {
  let lastFailure: EmbedFailure = {
    ok: false,
    configured: true,
    reason: 'Voyage did not answer the embedding request.',
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: texts,
          model: EMBEDDING_MODEL,
          input_type: inputType,
          output_dimension: EMBEDDING_DIMENSIONS,
          // A passage longer than the model's context is worth indexing
          // truncated; refusing it would fail the whole document over one
          // oversized chunk.
          truncation: true,
        }),
      });
    } catch {
      lastFailure = {
        ok: false,
        configured: true,
        reason:
          'I could not reach Voyage at all just now. It may be a network blip — worth another try in a moment.',
      };
      if (attempt + 1 < MAX_ATTEMPTS) await sleep(backoffMs(attempt, null));
      continue;
    }

    if (response.ok) {
      let parsed: VoyageResponse;
      try {
        parsed = (await response.json()) as VoyageResponse;
      } catch {
        return {
          ok: false,
          configured: true,
          reason:
            'Voyage answered with something I could not read. Worth trying again in a moment.',
        };
      }

      const rows = parsed.data ?? [];
      if (rows.length !== texts.length) {
        return {
          ok: false,
          configured: true,
          reason: `Voyage returned ${rows.length} embeddings for ${texts.length} passages, so the batch cannot be matched back to its text.`,
        };
      }

      // `index` is authoritative: the API documents the order but pairing by it
      // is what keeps a chunk's text and its vector together if it ever slips.
      const vectors: number[][] = new Array(texts.length);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const values = row?.embedding;
        if (!values) {
          return {
            ok: false,
            configured: true,
            reason: 'Voyage returned an embedding with no vector in it.',
          };
        }
        vectors[row?.index ?? i] = l2Normalize(values);
      }
      return { ok: true, data: vectors };
    }

    const body = await response.text().catch(() => '');
    lastFailure = {
      ok: false,
      configured: true,
      reason: describeHttpFailure(response.status, body),
    };

    // Anything else is a decision Voyage has made about this request; repeating
    // it verbatim would only spend quota.
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable) return lastFailure;
    if (attempt + 1 < MAX_ATTEMPTS) {
      await sleep(backoffMs(attempt, response.headers?.get?.('retry-after') ?? null));
    }
  }

  return lastFailure;
}

async function embedAll(
  texts: string[],
  inputType: 'document' | 'query',
): Promise<EmbedResult<number[][]>> {
  if (texts.length === 0) return { ok: true, data: [] };

  const key = process.env.VOYAGE_API_KEY;
  if (!key) return { ok: false, configured: false, reason: NOT_CONFIGURED_REASON };

  const results: number[][] = [];
  for (const batch of toBatches(texts)) {
    const embedded = await embedBatch(batch, inputType, key);
    // A partial batch is not a partial result: chunk i must line up with vector
    // i, so one bad batch fails the call rather than silently shifting the rest.
    if (!embedded.ok) return embedded;
    results.push(...embedded.data);
  }
  return { ok: true, data: results };
}

/**
 * Embed passages for INDEXING (`input_type: "document"`). Returns one
 * 1024-dimensional unit vector per input, in input order.
 */
export function embedDocuments(texts: string[]): Promise<EmbedResult<number[][]>> {
  return embedAll(texts, 'document');
}

/**
 * Embed one search phrase for RETRIEVAL (`input_type: "query"`). Never use this
 * for anything being written to `kb_chunks` — see the note on asymmetry above.
 */
export async function embedQuery(text: string): Promise<EmbedResult<number[]>> {
  const embedded = await embedAll([text], 'query');
  if (!embedded.ok) return embedded;
  const vector = embedded.data[0];
  if (!vector) {
    return { ok: false, configured: true, reason: 'Voyage returned no embedding for that query.' };
  }
  return { ok: true, data: vector };
}
