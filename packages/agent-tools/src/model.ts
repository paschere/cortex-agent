import { createAnthropic } from '@ai-sdk/anthropic';

/**
 * Two things have to be fixed on the wire, and neither can be expressed through
 * the provider, so both happen in one custom `fetch`.
 *
 * SAMPLING PARAMETERS. AI SDK 4 sends `temperature` whether or not a caller
 * asked for it, and the Claude 5 family rejects `temperature` / `top_p` /
 * `top_k` outright. Every call came back "`temperature` is deprecated for this
 * model", which the chat stream surfaced as a bare "An error occurred."
 *
 * THINKING. These models think by default but return the reasoning empty unless
 * the request asks for `display: "summarized"`. The pinned provider predates it:
 * it only knows `thinking: {type: "enabled", budgetTokens}` and *requires* the
 * budget — which Opus 5 rejects with a 400, budgets having been replaced by
 * effort. So the provider cannot ask for what we need, and rewriting the body
 * here is the honest way to do it rather than pinning a provider that fights
 * the model.
 *
 * Rewriting request bodies is a liberty, so it is confined to this file and
 * these two fields.
 */
type ThinkingMode = 'summarized' | 'off';

function bodyRewriter(mode: ThinkingMode) {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    if (typeof init?.body !== 'string') return fetch(input, init);

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      // Not JSON we understand — send it untouched rather than guess.
      return fetch(input, init);
    }

    body.temperature = undefined;
    body.top_p = undefined;
    body.top_k = undefined;
    for (const key of ['temperature', 'top_p', 'top_k']) delete body[key];

    if (mode === 'summarized') {
      body.thinking = { type: 'adaptive', display: 'summarized' };
      // `adaptive` decides for itself whether a turn is worth thinking about,
      // and on Sonnet 5 the answer is almost always no: measured against the
      // live API, an ordinary operational question ("three trucks, which do I
      // handle first and why") returned 0 thinking tokens at the default effort
      // and again at `high`, while Opus 5 spent 858 on the same prompt. The
      // reasoning panel would simply have gone quiet, which is the feature this
      // product was explicitly asked to keep.
      //
      // `max` is what actually moves it — the same prompt then spends ~2 355
      // tokens. So the effort is not a performance dial here, it is the switch
      // that decides whether the user sees Cortex think at all.
      body.output_config = { ...(body.output_config as object), effort: 'max' };
    } else {
      // Short shape-constrained calls (titles, classification) skip reasoning so
      // the budget goes to the answer. `disabled` is only legal at effort `high`
      // or below, so this branch must not set `max`.
      body.thinking = { type: 'disabled' };
    }

    markCacheBreakpoint(body);

    return fetch(input, { ...init, body: JSON.stringify(body) });
  };
}

/**
 * Ask Anthropic to cache the static head of the request.
 *
 * WHAT IS BEING PAID FOR TODAY. Every turn resends the system prompt and the
 * full JSON schema of each tool on offer — the biggest fixed cost in a product
 * whose shape is many tool calls per turn, and it is identical from one turn to
 * the next inside a conversation. A cache read is a tenth of the price of a
 * fresh read.
 *
 * WHERE THE BREAKPOINT GOES. The cache is a PREFIX: a hit requires everything
 * before the mark to be byte-identical. Anthropic orders a request `tools` →
 * `system` → `messages`, so one mark at the end of `system` covers both the
 * tool definitions and the instructions, which is the whole static head.
 *
 * THE CATCH, AND IT IS SPECIFIC TO THIS PRODUCT. Cortex picks tools per turn by
 * semantic relevance, so the `tools` array is NOT guaranteed stable — and a
 * changed tool list moves the prefix and misses the cache. Within one
 * conversation the selection usually holds (consecutive questions are about the
 * same thing), so hits are common but not certain. That is still the right
 * trade: a write costs 1.25× and a read 0.1×, so it pays from roughly one hit
 * in three. Where it does not pay is a workspace whose every turn jumps subject
 * — worth watching in `cache_read_input_tokens` before assuming a saving.
 *
 * Messages are deliberately NOT marked. The tail grows every turn, so a mark
 * there would write a new entry each time and read almost none of it back.
 */
function markCacheBreakpoint(body: Record<string, unknown>): void {
  const system = body.system;

  // Anthropic accepts `system` as a plain string, which has nowhere to hang
  // cache_control — so it becomes a one-block array, which is the same prompt.
  if (typeof system === 'string' && system.length > 0) {
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    return;
  }

  // Already blocks: mark the last one, so the mark sits at the end of the head.
  if (Array.isArray(system) && system.length > 0) {
    const last = system[system.length - 1];
    if (last && typeof last === 'object') {
      (last as Record<string, unknown>).cache_control = { type: 'ephemeral' };
    }
    return;
  }

  // No system prompt at all — mark the last tool instead, so the definitions
  // still get cached. Utility calls that carry neither are left alone: there is
  // no head worth caching and a needless write would cost 1.25×.
  const tools = body.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const last = tools[tools.length - 1];
    if (last && typeof last === 'object') {
      (last as Record<string, unknown>).cache_control = { type: 'ephemeral' };
    }
  }
}

/** Conversation: reasoning is asked for, and shown to the user. */
const thinkingProvider = createAnthropic({ fetch: bodyRewriter('summarized') });

/** Short internal calls: no reasoning, all the budget on the answer. */
const quietProvider = createAnthropic({ fetch: bodyRewriter('off') });

/**
 * The one place that decides which LLM Cortex talks to.
 *
 * Generation runs on Claude. Embeddings do not, and cannot: Anthropic ships no
 * embedding endpoint. They run on Voyage at 1024 dimensions — see
 * packages/agent-tools/src/kb/embedder.ts, which is the only place that knows
 * it. Changing embedding provider means re-embedding every chunk, so it is a
 * migration rather than a config change.
 */

/**
 * Conversation, tool calling, long-horizon agent work.
 *
 * Sonnet 5 rather than Opus 5: same 1M context, same adaptive thinking, and
 * roughly half the cost on a product whose whole shape is many tool calls per
 * turn. The reasoning stays visible — `adaptive` + `summarized` is the same
 * contract on both, so nothing above this line changes.
 */
export const CHAT_MODEL = 'claude-sonnet-5';

/**
 * Short mechanical calls: titles, classification, ranking passes.
 *
 * Deliberately the same model rather than something cheaper still. One of these
 * passes ranks which tools the agent is offered, and a worse ranker does not
 * produce a worse sentence — it produces an agent that says it cannot do
 * something it can. That failure already happened once here and is expensive to
 * notice, so the few cents are not worth reclaiming.
 */
export const UTILITY_MODEL = 'claude-sonnet-5';

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
  return thinkingProvider(resolveModelId(id));
}

/** The model for short internal calls that never face the user directly. */
export function utilityModel() {
  return quietProvider(UTILITY_MODEL);
}

/**
 * Kept as a no-op so existing call sites keep compiling.
 *
 * It never worked: the pinned provider does not forward a `disabled` thinking
 * config, so passing this changed nothing on the wire. Whether a call thinks is
 * now decided by which model helper you reach for — `utilityModel()` does not,
 * `chatModel()` does — because that is a property of the job, not of one call.
 *
 * @deprecated Use `utilityModel()` for short calls that should not reason.
 */
export const NO_THINKING = {} as const;
