/**
 * LA COLA SIN INTERNET DE LOS FORMULARIOS DE VISTA — la lógica pura.
 *
 * Un registro que no pudo salir (sin señal) se guarda en el teléfono y se
 * reintenta solo. Aquí vive lo que se puede probar sin navegador: el orden, la
 * idempotencia (un `clientId` por envío, el servidor ignora el repetido), el
 * reintento con espera y qué hacer con lo que el servidor rechaza. El
 * almacenamiento (IndexedDB) está en `offline-store.ts` y el reloj de
 * reintentos en `useFormQueue.ts`.
 */

export interface QueuedSubmission {
  /** Id de cliente: el mismo en cada reintento; el servidor no duplica por él. */
  clientId: string;
  /** Vista + bloque: la cola de un formulario no se mezcla con la de otro. */
  key: string;
  blockId: string;
  values: Record<string, string>;
  createdAt: number;
  /** Intentos fallidos hasta ahora. */
  attempts: number;
  /** No reintentar antes de este momento (ms epoch). */
  nextAt: number;
  /** Rechazado por el servidor (datos inválidos): no se reintenta, se muestra. */
  rejected?: string;
}

export type SendOutcome =
  | { kind: 'ok' }
  /** Sin red o error del servidor: se reintenta y se deja de procesar (orden). */
  | { kind: 'retry' }
  /** El servidor dijo que no por los datos: reintentar no sirve. */
  | { kind: 'rejected'; error: string };

export const RETRY_EVERY_MS = 30_000;
const MAX_BACKOFF_MS = 10 * 60_000;

/** Espera tras `attempts` fallos: 30 s, 1 min, 2 min, 4 min… con tope de 10. */
export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(RETRY_EVERY_MS * 2 ** Math.min(attempts - 1, 6), MAX_BACKOFF_MS);
}

export function newClientId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** Un registro nuevo para la cola. */
export function queueItem(input: {
  clientId: string;
  key: string;
  blockId: string;
  values: Record<string, string>;
  now: number;
}): QueuedSubmission {
  return {
    clientId: input.clientId,
    key: input.key,
    blockId: input.blockId,
    values: input.values,
    createdAt: input.now,
    attempts: 0,
    nextAt: input.now,
  };
}

/** Agrega sin duplicar: el mismo `clientId` ya en la cola no se vuelve a meter. */
export function enqueue(queue: QueuedSubmission[], item: QueuedSubmission): QueuedSubmission[] {
  if (queue.some((q) => q.clientId === item.clientId)) return queue;
  return [...queue, item].sort((a, b) => a.createdAt - b.createdAt);
}

/** Lo que falta por enviar (sin los rechazados), en orden de creación. */
export function pendingOf(queue: QueuedSubmission[], key?: string): QueuedSubmission[] {
  return queue
    .filter((q) => !q.rejected && (key === undefined || q.key === key))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export interface DrainResult {
  queue: QueuedSubmission[];
  /** `clientId` de los que salieron. */
  sent: string[];
}

/**
 * Procesa la cola EN ORDEN. Un envío «ok» sale de la cola; uno «rejected» queda
 * marcado y no frena a los demás; un «retry» (sin red, error del servidor)
 * guarda el intento, fija la próxima hora y DETIENE el proceso para no
 * adelantar los registros de después. `force` ignora la espera (volvió la
 * señal, se abrió la vista).
 */
export async function drainQueue(
  queue: QueuedSubmission[],
  send: (item: QueuedSubmission) => Promise<SendOutcome>,
  opts: { now: number; force?: boolean; key?: string },
): Promise<DrainResult> {
  let next = [...queue].sort((a, b) => a.createdAt - b.createdAt);
  const sent: string[] = [];
  for (const item of next) {
    if (item.rejected) continue;
    if (opts.key !== undefined && item.key !== opts.key) continue;
    if (!opts.force && item.nextAt > opts.now) break;
    const out = await send(item);
    if (out.kind === 'ok') {
      sent.push(item.clientId);
      next = next.filter((q) => q.clientId !== item.clientId);
    } else if (out.kind === 'rejected') {
      next = next.map((q) => (q.clientId === item.clientId ? { ...q, rejected: out.error } : q));
    } else {
      const attempts = item.attempts + 1;
      next = next.map((q) =>
        q.clientId === item.clientId
          ? { ...q, attempts, nextAt: opts.now + backoffMs(attempts) }
          : q,
      );
      break;
    }
  }
  return { queue: next, sent };
}

/**
 * ¿Este fallo es de red (se guarda en la cola) o una respuesta del servidor
 * (se muestra)? Sin conexión o un 5xx/429 se guardan; un 4xx de datos no.
 */
export function isOfflineFailure(input: {
  online: boolean;
  status?: number;
  thrown?: boolean;
}): boolean {
  if (!input.online) return true;
  if (input.thrown) return true;
  if (input.status === undefined) return false;
  return input.status >= 500 || input.status === 429 || input.status === 408;
}

// ---------------------------------------------------------------------------
// «Mis últimos envíos» y el token de edición (localStorage)
// ---------------------------------------------------------------------------

export interface SentRecord {
  rowId: string;
  at: number;
  /** Primer valor legible, para reconocer el envío en la lista. */
  summary: string;
  values: Record<string, string>;
  /** Para corregir sin sesión (enlace público). */
  editToken: string | null;
  /** Hasta cuándo se puede corregir (ms epoch); null = no se corrige. */
  editUntil: number | null;
}

export const SENT_KEEP = 8;

/** Agrega un envío al principio y deja los `SENT_KEEP` más recientes, sin repetir fila. */
export function pushSent(list: SentRecord[], rec: SentRecord): SentRecord[] {
  return [rec, ...list.filter((r) => r.rowId !== rec.rowId)].slice(0, SENT_KEEP);
}

/** ¿Se puede corregir todavía? */
export function canCorrect(rec: SentRecord, now: number): boolean {
  return rec.editUntil !== null && now < rec.editUntil;
}

/** Minutos que quedan, redondeados hacia arriba (para «Corregir (8 min)»). */
export function minutesLeft(rec: SentRecord, now: number): number {
  return rec.editUntil === null ? 0 : Math.max(0, Math.ceil((rec.editUntil - now) / 60_000));
}
