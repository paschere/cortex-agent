/**
 * AVANCE DE UNA HERRAMIENTA MIENTRAS CORRE.
 *
 * Una herramienta larga (listar una carpeta de Drive, leer una muestra) llama a
 * `ctx.onProgress(línea)`. La ruta del chat convierte esas líneas en
 * anotaciones del mensaje `{ type: 'tool-progress', toolCallId, line, at }` y
 * el chip de la herramienta pinta la última. Son efímeras: no se guardan en la
 * base, sólo viajan por el stream de ese turno.
 */

export const TOOL_PROGRESS_TYPE = 'tool-progress';
export const PROGRESS_MIN_INTERVAL_MS = 750;
export const PROGRESS_MAX_CHARS = 160;

export interface ToolProgressAnnotation {
  type: typeof TOOL_PROGRESS_TYPE;
  toolCallId: string;
  line: string;
  at: number;
}

/** Una sola línea, sin saltos, recortada con «…» si se pasa. */
export function clampProgressLine(line: string, max = PROGRESS_MAX_CHARS): string {
  const flat = line.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Limita la frecuencia de un emisor: pasa la primera línea de inmediato y, si
 * llegan más dentro de la ventana, guarda SIEMPRE la última y la emite cuando
 * la ventana se cierra. `flush()` suelta la pendiente (al terminar la llamada
 * no hay nada que mostrar, así que la ruta usa `cancel()`).
 */
export function createProgressThrottle(
  emit: (line: string) => void,
  opts: {
    intervalMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (h: unknown) => void;
  } = {},
) {
  const interval = opts.intervalMs ?? PROGRESS_MIN_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let lastAt = Number.NEGATIVE_INFINITY;
  let pending: string | null = null;
  let timer: unknown = null;

  const fire = (line: string) => {
    lastAt = now();
    try {
      emit(line);
    } catch {
      // El avance es cosmético: nunca debe tumbar la herramienta.
    }
  };

  return {
    push(raw: string) {
      const line = clampProgressLine(raw);
      if (!line) return;
      const wait = lastAt + interval - now();
      if (wait <= 0 && timer === null) {
        fire(line);
        return;
      }
      pending = line;
      if (timer === null) {
        timer = setTimer(
          () => {
            timer = null;
            const p = pending;
            pending = null;
            if (p !== null) fire(p);
          },
          Math.max(wait, 0),
        );
      }
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
    },
  };
}

/** Última línea de avance por `toolCallId` en las anotaciones de un mensaje. */
export function latestProgress(annotations: unknown): Map<string, string> {
  const out = new Map<string, { line: string; at: number }>();
  if (!Array.isArray(annotations)) return new Map();
  for (const a of annotations) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    if (r.type !== TOOL_PROGRESS_TYPE) continue;
    if (typeof r.toolCallId !== 'string' || typeof r.line !== 'string') continue;
    const at = typeof r.at === 'number' ? r.at : 0;
    const prev = out.get(r.toolCallId);
    if (!prev || at >= prev.at) out.set(r.toolCallId, { line: r.line, at });
  }
  return new Map([...out].map(([k, v]) => [k, v.line]));
}
