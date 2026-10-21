import { createAnthropic } from '@ai-sdk/anthropic';
import { type LanguageModelV1, type LanguageModelV1Middleware, wrapLanguageModel } from 'ai';

/**
 * Three things have to be fixed on the wire, and none can be expressed through
 * the provider, so they all happen in one custom `fetch`.
 *
 * SAMPLING PARAMETERS. AI SDK 4 sends `temperature` whether or not a caller
 * asked for it, and the Claude 5 family rejects `temperature` / `top_p` /
 * `top_k` outright (Haiku 5.5 only accepts the defaults). Every call came back
 * "`temperature` is deprecated for this model", which the chat stream surfaced
 * as a bare "An error occurred."
 *
 * THINKING. The pinned provider predates adaptive thinking: it only knows
 * `thinking: {type: "enabled", budgetTokens}` and *requires* the budget, which
 * every current model rejects with a 400. So the body is rewritten here, and the
 * rewrite is PER MODEL because the family changed what `thinking` may say:
 *
 *   Sonnet 5.5   `disabled` is a 400. "No thinking" is `between_tools` (the
 *                lowest setting: no extended thinking, short progress notes come
 *                back as thinking blocks), legal only at effort `high` or below
 *                and with no other field inside `thinking`.
 *   Opus 5.5     thinking is ALWAYS on: `disabled` is a 400 at every effort. The
 *                lever is `effort`, so "quiet" means adaptive + low effort.
 *   Haiku 5.5    adaptive by default; `disabled` still legal but only at effort
 *                `high` or below. No `budget_tokens`.
 *   Sonnet 5 /   (legacy ids, only reachable if something bypasses
 *   Opus 5       `resolveModelId`) the old spellings.
 *   anything     `thinking` and `effort` removed (Haiku 4.5 and unknowns).
 *   else
 *
 * EFFORT is explicit on every call, never the API default: the levels were
 * recalibrated with 5.5 (Opus 5.5 defaults to `medium`, Sonnet 5.5 to `high`,
 * Haiku 5.5 to `medium`), so leaving it out would change cost and latency with
 * the model id.
 *
 * FORCED TOOL CHOICE. `generateObject` on this provider is a forced tool call
 * (`tool_choice: {type:'tool'}`, see structured.ts). Sonnet 5.5 and Opus 5.5
 * answer that with a 400. There the choice becomes `auto`, the system prompt
 * names the tool to call, and a response that came back without a tool call is
 * retried once. Haiku 5.5 still accepts the forced form, so it is left alone.
 *
 * Rewriting request bodies is a liberty, so it is confined to this file and
 * these fields.
 *
 * HISTORY STAYS APPEND-ONLY. Thinking blocks are bound to the model and to the
 * conversation prefix (preserved thinking): editing `system`, `tools` or an
 * earlier message after a block was produced is a 400 on new accounts. Nothing
 * here edits history — the rewrite touches top-level fields and the LAST turn's
 * cache marks only — and the chat route never re-sends thinking across turns
 * (history is rebuilt from stored text).
 */
export type ThinkingMode = 'summarized' | 'off';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Lo que el envoltorio de red le cuenta a quien quiera saberlo. */
export type ModelEvent =
  | { type: 'refusal'; model: string; category?: string }
  | { type: 'retry'; reason: 'forced-tool' | 'refusal-fallback'; model: string };
export type ModelObserver = (event: ModelEvent) => void;

export interface RewriteOptions {
  mode: ThinkingMode;
  effort?: Effort;
  /** Marcar puntos de caché. Falso en llamadas de un solo tiro (nadie las relee). */
  cache?: boolean;
}

export type ModelFamily = 'sonnet-5-5' | 'opus-5-5' | 'haiku-5-5' | 'legacy-5' | 'older';

export function modelFamily(model: string | undefined): ModelFamily {
  const id = (model ?? '').includes('/')
    ? ((model as string).split('/').pop() ?? '')
    : (model ?? '');
  if (id.startsWith('claude-sonnet-5-5')) return 'sonnet-5-5';
  if (id.startsWith('claude-opus-5-5')) return 'opus-5-5';
  if (id.startsWith('claude-haiku-5-5')) return 'haiku-5-5';
  if (/^claude-(sonnet|opus)-5(-\d{8})?$/.test(id)) return 'legacy-5';
  return 'older'; // Haiku 4.5 y lo desconocido
}

const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
/** `between_tools` y `disabled` sólo admiten `high` o menos. */
function atMostHigh(effort: Effort): Effort {
  return EFFORT_RANK[effort] > EFFORT_RANK.high ? 'high' : effort;
}

/** Con pensamiento adaptativo, el pensar cuenta contra `max_tokens`. */
const THINKING_TOKEN_FLOOR = 16_000;

function setEffort(body: Record<string, unknown>, effort: Effort): void {
  body.output_config = { ...(body.output_config as object | undefined), effort };
}

function raiseMaxTokens(body: Record<string, unknown>): void {
  const cur = typeof body.max_tokens === 'number' ? body.max_tokens : 0;
  if (cur < THINKING_TOKEN_FLOOR) body.max_tokens = THINKING_TOKEN_FLOOR;
}

/**
 * `tool_choice` forzado → `auto`, con la instrucción en el system.
 * Devuelve true si había que reescribirlo (el llamador reintenta si el modelo
 * no llamó a la herramienta).
 */
export function forcedToolToAuto(body: Record<string, unknown>): boolean {
  const choice = body.tool_choice as { type?: string; name?: string } | undefined;
  if (!choice || (choice.type !== 'any' && choice.type !== 'tool')) return false;
  body.tool_choice = { type: 'auto' };
  const note =
    choice.type === 'tool' && choice.name
      ? `Responde llamando a la herramienta «${choice.name}». No escribas texto fuera de la llamada.`
      : 'Responde llamando a una de las herramientas disponibles. No escribas texto fuera de la llamada.';
  const system = body.system;
  if (typeof system === 'string' && system.length > 0) body.system = `${system}\n\n${note}`;
  else if (Array.isArray(system) && system.length > 0)
    body.system = [...system, { type: 'text', text: note }];
  else body.system = note;
  return true;
}

/**
 * El cuerpo reescrito para el modelo al que va. Puro: lo prueba un test por
 * familia. Devuelve si hubo que desforzar la herramienta.
 */
export function rewriteBody(
  body: Record<string, unknown>,
  opts: RewriteOptions,
): { forcedRewritten: boolean } {
  body.temperature = undefined;
  body.top_p = undefined;
  body.top_k = undefined;
  for (const key of ['temperature', 'top_p', 'top_k']) delete body[key];

  const family = modelFamily(body.model as string | undefined);
  const effort = opts.effort ?? 'medium';
  let forcedRewritten = false;

  switch (family) {
    case 'sonnet-5-5': {
      forcedRewritten = forcedToolToAuto(body);
      if (opts.mode === 'summarized') {
        body.thinking = { type: 'adaptive', display: 'summarized' };
        setEffort(body, effort);
        raiseMaxTokens(body);
      } else {
        // El «sin pensar» de esta familia. Nada más dentro de `thinking`.
        body.thinking = { type: 'between_tools' };
        setEffort(body, atMostHigh(effort));
      }
      break;
    }
    case 'opus-5-5': {
      forcedRewritten = forcedToolToAuto(body);
      // Siempre piensa. `summarized` aun en el modo callado: con la pantalla
      // omitida el bloque llega sin texto y sólo con firma, y el parser del
      // proveedor no lo espera (ver `reasoningSignatureGuard`).
      body.thinking = { type: 'adaptive', display: 'summarized' };
      setEffort(body, opts.mode === 'off' ? atMostHigh(effort) : effort);
      raiseMaxTokens(body);
      break;
    }
    case 'haiku-5-5': {
      // Acepta la herramienta forzada: no se toca `tool_choice`.
      if (opts.mode === 'summarized') {
        body.thinking = { type: 'adaptive', display: 'summarized' };
        setEffort(body, effort);
        raiseMaxTokens(body);
      } else {
        body.thinking = { type: 'disabled' };
        setEffort(body, atMostHigh(effort));
      }
      break;
    }
    case 'legacy-5': {
      if (opts.mode === 'summarized') {
        body.thinking = { type: 'adaptive', display: 'summarized' };
        setEffort(body, 'max');
      } else {
        body.thinking = { type: 'disabled' };
      }
      break;
    }
    default: {
      // Haiku 4.5 y lo desconocido: ni `thinking` ni `effort` (4.x lo da por
      // omisión y `effort` le da 400). `output_config` se conserva por si lleva
      // `format`. Sin marca de caché: su prefijo mínimo es de 4 096 tokens.
      delete body.thinking;
      const outputConfig = body.output_config;
      if (outputConfig && typeof outputConfig === 'object') {
        delete (outputConfig as Record<string, unknown>).effort;
        if (Object.keys(outputConfig as Record<string, unknown>).length === 0) {
          delete body.output_config;
        }
      }
      return { forcedRewritten: false };
    }
  }

  if (opts.cache !== false) {
    markCacheBreakpoint(body);
    markToolLoopTail(body);
  }
  return { forcedRewritten };
}

function hasToolUse(json: unknown): boolean {
  const content = (json as { content?: unknown } | null)?.content;
  return (
    Array.isArray(content) &&
    content.some((b) => (b as { type?: string } | null)?.type === 'tool_use')
  );
}

/**
 * El `fetch` de un proveedor: reescribe el cuerpo y mira la respuesta.
 *
 *  - Herramienta forzada que se volvió `auto` y el modelo no la llamó: un
 *    reintento.
 *  - `stop_reason: "refusal"` (los clasificadores de la 5.5; Haiku 5.5 no tiene
 *    reserva del lado del servidor): se avisa al observador y, si el proveedor
 *    lo pidió (`refusalFallback`), la MISMA petición se reenvía a ese modelo
 *    (Sonnet 5.5). Sólo en respuestas sin streaming; en streaming sólo se
 *    avisa y decide quien llama (la ruta del chat).
 */
export function makeFetch(
  opts: RewriteOptions & {
    observe?: ModelObserver;
    /** Modelo al que reintentar un refusal. */
    refusalFallback?: string;
  },
) {
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    if (typeof init?.body !== 'string') return fetch(input, init);

    let original: Record<string, unknown>;
    try {
      original = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      // Not JSON we understand — send it untouched rather than guess.
      return fetch(input, init);
    }

    const body = structuredClone(original);
    const { forcedRewritten } = rewriteBody(body, opts);
    const send = (b: Record<string, unknown>) => fetch(input, { ...init, body: JSON.stringify(b) });
    const model = String(body.model ?? '');

    let res = await send(body);
    if (!res.ok) return res;

    if (body.stream === true) {
      return opts.observe ? watchStreamForRefusal(res, model, opts.observe) : res;
    }

    // Respuesta completa: se mira una copia y se devuelve la original.
    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.clone().json()) as Record<string, unknown>;
    } catch {
      return res;
    }

    if (json?.stop_reason === 'refusal') {
      opts.observe?.({
        type: 'refusal',
        model,
        category: (json.stop_details as { category?: string } | undefined)?.category,
      });
      if (opts.refusalFallback && opts.refusalFallback !== original.model) {
        const retry = structuredClone(original);
        retry.model = opts.refusalFallback;
        // El mismo trabajo en Sonnet 5.5, con su propia forma de «sin pensar».
        rewriteBody(retry, { mode: 'off', effort: 'medium', cache: false });
        opts.observe?.({ type: 'retry', reason: 'refusal-fallback', model: opts.refusalFallback });
        return send(retry);
      }
      return res;
    }

    if (forcedRewritten && json && json.stop_reason !== 'max_tokens' && !hasToolUse(json)) {
      opts.observe?.({ type: 'retry', reason: 'forced-tool', model });
      res = await send(body);
    }
    return res;
  };
}

/** Pasa el stream tal cual y avisa si en él viaja `stop_reason: "refusal"`. */
function watchStreamForRefusal(res: Response, model: string, observe: ModelObserver): Response {
  if (!res.body) return res;
  const decoder = new TextDecoder();
  let tail = '';
  let told = false;
  const scan = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (told) return;
      const text = tail + decoder.decode(chunk, { stream: true });
      if (/"stop_reason"\s*:\s*"refusal"/.test(text)) {
        told = true;
        const category = /"category"\s*:\s*"([a-z_]+)"/.exec(text)?.[1];
        observe({ type: 'refusal', model, category });
      }
      tail = text.slice(-64);
    },
  });
  return new Response(res.body.pipeThrough(scan), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * Un bloque de pensamiento sin texto llega como `signature_delta` sin ningún
 * `thinking_delta` antes, y `streamText` (ai 4.3) lo rechaza con «reasoning-
 * signature without reasoning», matando el turno. Pasa con pantalla `omitted`
 * o con un pensamiento vacío. Se inserta un delta vacío: el bloque se guarda
 * con texto '' y su firma, y se reenvía tal cual — que es lo que pide la API
 * («conserva el bloque aunque su texto esté vacío»).
 */
export const reasoningSignatureGuard: LanguageModelV1Middleware = {
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    let open = false;
    const guardedStream = stream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (chunk.type === 'reasoning') open = true;
          else if (chunk.type === 'reasoning-signature') {
            if (!open) controller.enqueue({ type: 'reasoning', textDelta: '' });
            open = false;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return { stream: guardedStream, ...rest };
  },
};

function guarded(model: LanguageModelV1): LanguageModelV1 {
  return wrapLanguageModel({ model, middleware: reasoningSignatureGuard });
}

/**
 * SEGUNDO PUNTO DE CACHÉ, SÓLO DENTRO DEL BUCLE DE HERRAMIENTAS.
 *
 * Un turno de varios pasos reenvía en cada paso todo lo anterior (la pregunta,
 * las llamadas y sus resultados, hasta 24 000 caracteres cada uno) a precio
 * completo, porque el único punto de caché termina en el `system`. Medido en
 * producción: una conversación de ~6 turnos sumó 1,7 M de tokens de entrada.
 *
 * Cuando el último mensaje trae `tool_result` —es decir, ya estamos en el
 * paso 2 o posterior—, marcar su último bloque hace que el paso siguiente LEA
 * ese prefijo al 10 % en vez de pagarlo entero. En el primer paso del turno no
 * se marca (no hay resultados), así que un turno de un solo paso no paga
 * ninguna escritura de más. Son 2 de los 4 puntos que admite la API.
 */
export function markToolLoopTail(body: Record<string, unknown>): void {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;
  const last = messages[messages.length - 1] as { role?: unknown; content?: unknown };
  if (last?.role !== 'user' || !Array.isArray(last.content) || last.content.length === 0) return;
  const blocks = last.content as Record<string, unknown>[];
  if (!blocks.some((b) => b && typeof b === 'object' && b.type === 'tool_result')) return;
  const tail = blocks[blocks.length - 1];
  if (tail && typeof tail === 'object') tail.cache_control = { type: 'ephemeral' };
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
 * THE CATCH, AND IT IS SPECIFIC TO THIS PRODUCT — NOW HANDLED UPSTREAM. Cortex
 * picks tools per turn by semantic relevance, so the `tools` array used to move
 * between turns of one conversation and drag the whole prefix with it: medido
 * en turn_latencies (7 días), 384k tokens escritos al caché contra 212k leídos.
 * La lista es hoy ESTABLE Y CRECIENTE dentro de una conversación — lo ya
 * ofrecido conserva su posición, lo nuevo entra por el final — ver
 * tool-selection/sticky.ts. Por la misma razón el chat ya no mete bloques
 * volátiles (fragmentos de RAG, timestamps de pantalla) en `system`: viajan en
 * el último mensaje, después de esta marca. Si `cache_read_input_tokens` vuelve
 * a caer por debajo de las escrituras, lo primero que hay que sospechar es un
 * byte nuevo que cambie por turno delante del breakpoint.
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
 * WHAT THE MEASUREMENT SHOWED (Sonnet 5). The reasoning only appeared at
 * `effort: max`, and `max` did not merely cost more: with a 3 000-token ceiling
 * thinking consumed the ENTIRE budget and the answer came back EMPTY, while the
 * same question with thinking disabled answered in 749 tokens. 85 % of the 5,7 s
 * before the first visible character was the model thinking.
 *
 * WHAT CHANGES WITH SONNET 5.5. Efforts were recalibrated, so `max` is no
 * longer the only way to see it think: with `visible` the chat sends adaptive
 * thinking + `display: "summarized"` at the chat's own effort (`medium`), and the
 * guide says from `medium` up the model thinks briefly before almost every
 * reply. That is the switch to flip when the panel is wanted back — it is no
 * longer a `max` bet. Kept OFF until measured on the 5.5 traffic: the "off"
 * spelling (`between_tools`) keeps today's latency, and its short progress notes
 * still reach the client as reasoning, which is the same place the panel draws.
 *
 * WHY THE SWITCH STAYS. Nothing about the shape was wrong; the model's current
 * behaviour is what decides. One boolean, not a rewrite. `chatModel()` keeps its
 * signature either way.
 */
const REASONING_VISIBLE = false;

/**
 * El esfuerzo de cada oficio. Explícito siempre (ver el encabezado): los niveles
 * se recalibraron con la 5.5 y el valor por omisión cambia de un modelo a otro.
 *
 *   chat       `medium`: la guía lo da para uso de herramientas en varios pasos,
 *              y es lo que Opus 5.5 trae de fábrica.
 *   utility    `medium`: llamadas cortas pero cuyo error se paga caro (ranking de
 *              herramientas, extracción con verificación).
 *   voice      `low`: cada segundo antes de la primera palabra se oye.
 *   research   `medium`: piezas con herramientas; a `low` el modelo salta búsquedas.
 *   simple     `low`: títulos, sugerencias, clasificar, leer un campo.
 */
const EFFORT = {
  chat: 'medium',
  utility: 'medium',
  voice: 'low',
  research: 'medium',
  simple: 'low',
} as const satisfies Record<string, Effort>;

/** Conversation. Reasoning shown only when `REASONING_VISIBLE` says so. */
const CHAT_OPTIONS: RewriteOptions = {
  mode: REASONING_VISIBLE ? 'summarized' : 'off',
  effort: EFFORT.chat,
};
const thinkingProvider = createAnthropic({ fetch: makeFetch(CHAT_OPTIONS) });

/** Short internal calls: no reasoning, all the budget on the answer. */
const quietProvider = createAnthropic({
  fetch: makeFetch({ mode: 'off', effort: EFFORT.utility }),
});

/** Voz: lo más bajo que admite el modelo. */
const voiceProvider = createAnthropic({ fetch: makeFetch({ mode: 'off', effort: EFFORT.voice }) });

/** Investigación en paralelo: Haiku 5.5 con herramientas. */
const researchProvider = createAnthropic({
  fetch: makeFetch({ mode: 'off', effort: EFFORT.research }),
});

/**
 * El oficio de las tareas SIMPLES, en Haiku 5.5: sin pensar, esfuerzo `low`, sin
 * marcas de caché (son llamadas de un solo tiro que nadie relee: una escritura
 * al 1,25× que no se lee es plata perdida) y con la reserva que Haiku 5.5 no
 * trae del lado del servidor — un `refusal` se reintenta en Sonnet 5.5.
 */
const simpleProvider = createAnthropic({
  fetch: makeFetch({
    mode: 'off',
    effort: EFFORT.simple,
    cache: false,
    refusalFallback: 'claude-sonnet-5-5',
  }),
});

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
 * Sonnet 5.5 rather than Opus 5.5: same 1M context, the same price per token
 * as Sonnet 5 ($2/$10), and half the cost of Opus on a product whose whole
 * shape is many tool calls per turn.
 */
export const CHAT_MODEL = 'claude-sonnet-5-5';

/**
 * The heavy model: long agentic work and agents an admin pointed at Opus.
 * Opus 5.5 ($4/$20), thinking always on, effort set explicitly.
 */
export const HEAVY_MODEL = 'claude-opus-5-5';

/**
 * Short calls that must be RIGHT: ranking passes, verified extraction.
 *
 * Deliberately the same model as the chat rather than something cheaper still.
 * One of these passes ranks which tools the agent is offered, and a worse ranker
 * does not produce a worse sentence — it produces an agent that says it cannot
 * do something it can. The jobs that DO pass the test for a cheaper model are
 * the ones that go through `simpleModel()`.
 */
export const UTILITY_MODEL = 'claude-sonnet-5-5';

/**
 * The model that every simple task runs on, and the arm of the chat experiment.
 * Haiku 5.5: $0,10/$0,50 per MTok up to a 100K-token prompt, $0,50/$2,50 above.
 * 1M context (Haiku 4.5 had 200K, so callers no longer have to hand it a slice,
 * though the follow-ups route still does).
 */
export const FAST_MODEL = 'claude-haiku-5-5';

/** What a refused or failed Haiku turn is retried on. */
export const FALLBACK_MODEL = CHAT_MODEL;

/**
 * Throwaway text nobody waits for, and the ONE place a cheaper model is right.
 *
 * WHY THIS IS NOT `UTILITY_MODEL`. The note above that constant is the rule and
 * it still holds. The exception here is narrow and it is about CONSEQUENCE, not
 * about cost. The only caller is the three follow-up questions under an answer
 * (see the `/api/chat/followups` route). Nothing downstream reads them, they
 * never enter the transcript, and they are generated after the answer has
 * already been delivered — so the worst a bad one can do is sit there being
 * ignored, and the worst a failed call can do is show nothing at all.
 *
 * WHAT IT COSTS. A follow-up call sends roughly 900 input tokens (a little more
 * with the 5.5 tokenizer) and returns about 90: on the order of 0,0001 USD per
 * answer at Haiku 5.5's $0,10/$0,50 — ten times less than it was on Haiku 4.5.
 */
export const SUGGESTION_MODEL = FAST_MODEL;

/**
 * The model for text that is offered, never asserted. Reasoning off, effort
 * `low`, no cache breakpoint, and a refusal retried on Sonnet 5.5.
 */
export function suggestionModel() {
  return guarded(simpleProvider(SUGGESTION_MODEL));
}

/**
 * MIRAR UNA PANTALLA SIN QUE NADIE HAYA PREGUNTADO NADA.
 *
 * El único llamador es `/api/chat/watch`: la vigilancia de una pestaña
 * compartida, que mira un fotograma cuando la pantalla cambió de verdad y casi
 * siempre responde «NADA». Ver apps/web/lib/screen-watch.ts.
 *
 * Pasa la misma prueba que `SUGGESTION_MODEL`: nada río abajo la lee, no entra
 * al expediente de nada, y nadie la está esperando; y el trabajo es de LEER, no
 * de razonar. Cuando se equivoca, se equivoca hacia el silencio: el filtro de
 * `parseWatchVerdict` descarta todo lo que no venga en el formato exacto.
 *
 * QUÉ CUESTA. US$0,10 por millón de tokens de entrada (con el tokenizador de la
 * 5.5 un fotograma de 1280×720 son ~1 600 tokens): ~0,0003 USD por mirada.
 */
export const WATCH_MODEL = FAST_MODEL;

/** El modelo que mira una pantalla compartida y casi siempre calla. */
export function watchModel() {
  return guarded(simpleProvider(WATCH_MODEL));
}

/**
 * Tareas SIMPLES con modelo propio (Haiku 5.5): títulos, sugerencias, clasificar,
 * leer un campo de un documento o una foto, extracciones que luego se verifican
 * contra el texto, resúmenes de un par de líneas. La prueba es la de
 * `SUGGESTION_MODEL` ampliada: el trabajo es corto, el resultado se valida o es
 * ignorable, y un fallo no deja a un agente diciendo que no puede algo que sí.
 *
 * Un `refusal` de Haiku (no tiene reserva del lado del servidor) se reintenta
 * solo en Sonnet 5.5 si la llamada es de respuesta completa — que lo son todas
 * las de esta lista.
 */
export function simpleModel() {
  return guarded(simpleProvider(FAST_MODEL));
}

/**
 * El modelo de cada sub-ejecución de `research.parallel` (investigación en
 * paralelo). Una pieza es una búsqueda corta con herramientas de LECTURA y una
 * ficha de campos al final, repetida hasta 50 veces: el volumen es de otro
 * orden que un turno de chat, así que por defecto va el modelo rápido (Haiku
 * 5.5, `FAST_MODEL`, con `thinking` apagado). `standard` es el mismo modelo del
 * resto de las llamadas auxiliares, para cuando el criterio de cada pieza
 * importa más que el costo.
 */
export type ResearchTier = 'fast' | 'standard';

export function researchModel(tier: ResearchTier = 'fast') {
  return guarded(tier === 'standard' ? quietProvider(UTILITY_MODEL) : researchProvider(FAST_MODEL));
}

/**
 * Ids guardados antes de cada migración. Las filas de agentes (`agents.default_model`)
 * pueden traer Gemini, Sonnet 5, Opus 5 o Haiku 4.5: se mapean al modelo vigente
 * en vez de fallar o, peor, mandar a la 5.5 la forma de la familia anterior.
 */
const LEGACY_MODEL_IDS: Record<string, string> = {
  'gemini-2.5-pro': CHAT_MODEL,
  'gemini-3.1-flash-lite': CHAT_MODEL,
  'claude-sonnet-5': CHAT_MODEL,
  'claude-opus-5': HEAVY_MODEL,
  'claude-haiku-4-5': FAST_MODEL,
};

export function resolveModelId(id?: string | null): string {
  if (!id) return CHAT_MODEL;
  return LEGACY_MODEL_IDS[id] ?? id;
}

/**
 * The model an agent answers with, honouring its configured id.
 *
 * `observe` (opcional) recibe lo que pasa en la red: un `refusal` y los
 * reintentos. Se pide un proveedor propio sólo cuando se pasa, para que el chat
 * normal comparta el suyo.
 */
export function chatModel(id?: string | null, observe?: ModelObserver) {
  const provider = observe
    ? createAnthropic({ fetch: makeFetch({ ...CHAT_OPTIONS, observe }) })
    : thinkingProvider;
  return guarded(provider(resolveModelId(id)));
}

/**
 * EL MODELO DEL MODO VOZ — Sonnet 5.5 SIN pensar, esfuerzo `low`.
 *
 * Una conversación hablada tiene un reloj que la escrita no tiene: cada segundo
 * antes de la primera palabra se oye como un silencio incómodo, no como «está
 * trabajando». El `thinking` de `chatModel()` —razonar en silencio antes de
 * emitir— es justo lo que no cabe aquí. En la 5.5 «sin pensar» es
 * `between_tools` (ver el encabezado) y el esfuerzo va al mínimo.
 *
 * Sonnet y no Haiku a propósito: el modo voz lleva el catálogo completo de
 * herramientas y el cerebro de la empresa, y orquestar una cadena de tools
 * pide al modelo grande — un asistente veloz que manda el correo equivocado no
 * es más rápido, es peor.
 */
export function voiceModel() {
  return guarded(voiceProvider(CHAT_MODEL));
}

/** The model for short internal calls that never face the user directly. */
export function utilityModel() {
  return guarded(quietProvider(UTILITY_MODEL));
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
