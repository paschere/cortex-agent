/**
 * EL PUENTE: la pantalla vive en un iframe con origen nulo y no puede llamar a
 * la API. Cada operación viaja por `postMessage` al host (Cortex), que la
 * reenvía al servidor con la sesión y el rol de quien mira. Aquí no se decide
 * ningún permiso: lo decide el servidor.
 *
 * Mensaje de ida:    { cortex: 1, id, op, args }
 * Mensaje de vuelta: { cortex: 1, id, ok: true, data } | { cortex: 1, id, ok: false, error }
 *
 * Respuesta en dos tiempos (opcional, `upd: true` en el mensaje de ida): el host puede contestar
 * al instante con lo que tiene guardado y, si al refrescar el dato cambió, mandar después
 *   { cortex: 1, update: true, id, data }
 * con el mismo id. `call()` resuelve con la primera respuesta; la segunda se entrega a quien
 * se registró con `withUpdates` (los ganchos de React la usan para volver a pintar).
 * Un host viejo ignora `upd` y un SDK viejo ignora los `update`: nada se rompe.
 */

/** Cuánto se espera la respuesta del host antes de rendirse. */
export const BRIDGE_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
/** Quién espera la segunda respuesta de una llamada, hasta que llegue o venza. */
const updaters = new Map<string, { fn: () => void; timer: ReturnType<typeof setTimeout> }>();
/** El oyente de actualizaciones vigente mientras se emiten llamadas (ver `withUpdates`). */
let scope: (() => void) | null = null;
let seq = 0;
let listening = false;

function onMessage(event: MessageEvent): void {
  // Solo se le cree al host (la ventana que contiene este iframe).
  if (event.source !== window.parent) return;
  const msg = event.data as
    | {
        cortex?: number;
        id?: string;
        ok?: boolean;
        update?: boolean;
        data?: unknown;
        error?: string;
      }
    | null
    | undefined;
  if (!msg || msg.cortex !== 1 || typeof msg.id !== 'string') return;
  if (msg.update === true) {
    // La segunda respuesta de una llamada ya resuelta: se avisa una sola vez.
    const u = updaters.get(msg.id);
    if (!u) return;
    updaters.delete(msg.id);
    clearTimeout(u.timer);
    u.fn();
    return;
  }
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

/** Operaciones lentas (leer un documento con el modelo): esperan más. */
export const SLOW_BRIDGE_TIMEOUT_MS = 75_000;

/**
 * Mientras corre `fn` (de forma síncrona), las llamadas que emita piden respuesta en dos tiempos y
 * `onUpdate` se invoca cuando el host manda el dato fresco. Las llamadas que `fn` haga después de
 * un `await` no quedan cubiertas (siguen funcionando, sin aviso).
 */
export function withUpdates<T>(onUpdate: () => void, fn: () => T): T {
  const prev = scope;
  scope = onUpdate;
  try {
    return fn();
  } finally {
    scope = prev;
  }
}

/** Llama una operación del host y espera su respuesta. `timeoutMs` alarga la espera de las lentas. */
export function call<T = unknown>(
  op: string,
  args?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  if (typeof window === 'undefined' || window.parent === window) {
    return Promise.reject(new Error('Esta pantalla solo funciona dentro de la aplicación.'));
  }
  listen();
  const id = `${Date.now().toString(36)}-${++seq}`;
  const onUpdate = scope;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('La operación tardó demasiado. Intenta de nuevo.'));
    }, opts.timeoutMs ?? BRIDGE_TIMEOUT_MS);
    pending.set(id, {
      resolve: (d) => {
        if (onUpdate) {
          // Espera la segunda respuesta un rato; después se olvida.
          const t = setTimeout(() => updaters.delete(id), BRIDGE_TIMEOUT_MS);
          updaters.set(id, { fn: onUpdate, timer: t });
        }
        (resolve as (d: unknown) => void)(d);
      },
      reject,
      timer,
    });
    // El origen del host no se conoce desde un iframe sin origen: '*' es necesario.
    window.parent.postMessage(
      { cortex: 1, id, op, args: args ?? null, ...(onUpdate ? { upd: true } : {}) },
      '*',
    );
  });
}

/** Solo para pruebas: olvida lo pendiente y quita el oyente. */
export function resetBridge(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  for (const u of updaters.values()) clearTimeout(u.timer);
  updaters.clear();
  scope = null;
  if (listening && typeof window !== 'undefined') window.removeEventListener('message', onMessage);
  listening = false;
  seq = 0;
}
