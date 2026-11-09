/**
 * EL CANAL EN VIVO DEL LADO DEL NAVEGADOR (padre de las pantallas con código).
 *
 * UN `EventSource` por app con la UNIÓN de las tablas que pidieron sus pantallas (las que están
 * montadas, vivas u ocultas). Lógica pura con dependencias inyectadas: se prueba sin navegador.
 *
 *  - Estado: `live` conectado · `reconnecting` reintentando · `off` sin canal (muchos fallos
 *    seguidos o nadie mira tablas): la pantalla cae a su sondeo de respaldo.
 *  - Reconexión con espera creciente (1 s, 2 s, 4 s… tope 30 s). Tras 5 fallos seguidos el estado
 *    pasa a `off`, pero se sigue intentando cada 60 s.
 *  - Al reabrir (el servidor cierra a ~280 s, o se cayó la red) se da por cambiada CADA tabla:
 *    pudo haber cambios mientras no había canal.
 */

export type LiveStatus = 'live' | 'reconnecting' | 'off';

export const LIVE_BACKOFF_BASE_MS = 1_000;
export const LIVE_BACKOFF_MAX_MS = 30_000;
export const LIVE_OFF_AFTER_FAILURES = 5;
export const LIVE_SLOW_RETRY_MS = 60_000;

/** Espera antes del intento `attempt` (1, 2, 3…): 1 s, 2 s, 4 s… con tope. */
export function liveBackoffMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(LIVE_BACKOFF_BASE_MS * 2 ** Math.min(attempt - 1, 10), LIVE_BACKOFF_MAX_MS);
}

export interface EventSourceLike {
  addEventListener(type: string, fn: (ev: { data?: string }) => void): void;
  close(): void;
  onerror: ((ev: unknown) => void) | null;
}

export interface LiveChannelDeps {
  /** La dirección del canal para esas tablas. */
  url: (tables: string[]) => string;
  makeSource: (url: string) => EventSourceLike;
  onChange: (table: string, at: string) => void;
  onStatus: (status: LiveStatus) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  now?: () => number;
}

export class LiveChannel {
  private tables: string[] = [];
  private source: EventSourceLike | null = null;
  private failures = 0;
  private retry: unknown = null;
  private everOpened = false;
  private status: LiveStatus = 'off';
  private closed = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly deps: LiveChannelDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.now = deps.now ?? Date.now;
  }

  getStatus(): LiveStatus {
    return this.status;
  }

  getTables(): string[] {
    return this.tables;
  }

  /** Cambia las tablas que se miran; si la unión cambió, reabre el canal. */
  setTables(next: string[]): void {
    const sorted = [...new Set(next)].sort();
    if (sorted.join(',') === this.tables.join(',')) return;
    this.tables = sorted;
    this.teardown();
    this.failures = 0;
    if (sorted.length === 0) return this.setStatus('off');
    this.connect();
  }

  close(): void {
    this.closed = true;
    this.teardown();
    this.setStatus('off');
  }

  private setStatus(s: LiveStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.deps.onStatus(s);
  }

  private teardown(): void {
    if (this.retry !== null) this.clearTimer(this.retry);
    this.retry = null;
    const src = this.source;
    this.source = null;
    if (src) {
      src.onerror = null;
      src.close();
    }
  }

  private connect(): void {
    if (this.closed || this.tables.length === 0) return;
    this.setStatus('reconnecting');
    let src: EventSourceLike;
    try {
      src = this.deps.makeSource(this.deps.url(this.tables));
    } catch {
      return this.fail();
    }
    this.source = src;
    src.addEventListener('open', () => {
      if (this.source !== src) return;
      this.failures = 0;
      this.setStatus('live');
      // Reabrir tras un corte: pudo cambiar algo sin que nos enteráramos.
      if (this.everOpened) this.resync();
      this.everOpened = true;
    });
    src.addEventListener('change', (ev) => {
      if (this.source !== src) return;
      try {
        const d = JSON.parse(ev.data ?? '{}') as { table?: unknown; at?: unknown };
        if (typeof d.table === 'string')
          this.deps.onChange(
            d.table,
            typeof d.at === 'string' ? d.at : new Date(this.now()).toISOString(),
          );
      } catch {
        // Un aviso mal formado no tumba el canal.
      }
    });
    // El servidor recicla la conexión a ~280 s: se reabre enseguida, sin contar como fallo.
    src.addEventListener('closed', () => {
      if (this.source !== src) return;
      this.teardown();
      this.connect();
    });
    src.addEventListener('fault', () => {
      if (this.source !== src) return;
      this.teardown();
      this.fail();
    });
    src.onerror = () => {
      if (this.source !== src) return;
      this.teardown();
      this.fail();
    };
  }

  private resync(): void {
    const at = new Date(this.now()).toISOString();
    for (const t of this.tables) this.deps.onChange(t, at);
  }

  private fail(): void {
    if (this.closed || this.tables.length === 0) return;
    this.failures++;
    this.setStatus(this.failures >= LIVE_OFF_AFTER_FAILURES ? 'off' : 'reconnecting');
    const wait =
      this.failures >= LIVE_OFF_AFTER_FAILURES ? LIVE_SLOW_RETRY_MS : liveBackoffMs(this.failures);
    this.retry = this.setTimer(() => {
      this.retry = null;
      this.connect();
    }, wait);
  }
}

/**
 * El canal de UNA app compartido por todos sus marcos: cada marco dice qué tablas mira y se
 * abre un solo canal con la unión. `onChange`/`onStatus` reparten a los marcos interesados.
 */
export class AppLive {
  private frames = new Map<string, Set<string>>();
  private channel: LiveChannel;
  private readonly onChange: (table: string, at: string, interested: string[]) => void;

  constructor(
    deps: Omit<LiveChannelDeps, 'onChange'> & {
      /** Algo cambió en `table`: borrar su caché y avisar a los marcos que la miran. */
      onChange: (table: string, at: string, interested: string[]) => void;
    },
  ) {
    this.onChange = deps.onChange;
    this.channel = new LiveChannel({
      ...deps,
      onChange: (table, at) => deps.onChange(table, at, this.framesFor(table)),
    });
  }

  framesFor(table: string): string[] {
    const out: string[] = [];
    for (const [id, tables] of this.frames) if (tables.has(table)) out.push(id);
    return out;
  }

  getStatus(): LiveStatus {
    return this.channel.getStatus();
  }

  /** Un marco declara las tablas que mira (reemplaza lo anterior). */
  setFrameTables(frameId: string, tables: string[]): void {
    if (tables.length === 0) this.frames.delete(frameId);
    else this.frames.set(frameId, new Set(tables));
    this.channel.setTables([...new Set([...this.frames.values()].flatMap((s) => [...s]))]);
  }

  removeFrame(frameId: string): void {
    this.setFrameTables(frameId, []);
  }

  /** Un cambio hecho aquí mismo (la cola vació una operación): mismo camino que uno del canal. */
  localChange(table: string): void {
    this.onChange(table, new Date().toISOString(), this.framesFor(table));
  }

  close(): void {
    this.channel.close();
  }
}
