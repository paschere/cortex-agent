/**
 * LA COLA SIN SEÑAL DE TODA UNA APP — la lógica pura.
 *
 * `lib/views/offline-queue.ts` ya guarda los FORMULARIOS que no salieron. Una
 * app de operación hace más cosas con el teléfono en la mano: corregir un valor,
 * pasar un registro de estado (con su foto o su firma), apretar un botón de
 * fila. Todo eso se guarda aquí, junto con los formularios, y sale EN EL ORDEN
 * EN QUE LA PERSONA LO HIZO: «recibido» antes de «despachado», y la foto de la
 * entrega antes de cerrar el pedido.
 *
 * Reglas (todas probadas en op-queue.test.ts):
 *   - Orden global por `createdAt`; ante un empate, el orden en que se guardaron.
 *   - Un fallo de red o del servidor (`retry`) detiene todo: lo de después no
 *     puede adelantarse. Reintento con espera creciente (la misma de los formularios).
 *   - Lo que el servidor rechaza por los datos (`rejected`) no se reintenta y
 *     queda a la vista; NO frena lo que no tiene que ver.
 *   - CONFLICTO: el registro cambió mientras no había señal (el valor que la
 *     persona vio ya no es el de ahora). Queda marcado, con los dos valores, y
 *     espera una decisión humana: «Aplicar lo mío» o «Descartar lo mío».
 *   - Lo que viene DESPUÉS sobre el mismo registro se queda esperando mientras
 *     haya un conflicto o un rechazo sin resolver (si no, se colaría).
 */

import { RETRY_EVERY_MS, backoffMs } from '@/lib/views/offline-queue';

export type OpKind = 'form' | 'edit' | 'act';

/** Un cambio en conflicto: el valor que la persona vio, el suyo y el de ahora. */
export interface Conflict {
  field: string;
  label?: string;
  /** Lo que la persona vio al editar. */
  was: string;
  /** Lo que quiso poner. */
  mine: string;
  /** Lo que hay ahora en el servidor. */
  theirs: string;
}

export interface QueuedOp {
  clientId: string;
  appId: string;
  screen: string;
  kind: 'edit' | 'act';
  blockId: string;
  rowId: string;
  /** Cómo se llama en la lista de pendientes: «Estado de Guía 123 → Entregada». */
  label: string;
  /** edit: los campos que se cambian (las fotos pendientes van como `pending:<id>`). */
  patch?: Record<string, string>;
  /** edit: el valor que la persona vio de cada campo; el servidor lo compara. */
  expect?: Record<string, string>;
  /** act: el botón de fila y el motivo (rechazos). */
  actionId?: string;
  reason?: string;
  createdAt: number;
  attempts: number;
  nextAt: number;
  rejected?: string;
  conflict?: Conflict[];
}

/** Lo mínimo que una entrada de la cola tiene que traer, sea formulario u operación. */
export interface OutboxBase {
  clientId: string;
  createdAt: number;
  attempts: number;
  nextAt: number;
  rejected?: string;
  conflict?: Conflict[];
}

export type OutboxOutcome =
  | { kind: 'ok' }
  | { kind: 'retry' }
  | { kind: 'rejected'; error: string }
  | { kind: 'conflict'; conflicts: Conflict[] };

export function newOp(input: {
  clientId: string;
  appId: string;
  screen: string;
  kind: 'edit' | 'act';
  blockId: string;
  rowId: string;
  label: string;
  patch?: Record<string, string>;
  expect?: Record<string, string>;
  actionId?: string;
  reason?: string;
  now: number;
}): QueuedOp {
  const { now, ...rest } = input;
  return { ...rest, createdAt: now, attempts: 0, nextAt: now };
}

/** Agrega sin duplicar y deja la lista en orden de creación (estable). */
export function enqueueEntry<T extends OutboxBase>(list: T[], item: T): T[] {
  if (list.some((q) => q.clientId === item.clientId)) return list;
  return sortEntries([...list, item]);
}

/** Orden de creación; el empate conserva el orden en que estaban (sort estable). */
export function sortEntries<T extends OutboxBase>(list: T[]): T[] {
  return list
    .map((item, at) => ({ item, at }))
    .sort((a, b) => a.item.createdAt - b.item.createdAt || a.at - b.at)
    .map((x) => x.item);
}

/** ¿Está detenida a la espera de una persona (rechazada o en conflicto)? */
export function needsReview(e: OutboxBase): boolean {
  return Boolean(e.rejected) || Boolean(e.conflict?.length);
}

/** Lo que de verdad va a salir solo: ni rechazado ni en conflicto. */
export function pendingEntries<T extends OutboxBase>(list: T[]): T[] {
  return sortEntries(list).filter((e) => !needsReview(e));
}

export interface DrainOutcome<T> {
  entries: T[];
  /** `clientId` de los que salieron. */
  sent: string[];
}

/**
 * Procesa la cola EN ORDEN. `rowOf` dice sobre qué registro actúa una entrada
 * (null = ninguno, como un formulario nuevo): mientras haya una entrada de un
 * registro esperando revisión, las siguientes del MISMO registro no salen.
 * `force` ignora la espera (volvió la señal, se abrió la app).
 */
export async function drainOutbox<T extends OutboxBase>(
  entries: T[],
  send: (entry: T) => Promise<OutboxOutcome>,
  opts: { now: number; force?: boolean; rowOf?: (e: T) => string | null },
): Promise<DrainOutcome<T>> {
  let next = sortEntries(entries);
  const sent: string[] = [];
  const held = new Set<string>();
  for (const e of next) {
    const row = opts.rowOf?.(e) ?? null;
    if (needsReview(e)) {
      if (row) held.add(row);
      continue;
    }
    if (row && held.has(row)) continue;
    if (!opts.force && e.nextAt > opts.now) break;
    const out = await send(e);
    if (out.kind === 'ok') {
      sent.push(e.clientId);
      next = next.filter((q) => q.clientId !== e.clientId);
    } else if (out.kind === 'rejected') {
      if (row) held.add(row);
      next = next.map((q) => (q.clientId === e.clientId ? { ...q, rejected: out.error } : q));
    } else if (out.kind === 'conflict') {
      if (row) held.add(row);
      next = next.map((q) =>
        q.clientId === e.clientId ? { ...q, conflict: out.conflicts, rejected: undefined } : q,
      );
    } else {
      const attempts = e.attempts + 1;
      next = next.map((q) =>
        q.clientId === e.clientId ? { ...q, attempts, nextAt: opts.now + backoffMs(attempts) } : q,
      );
      break;
    }
  }
  return { entries: next, sent };
}

/**
 * Resolver un conflicto. «Aplicar lo mío»: se vuelve a mandar sin comparar
 * (queda lo que la persona hizo). «Descartar lo mío»: sale de la cola.
 */
export function resolveConflict<T extends OutboxBase & { expect?: Record<string, string> }>(
  list: T[],
  clientId: string,
  choice: 'mine' | 'theirs',
  now: number,
): T[] {
  if (choice === 'theirs') return list.filter((e) => e.clientId !== clientId);
  return list.map((e) => {
    if (e.clientId !== clientId) return e;
    const { conflict: _c, expect: _e, rejected: _r, ...rest } = e;
    return { ...rest, attempts: 0, nextAt: now } as T;
  });
}

/** Una entrada rechazada o con error vuelve a intentarse (la persona corrigió algo o pasó el problema). */
export function retryEntry<T extends OutboxBase>(list: T[], clientId: string, now: number): T[] {
  return list.map((e) => {
    if (e.clientId !== clientId) return e;
    const { rejected: _r, ...rest } = e;
    return { ...rest, attempts: 0, nextAt: now } as T;
  });
}

// ---------------------------------------------------------------------------
// Lo que ve la persona: la barra y la lista de pendientes
// ---------------------------------------------------------------------------

export type ItemState = 'pending' | 'retrying' | 'rejected' | 'conflict';

export interface OutboxItem {
  id: string;
  kind: OpKind;
  label: string;
  state: ItemState;
  attempts: number;
  createdAt: number;
  error?: string;
  conflict?: Conflict[];
}

export function itemState(e: OutboxBase): ItemState {
  if (e.conflict?.length) return 'conflict';
  if (e.rejected) return 'rejected';
  return e.attempts > 0 ? 'retrying' : 'pending';
}

export const STATE_LABEL: Record<ItemState, string> = {
  pending: 'Por enviar',
  retrying: 'Reintentando',
  rejected: 'No se pudo enviar',
  conflict: 'Cambió mientras tanto',
};

export interface OutboxSummary {
  /** Entradas que saldrán solas. */
  pending: number;
  /** Entradas que esperan a una persona (rechazadas o en conflicto). */
  review: number;
  /** El texto de la barra; null = no hay barra que mostrar. */
  text: string | null;
  tone: 'offline' | 'sending' | 'review' | null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** La frase de la barra: «Sin señal · 3 pendientes por enviar». */
export function summarizeOutbox(
  items: Pick<OutboxItem, 'state'>[],
  online: boolean,
  syncing: boolean,
): OutboxSummary {
  const review = items.filter((i) => i.state === 'rejected' || i.state === 'conflict').length;
  const pending = items.length - review;
  const pend = `${pending} ${plural(pending, 'pendiente', 'pendientes')} por enviar`;
  const rev = `${review} ${plural(review, 'necesita', 'necesitan')} revisión`;
  if (!online)
    return {
      pending,
      review,
      tone: 'offline',
      text: `Sin señal${pending ? ` · ${pend}` : ''}${review ? ` · ${rev}` : ''}`,
    };
  if (pending > 0)
    return {
      pending,
      review,
      tone: 'sending',
      text: `${syncing ? 'Enviando' : 'Por enviar'} · ${pend.replace(' por enviar', '')}${review ? ` · ${rev}` : ''}`,
    };
  if (review > 0)
    return { pending, review, tone: 'review', text: `${rev[0]?.toUpperCase()}${rev.slice(1)}` };
  return { pending: 0, review: 0, tone: null, text: null };
}

export { RETRY_EVERY_MS };
