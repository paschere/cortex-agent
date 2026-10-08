/**
 * EL RELOJ DEL TURNO: CUÁNTO LE QUEDA ANTES DE QUE LA PLATAFORMA LO MATE.
 *
 * ===========================================================================
 * EL FALLO QUE ESTO ARREGLA
 * ===========================================================================
 * En producción (2026-10-08), ocho veces en tres horas: «Vercel Runtime Timeout
 * Error: Task timed out after 300 seconds» en POST /api/chat. Un turno largo —
 * leer una hoja de Google, recorrer una carpeta de Drive, varias herramientas
 * encadenadas con un modelo que piensa— pasaba del límite y Vercel MATABA la
 * función: el stream se cortaba a la mitad, nada se guardaba, y la persona veía
 * «Algo falló…» sin forma de seguir.
 *
 * Nada en la ruta sabía qué hora era. Ahora sí, en tres umbrales:
 *
 *   blando (70 %)  ya no se EMPIEZAN herramientas nuevas: la que se pida
 *                  devuelve «sin tiempo en este turno» y el modelo cierra con un
 *                  resumen y «escríbeme sigue». Lo que ya corre, termina.
 *   duro           (límite − margen) se aborta el turno LIMPIO con nuestra
 *                  señal: el stream cierra, la persona ve una nota y no un
 *                  error, y lo producido se guarda.
 *   plataforma     el `maxDuration` de la ruta. Nunca debería alcanzarse: el
 *                  margen existe para que la persistencia termine antes.
 *
 * `CHAT_TURN_BUDGET_SECONDS` permite acortar el presupuesto sin desplegar (por
 * ejemplo si el plan de Vercel baja de techo). Nunca lo alarga por encima de
 * `CHAT_MAX_DURATION_S`: Vercel mata en ese número, diga lo que diga la variable.
 */

/**
 * Debe coincidir con `export const maxDuration` de app/api/chat/route.ts (Next
 * exige allí un literal, así que no puede importarlo). 800 s es el techo de
 * Vercel Pro con Fluid Compute, el mismo que ya usa app/api/jobs/run.
 */
export const CHAT_MAX_DURATION_S = 800;

/** Fracción del presupuesto a partir de la cual no se empiezan herramientas. */
export const SOFT_RATIO = 0.7;

/** Ninguna herramienta sola puede quedarse con más que esto del turno. */
export const TOOL_MAX_MS = 180_000;

/** Lo mínimo que debe quedar para que valga la pena empezar una herramienta. */
export const TOOL_MIN_START_MS = 10_000;

/**
 * El presupuesto efectivo del turno, en milisegundos. Lee la variable de
 * entorno con desconfianza: cualquier cosa que no sea un número razonable cae
 * al techo, y nada puede pasar del techo ni bajar de un minuto.
 */
export function turnLimitMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CHAT_TURN_BUDGET_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : CHAT_MAX_DURATION_S;
  return Math.round(Math.min(Math.max(seconds, 60), CHAT_MAX_DURATION_S) * 1000);
}

/**
 * El margen entre el corte limpio y el límite: lo que necesita `after()` para
 * guardar la respuesta, la auditoría y las métricas. 7,5 % del presupuesto con
 * piso de 20 s y techo de 60 s.
 */
export function hardMarginMs(limitMs: number): number {
  return Math.min(60_000, Math.max(20_000, Math.round(limitMs * 0.075)));
}

export type InterruptReason = 'deadline' | 'client';

export interface TurnBudget {
  /** Señal para `streamText` y las herramientas: aborta en el corte duro o si el cliente se fue. */
  readonly signal: AbortSignal;
  readonly softAt: number;
  readonly hardAt: number;
  /** Ya no se deben empezar herramientas nuevas. */
  pastSoft(): boolean;
  /** Milisegundos hasta el corte duro (puede ser negativo). */
  msUntilHard(): number;
  /** Por qué se abortó, o `null` si sigue vivo. */
  reason(): InterruptReason | null;
  dispose(): void;
}

export function createTurnBudget(opts: {
  limitMs: number;
  /** Instante de inicio del turno en el reloj de `now` (por defecto Date.now()). */
  startedAt: number;
  /** La señal de la petición: si el cliente cierra, el turno se detiene también. */
  parent?: AbortSignal;
  softRatio?: number;
  marginMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): TurnBudget {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const margin = opts.marginMs ?? hardMarginMs(opts.limitMs);
  const hardAt = opts.startedAt + Math.max(opts.limitMs - margin, 1_000);
  const softAt = opts.startedAt + Math.min(opts.limitMs * (opts.softRatio ?? SOFT_RATIO), hardAt);

  const controller = new AbortController();
  let why: InterruptReason | null = null;
  const abort = (reason: InterruptReason) => {
    if (controller.signal.aborted) return;
    why = reason;
    controller.abort(
      reason === 'deadline'
        ? new DOMException('Se acabó el tiempo del turno', 'TimeoutError')
        : new DOMException('El cliente cerró la conexión', 'AbortError'),
    );
  };

  const timer = setTimer(() => abort('deadline'), Math.max(hardAt - now(), 0));
  const onParentAbort = () => abort('client');
  if (opts.parent?.aborted) onParentAbort();
  else opts.parent?.addEventListener('abort', onParentAbort, { once: true });

  return {
    signal: controller.signal,
    softAt,
    hardAt,
    pastSoft: () => why !== null || now() >= softAt,
    msUntilHard: () => hardAt - now(),
    reason: () => why,
    dispose: () => {
      clearTimer(timer);
      opts.parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** El resultado que recibe el modelo cuando pide una herramienta sin tiempo. */
export function outOfTimeResult(tool: string) {
  return {
    __error: true,
    out_of_time: true,
    tool,
    message:
      'Sin tiempo en este turno: NO ejecuté esta herramienta. No pidas más herramientas. ' +
      'Cierra ya con un resumen breve de lo que hiciste y lo que falta, y dile a la persona ' +
      'que escriba «sigue» para continuar desde aquí.',
  };
}

/** El resultado cuando una herramienta pasa su tope y se deja de esperar. */
export function toolTimedOutResult(tool: string, ms: number) {
  return {
    __error: true,
    timed_out: true,
    tool,
    message:
      `La herramienta tardó más de ${Math.round(ms / 1000)} s y dejé de esperarla; pudo quedar a medias. ` +
      'No la repitas en este turno: resume lo hecho y pide a la persona que escriba «sigue» para retomarla.',
  };
}

/**
 * Corre una herramienta con su propio tope: el menor entre `TOOL_MAX_MS` y lo
 * que le queda al turno. Si no hay tiempo para empezarla, ni la llama. Si se
 * pasa, aborta su señal (las herramientas que la respetan paran) y devuelve un
 * resultado legible en vez de dejar al turno esperando.
 */
export async function runWithinBudget<T>(
  budget: Pick<TurnBudget, 'pastSoft' | 'msUntilHard'>,
  tool: string,
  parentSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  opts: { toolMaxMs?: number } = {},
): Promise<T> {
  const room = budget.msUntilHard() - 2_000;
  if (budget.pastSoft() || room < TOOL_MIN_START_MS) return outOfTimeResult(tool) as T;
  const capMs = Math.min(opts.toolMaxMs ?? TOOL_MAX_MS, room);

  const controller = new AbortController();
  const onParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParent();
  else parentSignal?.addEventListener('abort', onParent, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('La herramienta pasó su tope', 'TimeoutError'));
      resolve(toolTimedOutResult(tool, capMs) as T);
    }, capMs);
  });
  try {
    return await Promise.race([run(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParent);
  }
}
