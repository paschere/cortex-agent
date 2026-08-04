import { anthropic } from '@ai-sdk/anthropic';

type ClaudeModel = ReturnType<typeof anthropic>;
type CallOptions = Parameters<ClaudeModel['doGenerate']>[0];

/** Drop the three parameters Claude Opus 5 refuses to accept. */
function withoutSamplingParams(options: CallOptions): CallOptions {
  const { temperature: _t, topP: _p, topK: _k, ...rest } = options;
  return rest as CallOptions;
}

/**
 * The Anthropic model, minus the sampling parameters.
 *
 * AI SDK 4.0 sends `temperature: 0` whether or not a caller asked for it, and
 * Claude Opus 5 rejects `temperature` / `top_p` / `top_k` outright — every call
 * came back "`temperature` is deprecated for this model", which the chat stream
 * surfaced as a bare "An error occurred." Stripping them once here beats
 * auditing ~40 call sites, and keeps working for call sites written later.
 *
 * Deliberately hand-rolled rather than `experimental_wrapLanguageModel`: this
 * module would then import from `ai`, and every existing test that mocks that
 * module wholesale (workable's, for one) would hand back an undefined wrapper
 * and silently fall through to the non-LLM path.
 *
 * Steering that used to live in `temperature` belongs in the prompt now.
 */
function claude(id: string): ClaudeModel {
  const model = anthropic(id);
  return {
    ...model,
    doGenerate: (options) => model.doGenerate(withoutSamplingParams(options)),
    doStream: (options) => model.doStream(withoutSamplingParams(options)),
  };
}

/**
 * The one place that decides which LLM Cortex talks to.
 *
 * Generation runs on Claude. Embeddings do NOT: Anthropic ships no embedding
 * endpoint, and the pgvector indexes in infra/supabase are built for the 768
 * dimensions Gemini returns — swapping the embedder would require re-embedding
 * the whole knowledge base. See packages/agent-tools/src/kb/embedder.ts.
 */

/** Conversation, tool calling, long-horizon agent work. */
export const CHAT_MODEL = 'claude-opus-5';

/** Short mechanical calls: titles, classification, ranking passes. */
export const UTILITY_MODEL = 'claude-opus-5';

/**
 * Agent rows written before the migration to Claude still carry Gemini model
 * ids. Map them instead of failing the request — an agent that predates the
 * switch should keep answering, not 404 against a provider we no longer use.
 */
const LEGACY_MODEL_IDS: Record<string, string> = {
  'gemini-2.5-pro': CHAT_MODEL,
  'gemini-3.1-flash-lite': CHAT_MODEL,
};

export function resolveModelId(id?: string | null): string {
  if (!id) return CHAT_MODEL;
  return LEGACY_MODEL_IDS[id] ?? id;
}

/** The model an agent answers with, honouring its configured id. */
export function chatModel(id?: string | null) {
  return claude(resolveModelId(id));
}

/** The model for short internal calls that never face the user directly. */
export function utilityModel() {
  return claude(UTILITY_MODEL);
}

/**
 * Turns extended thinking off for a single call.
 *
 * Claude Opus 5 thinks by default, and `maxTokens` caps thinking AND response
 * text together — so a 20-token budget for "write a 5-word title" would be
 * spent entirely on reasoning and truncate before any answer. Short, shape-
 * constrained calls pass this and a maxTokens with real headroom.
 *
 * Only valid at effort `high` or below (the default); pairing disabled
 * thinking with xhigh/max effort is rejected with a 400.
 *
 * Pass as `experimental_providerMetadata` — this repo is on AI SDK 4.0, where
 * the stable `providerOptions` name does not exist yet.
 */
export const NO_THINKING = {
  anthropic: { thinking: { type: 'disabled' as const } },
} as const;
