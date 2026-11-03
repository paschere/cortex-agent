/**
 * EL PUENTE: la pantalla vive en un iframe con origen nulo y no puede llamar a
 * la API. Cada operación viaja por `postMessage` al host (Cortex), que la
 * reenvía al servidor con la sesión y el rol de quien mira. Aquí no se decide
 * ningún permiso: lo decide el servidor.
 *
 * Mensaje de ida:    { cortex: 1, id, op, args }
 * Mensaje de vuelta: { cortex: 1, id, ok: true, data } | { cortex: 1, id, ok: false, error }
 */

/** Cuánto se espera la respuesta del host antes de rendirse. */
export const BRIDGE_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let seq = 0;
let listening = false;

function onMessage(event: MessageEvent): void {
  // Solo se le cree al host (la ventana que contiene este iframe).
  if (event.source !== window.parent) return;
  const msg = event.data as
    | { cortex?: number; id?: string; ok?: boolean; data?: unknown; error?: string }
    | null
    | undefined;
  if (!msg || msg.cortex !== 1 || typeof msg.id !== 'string') return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.data);
  else p.reject(new Error(msg.error || 'No se pudo completar la operación.'));
}

function listen(): void {
  if (listening) return;
  window.addEventListener('message', onMessage);
  listening = true;
}

/** Llama una operación del host y espera su respuesta. */
export function call<T = unknown>(op: string, args?: unknown): Promise<T> {
  if (typeof window === 'undefined' || window.parent === window) {
    return Promise.reject(new Error('Esta pantalla solo funciona dentro de la aplicación.'));
  }
  listen();
  const id = `${Date.now().toString(36)}-${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('La operación tardó demasiado. Intenta de nuevo.'));
    }, BRIDGE_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
    // El origen del host no se conoce desde un iframe sin origen: '*' es necesario.
    window.parent.postMessage({ cortex: 1, id, op, args: args ?? null }, '*');
  });
}

/** Solo para pruebas: olvida lo pendiente y quita el oyente. */
export function resetBridge(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  if (listening && typeof window !== 'undefined') window.removeEventListener('message', onMessage);
  listening = false;
  seq = 0;
}
