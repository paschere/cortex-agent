/**
 * LOS IFRAMES VIVOS — la parte pura.
 *
 * Cada pantalla con código es un iframe. Para que volver a una pantalla sea instantáneo se
 * mantienen montados (ocultos) los de las últimas `MAX_LIVE_FRAMES` pantallas visitadas de la
 * MISMA app. Aquí solo está la regla de qué se conserva y qué se descarta; el montaje real está
 * en `code-frame-pool.ts` y `CodeFrameHost.tsx`.
 *
 *  - Orden LRU: `entries` va de la menos a la más reciente; la activa siempre es la última.
 *  - Volver a una pantalla con la MISMA dirección del marco reusa el iframe (no se recarga).
 *  - Si la dirección cambia (otros parámetros de `nav.go` → prefill, o una compilación de vista
 *    previa distinta) esa pantalla se recarga: entra una entrada nueva y la vieja se descarta.
 *  - Si cambia el contexto (compilación publicada, persona/rol, «ver como…») se descarta TODO:
 *    un iframe viejo seguiría hablando con el rol de antes.
 */

export const MAX_LIVE_FRAMES = 4;

export interface FrameSpec {
  screen: string;
  /** La dirección completa del marco (con el prefill y la compilación de vista previa). */
  src: string;
}

export interface PoolEntry extends FrameSpec {
  /** Único por montaje: `<pantalla>#<n>`. Es la `key` de React y el nombre del marco ante el canal. */
  id: string;
}

export interface PoolState {
  /** Compilación + persona/rol + «ver como…»: si cambia, nada de lo vivo vale. */
  ctx: string;
  seq: number;
  /** De la menos a la más reciente. */
  entries: PoolEntry[];
}

export const emptyPool = (ctx = ''): PoolState => ({ ctx, seq: 0, entries: [] });

export interface Activation {
  state: PoolState;
  /** La entrada activa. */
  active: PoolEntry;
  /** Lo que sale del conjunto (hay que apagarlo: cerrar suscripciones, soltar el iframe). */
  evicted: PoolEntry[];
}

/** Marca `spec` como la pantalla a la vista. */
export function activate(
  state: PoolState,
  spec: FrameSpec,
  ctx: string,
  max: number = MAX_LIVE_FRAMES,
): Activation {
  const evicted: PoolEntry[] = [];
  let base = state;
  if (state.ctx !== ctx) {
    evicted.push(...state.entries);
    base = { ctx, seq: state.seq, entries: [] };
  }
  const same = base.entries.find((e) => e.screen === spec.screen);
  let active: PoolEntry;
  let rest = base.entries.filter((e) => e.screen !== spec.screen);
  let seq = base.seq;
  if (same && same.src === spec.src) {
    active = same;
  } else {
    if (same) evicted.push(same);
    seq += 1;
    active = { ...spec, id: `${spec.screen}#${seq}` };
  }
  rest = [...rest, active];
  while (rest.length > Math.max(1, max)) {
    const out = rest.shift();
    if (out) evicted.push(out);
  }
  return { state: { ctx, seq, entries: rest }, active, evicted };
}

/** Quita una entrada (por ejemplo, el iframe falló y se descarta). */
export function drop(state: PoolState, id: string): PoolState {
  return { ...state, entries: state.entries.filter((e) => e.id !== id) };
}

/** El contexto de un marco: lo que, si cambia, obliga a soltar los iframes vivos. */
export function poolContext(parts: {
  appId: string;
  buildId?: string;
  scope: string;
  como?: string;
}): string {
  return [parts.appId, parts.buildId ?? '', parts.scope, parts.como ?? ''].join('\u0000');
}
