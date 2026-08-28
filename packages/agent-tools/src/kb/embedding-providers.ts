/**
 * The four embedding providers Cortex can be pointed at, and everything that
 * differs between them.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `embedder.ts`. Batching, retrying,
 * normalising and reporting usage are the same job whoever answers the HTTP
 * call. What genuinely differs is four things — the URL, the request body's
 * field names, where the vector sits in the response, and what the provider's
 * error codes mean. Those four live here, one object per provider, so that
 * adding a fifth is a data change and `embedder.ts` never grows a switch.
 *
 * THE CONSTRAINT THAT DECIDES EVERYTHING. `kb_chunks.embedding` is
 * `vector(1024)` behind an HNSW index (migrations 0057, 0074). A provider that
 * cannot emit 1024 dimensions is not a configuration choice, it is a database
 * migration plus a full re-embed of the corpus. So every model listed here is
 * one that produces 1024 dimensions — natively or on request — and the registry
 * records HOW, because "it supports 1024" and "it supports 1024 if you ask for
 * it with the right parameter name" are different facts with different failure
 * modes.
 *
 * PRICES ARE VERIFIED, NOT REMEMBERED. Every number below was read off the
 * provider's own live documentation on the date in `PRICES_CHECKED_ON`, and the
 * source URL is in the comment above each provider. They are here because the
 * specific failure this module was written after was a model chosen without
 * anyone knowing it was the only one in its catalogue with no free tier. A price
 * that lives in a comment nobody reads is how that happens again; a price the
 * Integrations screen prints is how it does not. Where a provider has stopped
 * publishing a per-token price, the field is `null` and the UI says "sin precio
 * público" — never a number somebody half-remembers.
 */

export type EmbeddingProviderId = 'voyage' | 'openai' | 'google' | 'cohere';

/** Indexing and retrieving are different sides of the same space — never mix. */
export type EmbedInputType = 'document' | 'query';

/** Must match the pgvector column dimension (`vector(1024)`, migrations 0057/0074). */
export const EMBEDDING_DIMENSIONS = 1024;

/** The day every price and free-token figure in this file was read off a live page. */
export const PRICES_CHECKED_ON = '2026-08-04';

/**
 * What a model costs and whether anything about it is free. `freeTierTokens: 0`
 * is the fact that cost this deployment its credits, so it is a required field
 * rather than an optional one — a new entry cannot be added without answering it.
 */
export interface EmbeddingModelFacts {
  /**
   * USD per million input tokens, from the provider's own pricing page. NULL
   * when the provider no longer publishes one (Cohere), which is itself worth
   * knowing before you route a corpus through them.
   */
  pricePerMillionTokensUsd: number | null;
  /**
   * Complimentary TOKENS the account gets for this specific model. 0 means
   * none — and note that "0" is not the same as "no free tier at all": several
   * providers offer a rate-limited free key, which is a different and much
   * smaller promise. Say which in `note`.
   */
  freeTierTokens: number;
  /** True when 1024 is what the model emits without being asked. */
  nativeAt1024: boolean;
  /** One line a human can act on, shown next to the model in the UI (es-CO). */
  note: string;
}

export interface EmbeddingRequestPlan {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ProviderFailure {
  reason: string;
  /**
   * FALSE for anything repeating the request cannot fix: a rejected key, an
   * exhausted quota, a malformed request. Retrying those is not perseverance,
   * it is spending money on a decision the provider has already made — and in
   * the quota case it is spending money the account does not have.
   */
  retryable: boolean;
}

export interface EmbeddingProvider {
  id: EmbeddingProviderId;
  /** Human name, used in prose and on the Integrations card. */
  label: string;
  /** Used when `EMBEDDING_MODEL` is unset. */
  defaultModel: string;
  /** The environment variable holding the key. */
  apiKeyEnv: string;
  /** Ceiling on texts in one request. */
  maxTextsPerRequest: number;
  /** Ceiling on tokens in one request. */
  maxTokensPerRequest: number;
  /** Everything we know how to price, keyed by the provider's own model id. */
  catalog: Readonly<Record<string, EmbeddingModelFacts>>;
  buildRequest(args: {
    texts: string[];
    inputType: EmbedInputType;
    model: string;
    key: string;
  }): EmbeddingRequestPlan;
  /**
   * Pull `count` vectors out of a 2xx body, in INPUT order. Returns a string
   * when the body is well-formed JSON that still cannot be used — a mismatched
   * count, a missing vector — because that is a bug or an API change, not a
   * network condition, and it must not be retried into a bill.
   */
  parseVectors(json: unknown, count: number): number[][] | string;
  /** Tokens the provider says it charged for, or null when it does not say. */
  reportedTokens(json: unknown): number | null;
  /** What a non-2xx means, and whether repeating it could ever help. */
  describeFailure(status: number, body: string): ProviderFailure;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Vectors reach an ordered array keyed by their own reported position when the
 * provider reports one. Every API here documents response order, but pairing by
 * the index they hand back is what keeps a passage and its vector together on
 * the day one of them stops honouring that — and OpenAI's reference says in so
 * many words that `data` may not be ordered.
 */
function collect(
  rows: unknown[],
  count: number,
  vectorAt: (row: Record<string, unknown>) => unknown,
  indexAt: (row: Record<string, unknown>, fallback: number) => number,
  who: string,
): number[][] | string {
  if (rows.length !== count) {
    return `${who} returned ${rows.length} embeddings for ${count} passages, so the batch cannot be matched back to its text.`;
  }
  const out: number[][] = new Array(count);
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const values = vectorAt(asRecord(raw));
    if (!Array.isArray(values) || values.length === 0) {
      return `${who} returned an embedding with no vector in it.`;
    }
    const at = indexAt(asRecord(raw), i);
    if (!Number.isInteger(at) || at < 0 || at >= count) {
      return `${who} returned an embedding pointing at passage ${at}, which is not in this batch.`;
    }
    out[at] = values as number[];
  }
  for (let i = 0; i < count; i++) {
    if (!out[i]) return `${who} left passage ${i} of this batch without a vector.`;
  }
  return out;
}

/** Every provider agrees on these two; only the wording differs. */
function genericFailure(who: string, status: number): ProviderFailure {
  if (status === 429) {
    return {
      reason: `${who} is rate-limiting us right now — too many embedding requests in a short window. It should clear on its own within a minute.`,
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      reason: `${who} is having trouble on their side and did not answer. That normally clears within a few minutes.`,
      retryable: true,
    };
  }
  return {
    reason: `${who} could not embed that text (it answered ${status}).`,
    retryable: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Voyage — the default                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Verified 2026-08-04 against https://docs.voyageai.com/docs/pricing and
 * https://docs.voyageai.com/docs/embeddings.
 *
 * The complimentary 200M tokens cover voyage-4-large, voyage-4, voyage-4-lite,
 * voyage-context-4 and voyage-code-3; a separate 50M covers voyage-multilingual-2,
 * voyage-finance-2, voyage-law-2 and voyage-code-2. `voyage-3-large` — what this
 * deployment was running — is in NEITHER list, at $0.18/M, the joint-highest
 * price in the catalogue, under a heading that says outright that no free tokens
 * are offered for the older models. That is the whole story of the exhausted
 * account, before the retry bug even multiplied it.
 *
 * The voyage-4 family and voyage-3-large all DEFAULT to 1024 dimensions and
 * accept 256/512/1024/2048, so moving between them never touches the index.
 * Request cap: 1,000 texts; the token cap per request varies by model group
 * (1M for the lite models, 320K standard, 120K for voyage-3-large's group).
 */
const VOYAGE: EmbeddingProvider = {
  id: 'voyage',
  label: 'Voyage AI',
  defaultModel: 'voyage-4-lite',
  apiKeyEnv: 'VOYAGE_API_KEY',
  // Far under the documented 1,000. The token ceiling binds first with ~400-token
  // KB chunks anyway, and a smaller request is a smaller thing to lose and repay.
  maxTextsPerRequest: 128,
  // Under the tightest documented group limit (120K), so this number stays valid
  // whichever Voyage model the deployment is pointed at.
  maxTokensPerRequest: 100_000,
  catalog: {
    'voyage-4-lite': {
      pricePerMillionTokensUsd: 0.02,
      freeTierTokens: 200_000_000,
      nativeAt1024: true,
      note: 'El más barato del catálogo de Voyage y con 200 millones de tokens gratis. Da 1024 dimensiones por omisión, así que no toca el índice.',
    },
    'voyage-4': {
      pricePerMillionTokensUsd: 0.06,
      freeTierTokens: 200_000_000,
      nativeAt1024: true,
      note: 'El escalón siguiente si la recuperación se queda corta con el lite: el triple de precio, los mismos 200 millones gratis y las mismas 1024 dimensiones.',
    },
    'voyage-4-large': {
      pricePerMillionTokensUsd: 0.12,
      freeTierTokens: 200_000_000,
      nativeAt1024: true,
      note: 'La mejor recuperación de Voyage. Seis veces el precio del lite, con el mismo nivel gratuito de 200 millones.',
    },
    'voyage-3-large': {
      pricePerMillionTokensUsd: 0.18,
      freeTierTokens: 0,
      nativeAt1024: true,
      note: 'Modelo antiguo, el más caro del catálogo y SIN tokens gratis. Es el que agotó los créditos de esta instalación: no lo vuelvas a poner.',
    },
    'voyage-3.5-lite': {
      pricePerMillionTokensUsd: 0.02,
      freeTierTokens: 0,
      nativeAt1024: true,
      note: 'Cuesta lo mismo que voyage-4-lite pero no tiene nivel gratuito. No hay ninguna razón para preferirlo.',
    },
  },
  buildRequest: ({ texts, inputType, model, key }) => ({
    url: 'https://api.voyageai.com/v1/embeddings',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: {
      input: texts,
      model,
      // Voyage is trained asymmetrically: a passage indexed as a `document` and
      // a question sent as a `query` are placed in the same space on purpose,
      // and using one type on both sides measurably degrades recall.
      input_type: inputType,
      output_dimension: EMBEDDING_DIMENSIONS,
      // A passage longer than the model's context is worth indexing truncated;
      // refusing it would fail a whole document over one oversized chunk.
      truncation: true,
    },
  }),
  parseVectors: (json, count) =>
    collect(
      (asRecord(json).data as unknown[]) ?? [],
      count,
      (row) => row.embedding,
      (row, fallback) => numberOrNull(row.index) ?? fallback,
      'Voyage',
    ),
  reportedTokens: (json) => numberOrNull(asRecord(asRecord(json).usage).total_tokens),
  describeFailure: (status, body) => {
    if (status === 401 || status === 403) {
      return {
        reason:
          'Voyage rejected our API key. It has most likely been rotated or revoked — ops needs to refresh VOYAGE_API_KEY before Brain Knowledge can be embedded again.',
        retryable: false,
      };
    }
    if (status === 402 || /quota|credit|billing|payment/i.test(body)) {
      return {
        reason:
          'The Voyage account is out of credit, so it will not embed anything until someone tops it up. Search still works on keywords in the meantime.',
        retryable: false,
      };
    }
    if (status === 400 || status === 422) {
      return {
        reason:
          'Voyage turned that embedding request down as invalid. That usually means a single passage was too long even after chunking.',
        retryable: false,
      };
    }
    return genericFailure('Voyage', status);
  },
};

/* -------------------------------------------------------------------------- */
/* OpenAI                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Verified 2026-08-04 against https://developers.openai.com/api/docs/api-reference/embeddings/create,
 * .../guides/embeddings, .../guides/error-codes and .../api/docs/pricing.
 * (platform.openai.com now redirects there.)
 *
 * `dimensions` accepts 1–1536 on text-embedding-3-small, so 1024 is valid, and
 * OpenAI performs the truncation AND the renormalisation server-side when the
 * parameter is used — the manual L2 step in their guide is only for callers who
 * slice the vector themselves. Request caps: 2,048 inputs, 8,192 tokens per
 * input, 300,000 tokens across the whole request.
 *
 * Price $0.02/M (3-large is $0.13/M). There is no free TOKEN grant: new accounts
 * get a credit, which runs out, so `freeTierTokens` is 0 and the note says so.
 */
const OPENAI: EmbeddingProvider = {
  id: 'openai',
  label: 'OpenAI',
  defaultModel: 'text-embedding-3-small',
  apiKeyEnv: 'OPENAI_API_KEY',
  maxTextsPerRequest: 128,
  // A third of the documented 300K request ceiling.
  maxTokensPerRequest: 100_000,
  catalog: {
    'text-embedding-3-small': {
      pricePerMillionTokensUsd: 0.02,
      freeTierTokens: 0,
      nativeAt1024: false,
      note: 'Cuesta lo mismo que voyage-4-lite y rinde bien en español, pero no trae tokens gratis: se paga desde el primero. Nace en 1536 dimensiones y hay que pedirle 1024 con el parámetro `dimensions`.',
    },
    'text-embedding-3-large': {
      pricePerMillionTokensUsd: 0.13,
      freeTierTokens: 0,
      nativeAt1024: false,
      note: 'Mejor recuperación que el small a más de seis veces el precio. También hay que reducirlo a 1024 con `dimensions`.',
    },
  },
  buildRequest: ({ texts, model, key }) => ({
    url: 'https://api.openai.com/v1/embeddings',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: {
      input: texts,
      model,
      // The whole reason this provider is usable at all: without it the model
      // returns 1536 dimensions and every write to kb_chunks is rejected by the
      // column's type.
      dimensions: EMBEDDING_DIMENSIONS,
      encoding_format: 'float',
      // OpenAI's embeddings are symmetric — there is no input_type on this API.
      // `inputType` is deliberately ignored rather than mapped onto some other
      // parameter that would look like it meant the same thing.
    },
  }),
  parseVectors: (json, count) =>
    collect(
      (asRecord(json).data as unknown[]) ?? [],
      count,
      (row) => row.embedding,
      (row, fallback) => numberOrNull(row.index) ?? fallback,
      'OpenAI',
    ),
  reportedTokens: (json) => numberOrNull(asRecord(asRecord(json).usage).prompt_tokens),
  describeFailure: (status, body) => {
    if (status === 401) {
      return {
        reason:
          'OpenAI rejected our API key. It has most likely been rotated or revoked — ops needs to refresh OPENAI_API_KEY before Brain Knowledge can be embedded again.',
        retryable: false,
      };
    }
    // OpenAI answers 429 for BOTH "too fast" and "you have no money left", and
    // the two need opposite handling: one clears by waiting, the other clears
    // only when somebody pays. Their own error-codes page says it plainly —
    // "retrying billing, spend, or quota errors won't restore API access" — and
    // points at `error.type: insufficient_quota` plus the newer billing codes
    // (credit_balance_exhausted, *_spend_limit_exceeded, organization_usage_limit_exceeded)
    // as the discriminator. Anything else on a 429 is a genuine rate limit.
    if (
      status === 429 &&
      /insufficient_quota|credit_balance_exhausted|spend_limit_exceeded|usage_limit_exceeded|billing/i.test(
        body,
      )
    ) {
      return {
        reason:
          'The OpenAI account has no quota left — its credit or its spend limit is exhausted. Retrying will not bring it back; somebody has to top it up or raise the limit. Search still works on keywords in the meantime.',
        retryable: false,
      };
    }
    if (status === 400 || status === 422) {
      return {
        reason:
          'OpenAI turned that embedding request down as invalid. That usually means a single passage was too long even after chunking.',
        retryable: false,
      };
    }
    return genericFailure('OpenAI', status);
  },
};

/* -------------------------------------------------------------------------- */
/* Google                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Verified 2026-08-04 against https://ai.google.dev/api/embeddings,
 * https://ai.google.dev/gemini-api/docs/embeddings and .../docs/pricing.
 *
 * WHY IT IS HERE AT ALL: `GOOGLE_GENERATIVE_AI_API_KEY` is the one embedding
 * key that already exists in this deployment's production environment. It is
 * therefore the only provider that can be switched to TODAY without anyone
 * signing up for anything — which makes it the emergency exit, not the default.
 * Paid, it costs $0.15/M, seven and a half times voyage-4-lite.
 *
 * TWO THINGS IT MAKES YOU DO BY HAND. Google documents that
 * gemini-embedding-001 is normalised only at its native 3072 dimensions and
 * that any smaller `outputDimensionality` must be L2-normalised by the caller.
 * The embedder normalises every vector from every provider; for this one that
 * is load-bearing rather than defensive. The second is `taskType`:
 * RETRIEVAL_DOCUMENT to index, RETRIEVAL_QUERY to search — Google's spelling of
 * the same asymmetry Voyage calls `input_type`.
 *
 * TWO THINGS THE LIVE DOCS DO NOT SETTLE, both handled conservatively here:
 *   * 1024 sits inside the documented MRL range (128–3072) but is not in the
 *     recommended set (768/1536/3072). It is the dimension the column has, so
 *     it is the dimension we ask for.
 *   * `batchEmbedContents` publishes no maximum number of requests per call.
 *     100 is a guess, and it is a guess on the safe side; it is a field on this
 *     object precisely so it can be moved without touching any logic.
 */
const GOOGLE: EmbeddingProvider = {
  id: 'google',
  label: 'Google Gemini',
  defaultModel: 'gemini-embedding-001',
  apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
  maxTextsPerRequest: 100,
  // gemini-embedding-001 takes 2,048 tokens per input; the per-call total is
  // unpublished, so this is deliberately modest.
  maxTokensPerRequest: 50_000,
  catalog: {
    'gemini-embedding-001': {
      pricePerMillionTokensUsd: 0.15,
      freeTierTokens: 0,
      nativeAt1024: false,
      note: 'La única clave que ya existe en producción: es la salida de emergencia si hay que abandonar Voyage sin contratar nada. Tiene nivel gratuito, pero limitado por peticiones y no por tokens; pagado cuesta siete veces voyage-4-lite. Hay que pedirle 1024 con `outputDimensionality` y normalizar el vector a mano.',
    },
  },
  buildRequest: ({ texts, inputType, model, key }) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
    // The header form rather than `?key=`, so the key never lands in a URL that
    // some proxy or error log will happily keep a copy of.
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: {
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        // The REST reference marks these top-level fields deprecated in favour
        // of `embedContentConfig`, but still documents and accepts them. They
        // stay top-level until the deprecation becomes a removal, because
        // sending a field this API version does not know is a 400 on every
        // request rather than a warning.
        taskType: inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
        outputDimensionality: EMBEDDING_DIMENSIONS,
      })),
    },
  }),
  parseVectors: (json, count) =>
    collect(
      (asRecord(json).embeddings as unknown[]) ?? [],
      count,
      (row) => row.values,
      // The batch response carries no index; it is documented to answer in
      // request order and there is nothing else to pair on.
      (_row, fallback) => fallback,
      'Gemini',
    ),
  reportedTokens: (json) => numberOrNull(asRecord(asRecord(json).usageMetadata).promptTokenCount),
  describeFailure: (status, body) => {
    if (status === 401 || status === 403) {
      return {
        reason:
          'Google rejected our API key. It has most likely been rotated, revoked, or never had the Generative Language API enabled — ops needs to check GOOGLE_GENERATIVE_AI_API_KEY.',
        retryable: false,
      };
    }
    // Google publishes two different 429 bodies across two live pages: the
    // older `{"error":{"status":"RESOURCE_EXHAUSTED"}}` and the newer
    // `{"error":{"code":"rate_limit_exceeded" | "quota_exceeded"}}`. Only the
    // second distinguishes "you are going too fast" from "you are out for the
    // day", so both shapes are read and the ambiguous one is treated as a rate
    // limit — the retryable reading, which is the safe way to be wrong here
    // because a rate limit that is really a quota simply fails again a moment
    // later, whereas a quota treated as fatal would stall a healthy install.
    if (status === 429) {
      if (
        /quota_exceeded/i.test(body) ||
        (/RESOURCE_EXHAUSTED/.test(body) && /daily/i.test(body))
      ) {
        return {
          reason:
            'The Google project has used up its embedding quota for the day. Raising the quota or enabling billing is the only thing that clears it; search still works on keywords in the meantime.',
          retryable: false,
        };
      }
      return genericFailure('Google', 429);
    }
    if (status === 400) {
      return {
        reason:
          'Google turned that embedding request down as invalid. That usually means a single passage was too long even after chunking.',
        retryable: false,
      };
    }
    return genericFailure('Google', status);
  },
};

/* -------------------------------------------------------------------------- */
/* Cohere                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Verified 2026-08-04 against https://docs.cohere.com/reference/embed,
 * .../docs/cohere-embed, .../reference/errors and https://cohere.com/pricing.
 *
 * `embed-multilingual-v3.0` is 1024 dimensions NATIVELY and NOT configurable —
 * `output_dimension` is an Embed v4+ parameter and is deliberately not sent for
 * the v3 models. Strong Spanish, a 512-token context (shorter than the others,
 * hence `truncate: END`), and a clean error taxonomy: 402 means billing, 429
 * means rate limit, with no overlap to disentangle.
 *
 * THE V2 RESPONSE IS THE EASY THING TO GET WRONG. v2 nests vectors under
 * `embeddings.float`, where v1 returned a flat `embeddings` array, and v2 makes
 * both `input_type` and `embedding_types` required.
 *
 * PRICE: NOT VERIFIABLE. cohere.com/pricing no longer publishes a per-token API
 * rate for any embedding model — only dedicated Model Vault instances by the
 * hour — and the docs page on pricing links back to it. Third-party trackers
 * quote a figure; none of them is Cohere. So the price is null and the UI says
 * there is no published price, which is the honest thing to show somebody
 * deciding where to send a corpus.
 */
const COHERE: EmbeddingProvider = {
  id: 'cohere',
  label: 'Cohere',
  defaultModel: 'embed-multilingual-v3.0',
  apiKeyEnv: 'COHERE_API_KEY',
  // The documented maximum, exactly.
  maxTextsPerRequest: 96,
  // 96 texts × the model's 512-token context is ~49K; anything larger is
  // unreachable, so this is the real ceiling rather than an arbitrary one.
  maxTokensPerRequest: 50_000,
  catalog: {
    'embed-multilingual-v3.0': {
      pricePerMillionTokensUsd: null,
      freeTierTokens: 0,
      nativeAt1024: true,
      note: 'Fuerte en español y 1024 dimensiones nativas, sin parámetros que ajustar. Cohere dejó de publicar el precio por token, así que no se puede comparar de frente: verifícalo con ellos antes de mover un corpus. La clave de prueba es gratis pero limitada por peticiones, no por tokens.',
    },
    'embed-v4.0': {
      pricePerMillionTokensUsd: null,
      freeTierTokens: 0,
      nativeAt1024: false,
      note: 'La generación siguiente de Cohere. Hay que pedirle 1024 con `output_dimension` y tampoco tiene precio público. Sólo vale la pena si ya usas Cohere para otra cosa.',
    },
  },
  buildRequest: ({ texts, inputType, model, key }) => {
    const body: Record<string, unknown> = {
      texts,
      model,
      // Both of these are REQUIRED on v2; omitting either is a 400.
      input_type: inputType === 'query' ? 'search_query' : 'search_document',
      embedding_types: ['float'],
      truncate: 'END',
    };
    // Only Embed v4 and later understand this. Sending it to a v3 model is at
    // best ignored and at worst rejected, and the v3 models are 1024 anyway.
    if (!/-v3\.0$/.test(model)) body.output_dimension = EMBEDDING_DIMENSIONS;
    return {
      url: 'https://api.cohere.com/v2/embed',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
    };
  },
  parseVectors: (json, count) =>
    collect(
      (asRecord(asRecord(json).embeddings).float as unknown[]) ?? [],
      count,
      (row) => row,
      (_row, fallback) => fallback,
      'Cohere',
    ),
  reportedTokens: (json) =>
    numberOrNull(asRecord(asRecord(asRecord(json).meta).billed_units).input_tokens),
  describeFailure: (status, body) => {
    if (status === 401 || status === 403) {
      return {
        reason:
          'Cohere rejected our API key. It has most likely been rotated or revoked — ops needs to refresh COHERE_API_KEY before Brain Knowledge can be embedded again.',
        retryable: false,
      };
    }
    // Cohere is the one provider that separates these cleanly: 402 is billing,
    // 429 is speed. No body sniffing required.
    if (status === 402 || /quota|credit|billing|payment/i.test(body)) {
      return {
        reason:
          'The Cohere account needs a payment method or has run out of credit, so it will not embed anything until someone sorts that out. Search still works on keywords in the meantime.',
        retryable: false,
      };
    }
    if (status === 400 || status === 422) {
      return {
        reason:
          'Cohere turned that embedding request down as invalid. That usually means a single passage was too long even after chunking.',
        retryable: false,
      };
    }
    return genericFailure('Cohere', status);
  },
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

export const EMBEDDING_PROVIDERS: Readonly<Record<EmbeddingProviderId, EmbeddingProvider>> = {
  voyage: VOYAGE,
  openai: OPENAI,
  google: GOOGLE,
  cohere: COHERE,
};

/**
 * The default, and the reasoning behind it, in one place.
 *
 * `voyage-4-lite` wins on every axis that matters here at once: it is the joint
 * cheapest verified price in this file ($0.02/M), it is one of the five models
 * Voyage grants 200 MILLION free tokens to, and it emits 1024 dimensions
 * natively so the HNSW index is untouched. Moving to it from `voyage-3-large` is
 * a string change plus a re-embed of a corpus that is currently almost empty —
 * the smallest possible fix for the largest part of the bill.
 *
 * Nothing else comes close on the combination. text-embedding-3-small matches
 * the price but grants no free tokens; gemini-embedding-001 is the only key
 * already present in production but costs 7.5×; embed-multilingual-v3.0 will not
 * even tell us what it costs.
 */
export const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProviderId = 'voyage';

export function isEmbeddingProviderId(value: string): value is EmbeddingProviderId {
  return Object.hasOwn(EMBEDDING_PROVIDERS, value);
}

/** `voyage:voyage-4-lite` — exactly what goes in `kb_chunks.embedding_model`. */
export function qualifyModel(provider: EmbeddingProviderId, model: string): string {
  return `${provider}:${model}`;
}
