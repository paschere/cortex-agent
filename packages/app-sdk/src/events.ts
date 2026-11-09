import type { LiveEvent, LiveStatus, OutboxState } from './types';

/**
 * LO QUE EL HOST EMPUJA AL IFRAME sin que la pantalla lo pida:
 *
 *   { cortex: 1, event: 'changed',     table, at }   cambió una tabla (canal en vivo)
 *   { cortex: 1, event: 'live-status', status }      `live` | `reconnecting` | `off`
 *   { cortex: 1, event: 'outbox',      state }       la cola sin señal cambió
 *   { cortex: 1, event: 'visible',     visible }     la pantalla se muestra / se oculta (iframes vivos)
 *
 * Aquí vive el estado que esos mensajes alimentan; los ganchos y `cortex.live` / `cortex.outbox`
 * leen de aquí. No importa nada del puente (el puente es quien llama a `handleHostEvent`).
 */

export const EMPTY_OUTBOX: OutboxState = { items: [], pending: 0, failed: 0, online: true };

interface LiveSub {
  tables: Set<string>;
  cb: (ev: LiveEvent) => void;
}

const liveSubs = new Set<LiveSub>();
const statusListeners = new Set<(s: LiveStatus) => void>();
const visibleListeners = new Set<(v: boolean) => void>();
const outboxListeners = new Set<(s: OutboxState) => void>();
let liveStatus: LiveStatus = 'off';
let hostVisible = true;
let outbox: OutboxState = EMPTY_OUTBOX;

export function getLiveStatus(): LiveStatus {
  return liveStatus;
}

export function setLiveStatus(next: LiveStatus): void {
  if (next === liveStatus) return;
  liveStatus = next;
  for (const fn of [...statusListeners]) fn(next);
}

export function onLiveStatus(fn: (s: LiveStatus) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/** Registra una suscripción; devuelve cómo quitarla. */
export function addLiveSub(tables: string[], cb: (ev: LiveEvent) => void): () => void {
  const sub: LiveSub = { tables: new Set(tables), cb };
  liveSubs.add(sub);
  return () => liveSubs.delete(sub);
}

/** La unión de las tablas que alguien está mirando (lo que se le pide al host). */
export function liveUnion(): string[] {
  const all = new Set<string>();
  for (const s of liveSubs) for (const t of s.tables) all.add(t);
  return [...all].sort();
}

function emitChanged(ev: LiveEvent): void {
  for (const s of [...liveSubs]) {
    if (!s.tables.has(ev.table)) continue;
    try {
      s.cb(ev);
    } catch {
      // Un oyente que falla no debe tumbar a los demás.
    }
  }
}

/** ¿El host muestra esta pantalla? (iframes vivos: una oculta no sondea). */
export function isHostVisible(): boolean {
  return hostVisible;
}

export function onHostVisible(fn: (v: boolean) => void): () => void {
  visibleListeners.add(fn);
  return () => visibleListeners.delete(fn);
}

export function getOutbox(): OutboxState {
  return outbox;
}

export function onOutbox(fn: (s: OutboxState) => void): () => void {
  outboxListeners.add(fn);
  return () => outboxListeners.delete(fn);
}

const STATUSES: LiveStatus[] = ['live', 'reconnecting', 'off'];

/** Atiende un mensaje del host que no es respuesta a una llamada. */
export function handleHostEvent(msg: Record<string, unknown>): void {
  switch (msg.event) {
    case 'changed':
      if (typeof msg.table === 'string')
        emitChanged({ table: msg.table, at: typeof msg.at === 'string' ? msg.at : '' });
      return;
    case 'live-status':
      if (STATUSES.includes(msg.status as LiveStatus)) setLiveStatus(msg.status as LiveStatus);
      return;
    case 'outbox':
      if (msg.state && typeof msg.state === 'object') {
        outbox = msg.state as OutboxState;
        for (const fn of [...outboxListeners]) fn(outbox);
      }
      return;
    case 'visible': {
      const v = msg.visible !== false;
      if (v === hostVisible) return;
      hostVisible = v;
      for (const fn of [...visibleListeners]) fn(v);
      return;
    }
  }
}

/** Solo para pruebas. */
export function resetEvents(): void {
  liveSubs.clear();
  statusListeners.clear();
  visibleListeners.clear();
  outboxListeners.clear();
  liveStatus = 'off';
  hostVisible = true;
  outbox = EMPTY_OUTBOX;
}
