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
type ThinkingMode = 'summarized' | 'off' | 'absent';

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
    } else if (mode === 'off') {
      // Short shape-constrained calls (titles, classification) skip reasoning so
      // the budget goes to the answer. `disabled` is only legal at effort `high`
      // or below, so this branch must not set `max`.
      body.thinking = { type: 'disabled' };
    } else {
      // `absent` — say nothing about thinking at all, and do not mark a cache
      // breakpoint. It exists for the one caller that is NOT a Claude 5 model:
      // Haiku 4.5 (see SUGGESTION_MODEL). Two reasons the other two branches are
      // wrong there, and both are about a 4.x model being handed 5-family shapes:
      //
      //   THINKING. On the 4.x family "no thinking" is the default you get by
      //   omitting the field; `{type:'disabled'}` is a 5-family spelling. Saying
      //   nothing gets the behaviour we want without asserting a shape this
      //   model was never sent before, and a rejected body would surface as a
      //   dead suggestion row rather than an error anybody sees.
      //
      //   THE CACHE MARK. Haiku 4.5 will not cache a prefix under 4 096 tokens —
      //   it just returns `cache_creation_input_tokens: 0`. The follow-up prompt
      //   is a few hundred tokens by construction, so a breakpoint here could
      //   only ever be a no-op or, if the prompt ever grew, a 1,25× write on a
      //   one-shot call that is never read back. Neither is worth having.
      //
      // The sampling parameters are still stripped above. Haiku 4.5 would accept
      // a temperature, but there is no reason to send one AI SDK invented.
      //
      // `effort` is removed rather than the whole of `output_config`: effort is
      // a 4.6-and-later dial and Haiku 4.5 errors on it, but `output_config`
      // also carries structured-output `format`, and a caller that asks for a
      // schema should get one rather than silently get prose.
      delete body.thinking;
      const outputConfig = body.output_config;
      if (outputConfig && typeof outputConfig === 'object') {
        delete (outputConfig as Record<string, unknown>).effort;
        if (Object.keys(outputConfig as Record<string, unknown>).length === 0) {
          delete body.output_config;
        }
      }
      return fetch(input, { ...init, body: JSON.stringify(body) });
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

/**
 * Is the reasoning panel switched on?
 *
 * OFF, and the machinery to turn it back on is deliberately left in place.
 *
 * WHAT THE MEASUREMENT SHOWED. On Sonnet 5 the reasoning only appears at
 * `effort: max` — at the default and at `high` an ordinary operational question
 * ("three trucks, which do I handle first and why") spends zero thinking
 * tokens. But `max` does not merely cost more: measured against the live API on
 * that same question with a 3 000-token ceiling, thinking consumed the ENTIRE
 * budget — 3 000 thinking tokens and an EMPTY answer. The same question with
 * thinking disabled answered completely in 749 tokens.
 *
 * So the choice was never "pay a little extra to see it think". It was: pay
 * four times as much in output tokens — the expensive kind — and risk the
 * reasoning eating the answer's budget on exactly the long, tool-heavy turns
 * this product is made of. The latency measurement points the same way: 85 % of
 * the 5,7 s before the first visible character is the model thinking.
 *
 * WHY THE SWITCH STAYS. Nothing about the shape was wrong; the model's current
 * behaviour at `max` is. A future model, or an effort tier between `high` and
 * `max`, makes this worth turning back on — and then it is one boolean, not a
 * rewrite. `chatModel()` keeps its signature either way.
 */
const REASONING_VISIBLE = false;

/** Conversation. Reasoning shown only when `REASONING_VISIBLE` says so. */
const thinkingProvider = createAnthropic({
  fetch: bodyRewriter(REASONING_VISIBLE ? 'summarized' : 'off'),
});

/** Short internal calls: no reasoning, all the budget on the answer. */
const quietProvider = createAnthropic({ fetch: bodyRewriter('off') });

/** The one caller outside the Claude 5 family. See `suggestionModel()`. */
const cheapProvider = createAnthropic({ fetch: bodyRewriter('absent') });

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
 * Throwaway text nobody waits for, and the ONE place a cheaper model is right.
 *
 * WHY THIS IS NOT `UTILITY_MODEL`. The note above that constant is the rule and
 * it still holds: a worse ranker produces an agent that says it cannot do
 * something it can, and that failure is expensive to notice. The exception here
 * is narrow and it is about CONSEQUENCE, not about cost. The only caller is the
 * three follow-up questions under an answer (see the `/api/chat/followups`
 * route). Nothing downstream reads them, they never enter the transcript, and
 * they are generated after the answer has already been delivered — so the worst
 * a bad one can do is sit there being ignored, and the worst a failed call can
 * do is show nothing at all. That is the whole test for putting work on a
 * cheaper model, and almost nothing else in this product passes it.
 *
 * 200K OF CONTEXT, NOT 1M. Haiku 4.5's window is a fifth of the conversation
 * model's, so the caller must hand it a slice rather than a transcript. It gets
 * the last exchange and nothing else; the route caps what it sends rather than
 * trusting the window.
 *
 * WHAT IT COSTS. $1 per million input tokens and $5 per million output. A
 * follow-up call sends roughly 900 input tokens — the instruction plus a
 * clipped question and answer — and returns about 90: 0,0009 USD in and
 * 0,00045 out, so **about 0,0014 USD per answer**, and 0,0024 at the ceilings
 * the route enforces. That is on the order of six Colombian pesos, and about
 * 14 USD for ten thousand answers in a month.
 *
 * The same call on Sonnet 5 would be roughly three times that at its
 * introductory $3/$10 and five times at the standard $3/$15 — which is a real
 * saving and is still not the argument. The argument is the paragraph above:
 * this is work whose failure mode is a blank strip.
 */
export const SUGGESTION_MODEL = 'claude-haiku-4-5';

/**
 * The model for text that is offered, never asserted. Reasoning is off (by
 * omission — see the `absent` branch), and no cache breakpoint is marked.
 */
export function suggestionModel() {
  return cheapProvider(SUGGESTION_MODEL);
}

/**
 * MIRAR UNA PANTALLA SIN QUE NADIE HAYA PREGUNTADO NADA.
 *
 * El único llamador es `/api/chat/watch`: la vigilancia de una pestaña
 * compartida, que mira un fotograma cuando la pantalla cambió de verdad y casi
 * siempre responde «NADA». Ver apps/web/lib/screen-watch.ts.
 *
 * POR QUÉ EL BARATO, Y POR QUÉ AQUÍ SÍ PASA LA PRUEBA. La regla de
 * `UTILITY_MODEL` sigue en pie: un clasificador peor produce un agente que dice
 * que no puede hacer algo que sí puede, y eso es caro de notar. Esta llamada no
 * es esa. Es la MISMA prueba que pasa `SUGGESTION_MODEL` — nada río abajo la
 * lee, no entra al expediente de nada, y nadie la está esperando —, con dos
 * agravantes que empujan en la misma dirección:
 *
 *   EL VOLUMEN ES DE OTRO ORDEN. Una pregunta con foto ocurre cuando alguien
 *   escribe; una mirada ocurre cuando la pantalla cambia. Un tope de 60 miradas
 *   por sesión sobre Sonnet 5 son ~US$0,22 de imagen por sesión; sobre Haiku 4.5
 *   son ~US$0,07. Multiplicado por cada persona que deje esto encendido una
 *   tarde, la diferencia deja de ser una discusión de centavos.
 *
 *   EL TRABAJO ES DE LEER, NO DE RAZONAR. La pregunta es «¿hay en esta imagen un
 *   error, un vencimiento o un campo mal puesto?». Es reconocimiento de texto
 *   con criterio, no una cadena de herramientas, y es exactamente donde un
 *   modelo pequeño con visión rinde. Cuando se equivoca, se equivoca hacia el
 *   silencio: el filtro de `parseWatchVerdict` descarta todo lo que no venga en
 *   el formato exacto, así que una respuesta confusa no produce un aviso, y un
 *   aviso que no aparece no le cuesta nada a nadie.
 *
 * QUÉ CUESTA. US$1 por millón de tokens de entrada. Un fotograma de 1280×720
 * son 1 229 tokens y el prompt ronda los 400: ~0,0016 USD por mirada, y ~0,10
 * USD si una sesión gasta las 60 miradas del tope. Ese tope es el techo duro y
 * está en el cliente, apagándose solo — ver `WATCH_MAX_LOOKS`.
 */
export const WATCH_MODEL = 'claude-haiku-4-5';

/**
 * El modelo que mira una pantalla compartida y casi siempre calla.
 *
 * Mismo proveedor que `suggestionModel()` y por las mismas dos razones: Haiku
 * 4.5 no es de la familia 5, así que no se le manda `thinking` ni `effort`, y su
 * prompt es demasiado corto para que un punto de caché sea otra cosa que una
 * escritura de 1,25× que nadie vuelve a leer.
 */
export function watchModel() {
  return cheapProvider(WATCH_MODEL);
}

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
