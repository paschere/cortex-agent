/**
 * EL REPARTIDOR DE `research.parallel`: concurrencia acotada y paradas limpias.
 *
 * Puro (sin red, sin reloj propio) para probarlo con piezas falsas. Reglas:
 *   - nunca hay más de `concurrency` piezas en vuelo;
 *   - antes de EMPEZAR cada pieza se pregunta a `shouldStop()`; si devuelve un
 *     motivo, no se empiezan más (las que ya corren terminan) y las que no
 *     alcanzaron a empezar quedan en `notStarted`, en su orden original;
 *   - un trabajador que lanza no tumba al resto: su error queda en esa pieza.
 */

export type PoolStopReason = 'tiempo' | 'presupuesto' | 'cancelado';

export interface PoolSettled<R> {
  index: number;
  ok: boolean;
  value?: R;
  error?: unknown;
}

export interface PoolResult<R> {
  /** En el orden original de los elementos. Sólo las piezas que empezaron. */
  settled: PoolSettled<R>[];
  /** Índices que no empezaron, ascendentes. */
  notStarted: number[];
  stopReason: PoolStopReason | null;
}

export async function runPool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  opts: {
    concurrency: number;
    shouldStop?: () => PoolStopReason | null;
    onSettled?: (s: PoolSettled<R>, done: number) => void;
  },
): Promise<PoolResult<R>> {
  const limit = Math.max(1, Math.min(Math.floor(opts.concurrency) || 1, items.length || 1));
  const settled: PoolSettled<R>[] = [];
  let next = 0;
  let stopReason: PoolStopReason | null = null;
  let done = 0;

  const lane = async () => {
    for (;;) {
      if (stopReason === null) stopReason = opts.shouldStop?.() ?? null;
      if (stopReason !== null || next >= items.length) return;
      const index = next++;
      let s: PoolSettled<R>;
      try {
        s = { index, ok: true, value: await worker(items[index] as T, index) };
      } catch (error) {
        s = { index, ok: false, error };
      }
      settled.push(s);
      done++;
      try {
        opts.onSettled?.(s, done);
      } catch {
        // El avance es cosmético.
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, lane));

  settled.sort((a, b) => a.index - b.index);
  const started = new Set(settled.map((s) => s.index));
  const notStarted: number[] = [];
  for (let i = 0; i < items.length; i++) if (!started.has(i)) notStarted.push(i);
  return { settled, notStarted, stopReason };
}
