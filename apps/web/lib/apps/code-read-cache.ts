/**
 * CACHÉ DE LECTURAS DEL PADRE para las pantallas con código.
 *
 * Vive en estado de módulo (sobrevive a la navegación del cliente de Next): al pasar de una
 * pantalla a otra, lo que la anterior ya leyó se contesta al instante y se refresca en paralelo.
 *
 *  - Solo operaciones de LECTURA (`READ_OPS`). Con una menor a `TTL_MS` se responde ya; si tiene
 *    más de `FRESH_MS` se refresca en segundo plano y, si el dato cambió, se manda la segunda
 *    respuesta (`cortex:update`). Eso solo se hace si el SDK de la pantalla lo pidió (`upd`):
 *    las compilaciones viejas no entienden la segunda respuesta, y servirles datos guardados sin
 *    refresco los dejaría hasta 60 s desactualizados; a ellas se les contesta siempre de la red.
 *  - Cualquier escritura (`WRITE_OPS`) borra TODO lo de esa app y sube su `epoch`: una lectura
 *    que salió antes de la escritura y vuelve después no guarda su respuesta vieja.
 *  - Una lectura de una tabla (`tables.query`/`tables.get`) recuerda de qué tabla es: el canal en
 *    vivo avisa «cambió la tabla X» y `invalidateTable` borra SOLO esas entradas (y sube su
 *    época para que una lectura en vuelo no guarde lo viejo); lo de otras tablas se queda.
 *  - La clave incluye app, rol/«ver como» (el alcance que pone el padre), operación y argumentos;
 *    no depende de la pantalla: dos pantallas que leen lo mismo comparten.
 */

export const TTL_MS = 60_000;
/** Lo recién traído de la red no se vuelve a pedir en este lapso. */
export const FRESH_MS = 1_500;
const MAX_ENTRIES = 120;

export const READ_OPS = new Set([
  'tables.query',
  'tables.get',
  'tables.list',
  'tables.listActions',
  'user.me',
  'geofences.list',
  'people.list',
]);
/** Operaciones que pueden cambiar lo que las lecturas devolverían. */
export const INVALIDATING_OPS = new Set([
  'tables.insert',
  'tables.update',
  'tables.action',
  'files.upload',
  'functions.call',
  'db.query',
]);

export type SdkResult = { ok: true; data: unknown } | { ok: false; error: string };

interface Entry {
  data: unknown;
  at: number;
  /** La tabla que la lectura nombra (si la hay): la invalidación por tabla busca por aquí. */
  table?: string;
}

/** La tabla que una lectura nombra, o undefined si no es de una tabla concreta. */
export function tableOfRead(op: string, args: unknown): string | undefined {
  if (op !== 'tables.query' && op !== 'tables.get') return undefined;
  const t = (args as { table?: unknown } | null)?.table;
  return typeof t === 'string' && t ? t : undefined;
}

export class ReadCache {
  private apps = new Map<string, Map<string, Entry>>();
  private epochs = new Map<string, number>();
  private tableEpochs = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  static key(scope: string, op: string, args: unknown): string {
    return `${scope}\u0000${op}\u0000${JSON.stringify(args ?? null)}`;
  }

  /**
   * La época de una lectura: sube con cualquier escritura de la app y, si se pasa `table`, también
   * con cada invalidación de ESA tabla (una de otra tabla no la mueve).
   */
  epoch(appId: string, table?: string): number {
    const app = this.epochs.get(appId) ?? 0;
    return table ? app + (this.tableEpochs.get(`${appId}\u0000${table}`) ?? 0) : app;
  }

  get(appId: string, key: string): { data: unknown; age: number } | null {
    const e = this.apps.get(appId)?.get(key);
    if (!e) return null;
    const age = this.now() - e.at;
    if (age >= TTL_MS) {
      this.apps.get(appId)?.delete(key);
      return null;
    }
    return { data: e.data, age };
  }

  /** Guarda solo si no hubo escrituras desde que empezó la lectura (`epoch`). */
  set(appId: string, key: string, data: unknown, epoch: number, table?: string): void {
    if (epoch !== this.epoch(appId, table)) return;
    let m = this.apps.get(appId);
    if (!m) {
      m = new Map();
      this.apps.set(appId, m);
    }
    m.delete(key);
    m.set(key, { data, at: this.now(), ...(table ? { table } : {}) });
    while (m.size > MAX_ENTRIES) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }

  invalidate(appId: string): void {
    this.apps.delete(appId);
    this.epochs.set(appId, (this.epochs.get(appId) ?? 0) + 1);
  }

  /** Borra solo las lecturas de esa tabla (las demás siguen) y devuelve cuántas. */
  invalidateTable(appId: string, table: string): number {
    const k = `${appId}\u0000${table}`;
    this.tableEpochs.set(k, (this.tableEpochs.get(k) ?? 0) + 1);
    const m = this.apps.get(appId);
    if (!m) return 0;
    let n = 0;
    for (const [key, e] of m) {
      if (e.table !== table) continue;
      m.delete(key);
      n++;
    }
    return n;
  }

  clear(): void {
    this.apps.clear();
    this.epochs.clear();
    this.tableEpochs.clear();
  }
}

/** La caché de la pestaña. */
export const readCache = new ReadCache();

/**
 * Atiende una lectura: con caché y SDK que acepta actualizaciones, responde con lo guardado y
 * refresca; en cualquier otro caso va a la red y guarda. `fetchFresh` hace la llamada real.
 */
export async function serveRead(opts: {
  cache: ReadCache;
  appId: string;
  scope: string;
  op: string;
  args: unknown;
  wantsUpdate: boolean;
  fetchFresh: () => Promise<SdkResult>;
  reply: (r: SdkResult) => void;
  update: (data: unknown) => void;
}): Promise<void> {
  const { cache, appId, scope, op, args } = opts;
  const key = ReadCache.key(scope, op, args);
  const hit = opts.wantsUpdate ? cache.get(appId, key) : null;
  const table = tableOfRead(op, args);
  const epoch = cache.epoch(appId, table);
  if (hit) {
    opts.reply({ ok: true, data: hit.data });
    if (hit.age < FRESH_MS) return;
    try {
      const fresh = await opts.fetchFresh();
      if (!fresh.ok) return;
      cache.set(appId, key, fresh.data, epoch, table);
      // Si hubo una escritura mientras tanto, lo guardado ya no vale y la pantalla se enterará sola.
      if (cache.epoch(appId, table) !== epoch) return;
      if (JSON.stringify(fresh.data) !== JSON.stringify(hit.data)) opts.update(fresh.data);
    } catch {
      // El refresco es de cortesía: la pantalla ya tiene su respuesta.
    }
    return;
  }
  const res = await opts.fetchFresh();
  if (res.ok) cache.set(appId, key, res.data, epoch, table);
  opts.reply(res);
}
