/**
 * HACER VARIAS COSAS A LA VEZ, SIN PASARSE.
 *
 * Recorrer una carpeta de Drive de miles de archivos pidiendo una carpeta tras
 * otra tarda minutos (cada llamada espera a la anterior); pedirlas todas de
 * golpe satura la cuota de Drive. `mapPool` corre `fn` sobre los elementos con
 * como mucho `limit` en vuelo y devuelve los resultados EN EL ORDEN de entrada,
 * no en el de llegada: lo que se arma después es el mismo sin importar cuál
 * respuesta tardó menos.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/**
 * Una señal que se cancela a los `ms` o cuando se cancela `parent`, lo que pase
 * primero. `done()` suelta el temporizador y el oyente (llámalo en un finally).
 */
export function timeoutSignal(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException('Se acabó el tiempo.', 'TimeoutError')),
    Math.max(1, ms),
  );
  const onParent = () => ctrl.abort(parent?.reason);
  if (parent?.aborted) onParent();
  else parent?.addEventListener('abort', onParent, { once: true });
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParent);
    },
  };
}
