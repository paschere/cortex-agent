import {
  type OutboxBase,
  type OutboxOutcome,
  drainOutbox,
  enqueueEntry,
  itemState,
  retryEntry,
  sortEntries,
} from '@/lib/apps/op-queue';
import { RETRY_EVERY_MS, isOfflineFailure, newClientId } from '@/lib/views/offline-queue';

/**
 * LA COLA SIN SEÑAL DE LAS PANTALLAS CON CÓDIGO.
 *
 * `cortex.tables.insert/update/action(..., { offline: true })` y `cortex.files.upload(...,
 * { offline: true })` llegan al padre; si no hay red (o el servidor falla con 5xx/429) la
 * operación se guarda en el teléfono y la pantalla recibe `{ queued: true, localId }`. Al volver
 * la señal se manda EN ORDEN con la misma lógica de las apps de bloques (`op-queue.ts`:
 * `drainOutbox`, reintento con espera creciente, rechazado = a la vista y sin reintento, y lo
 * que sigue sobre la misma fila espera).
 *
 * Referencias locales: lo que se encola recibe un `localId`. Una operación posterior puede
 * usarlo como `id` de la fila (la que se creó sin señal) o como texto `local:<localId>` dentro
 * de los valores; al enviar se cambia por lo real (el id de la fila creada, la URL del archivo
 * subido). Si lo que la produjo quedó rechazado, la que depende de ella también se rechaza.
 *
 * Aquí no hay navegador: el almacén (IndexedDB), el envío y la señal se inyectan. El motor
 * real los pone en `code-outbox-host.ts`.
 */

export type CodeOpName = 'tables.insert' | 'tables.update' | 'tables.action' | 'files.upload';
export const CODE_OPS: ReadonlySet<string> = new Set<CodeOpName>([
  'tables.insert',
  'tables.update',
  'tables.action',
  'files.upload',
]);

export interface CodeOp extends OutboxBase {
  /** Distingue estas operaciones de las de bloques en el mismo almacén: `code:<app>`. */
  appId: string;
  userKey: string;
  op: CodeOpName;
  table: string;
  /** Sobre qué fila actúa: su id real o el `localId` de la que se creó sin señal (en un insert, el suyo). */
  rowKey: string;
  /** Los argumentos tal como los mandó la pantalla (sin el archivo y sin `offline`). */
  args: Record<string, unknown>;
  label: string;
  /** `files.upload`: el archivo guardado aparte. */
  blobId?: string;
  fileName?: string;
  mime?: string;
}

export type SendResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; status?: number };

export interface CodeOutboxStore {
  load(): Promise<CodeOp[]>;
  put(op: CodeOp): Promise<void>;
  remove(id: string): Promise<void>;
  putBlob(id: string, blob: Blob): Promise<void>;
  getBlob(id: string): Promise<Blob | null>;
  removeBlob(id: string): Promise<void>;
}

export interface CodeOutboxItem {
  id: string;
  op: string;
  table: string;
  label: string;
  state: 'pending' | 'retrying' | 'rejected';
  attempts: number;
  createdAt: number;
  error?: string;
}

export interface CodeOutboxState {
  items: CodeOutboxItem[];
  pending: number;
  failed: number;
  online: boolean;
}

export const LOCAL_PREFIX = 'local:';
const LOCAL_RE = /local:([A-Za-z0-9_-]{6,80})/g;

export const localRef = (localId: string) => `${LOCAL_PREFIX}${localId}`;

/** ¿Es una referencia local (`local:<id>`)? Devuelve el id o null. */
export function parseLocalRef(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith(LOCAL_PREFIX)) return null;
  const id = v.slice(LOCAL_PREFIX.length);
  return /^[A-Za-z0-9_-]{6,80}$/.test(id) ? id : null;
}

/**
 * Cambia las referencias locales por lo real, en cualquier parte de `value` (también dentro de
 * un texto JSON, como el valor de un campo de archivos). Lo que no se conoce queda igual.
 */
export function resolveRefs<T>(value: T, refs: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') {
    return value.replace(LOCAL_RE, (m, id: string) => refs.get(id) ?? m) as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, refs)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = resolveRefs(v, refs);
    return out as T;
  }
  return value;
}

/** Los `localId` que `value` menciona (`local:<id>`) y que aún no se resolvieron. */
export function unresolvedRefs(value: unknown, refs: ReadonlyMap<string, string>): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(LOCAL_RE)) {
        const id = m[1] as string;
        if (!refs.has(id)) found.add(id);
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(value);
  return [...found];
}

/** El `id` de la fila a la que apunta una operación: acepta el `localId` solo o como `local:<id>`. */
export function rowIdOf(args: Record<string, unknown>): string {
  const id = typeof args.id === 'string' ? args.id : '';
  return parseLocalRef(id) ?? id;
}

export function labelOf(op: CodeOpName, args: Record<string, unknown>): string {
  const table = typeof args.table === 'string' ? args.table : '';
  switch (op) {
    case 'tables.insert':
      return `Nueva fila en ${table}`;
    case 'tables.update':
      return `Cambio en ${table}`;
    case 'tables.action':
      return `Acción «${String(args.action ?? '')}» en ${table}`;
    default:
      return `Archivo para ${table}`;
  }
}

function toItem(e: CodeOp): CodeOutboxItem {
  const s = itemState(e);
  return {
    id: e.clientId,
    op: e.op,
    table: e.table,
    label: e.label,
    state: s === 'conflict' ? 'rejected' : s,
    attempts: e.attempts,
    createdAt: e.createdAt,
    ...(e.rejected ? { error: e.rejected } : {}),
  };
}

/** Lo que ve la pantalla: items, cuántos saldrán solos y cuántos fallaron. */
export function stateOf(entries: CodeOp[], online: boolean): CodeOutboxState {
  const items = sortEntries(entries).map(toItem);
  const failed = items.filter((i) => i.state === 'rejected').length;
  return { items, pending: items.length - failed, failed, online };
}

/** El resultado de enviar, como lo entiende `drainOutbox`: sin red o 5xx/429 = reintentar. */
export function outcomeOf(res: SendResult, online: boolean): OutboxOutcome {
  if (res.ok) return { kind: 'ok' };
  return isOfflineFailure({ online, status: res.status })
    ? { kind: 'retry' }
    : { kind: 'rejected', error: res.error };
}

export interface CodeOutboxDeps {
  appKey: string;
  userKey: string;
  store: CodeOutboxStore;
  /** Manda UNA operación al servidor; lanza si no hay red. */
  send: (op: CodeOpName, args: Record<string, unknown>, file?: File) => Promise<SendResult>;
  isOnline: () => boolean;
  now?: () => number;
  /** La cola cambió (para avisar a las pantallas). */
  onState?: (state: CodeOutboxState) => void;
  /** Salió una operación de esa tabla: invalidar la caché y avisar. */
  onSent?: (table: string) => void;
}

export class CodeOutbox {
  private entries: CodeOp[] = [];
  private refs = new Map<string, string>();
  private busy = false;
  private started = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly storeAppId: string;

  constructor(private readonly d: CodeOutboxDeps) {
    this.now = d.now ?? Date.now;
    this.storeAppId = `code:${d.appKey}`;
  }

  state(): CodeOutboxState {
    return stateOf(this.entries, this.d.isOnline());
  }

  private emit() {
    this.d.onState?.(this.state());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const all = await this.d.store.load();
    const mine: CodeOp[] = [];
    for (const o of all) {
      if (o.appId !== this.storeAppId) continue;
      // Lo que dejó OTRA persona en este teléfono no se envía desde aquí: se borra con su archivo.
      if (o.userKey !== this.d.userKey) {
        if (o.blobId) await this.d.store.removeBlob(o.blobId);
        await this.d.store.remove(o.clientId);
      } else mine.push(o);
    }
    this.entries = sortEntries(mine);
    this.emit();
    this.timer = setInterval(() => void this.drain(false), RETRY_EVERY_MS);
    void this.drain(true);
  }

  stop(): void {
    this.started = false;
    clearInterval(this.timer);
  }

  /** Vuelve a avisar el estado (cambió la señal). */
  notify(): void {
    this.emit();
  }

  /** ¿Hay algo en la cola que toque esa fila? Lo que viene después debe esperar su turno. */
  hasPendingFor(table: string, rowId: string): boolean {
    const row = parseLocalRef(rowId) ?? rowId;
    return this.entries.some((e) => e.table === table && e.rowKey === row);
  }

  /** ¿Algún valor usa una referencia local que aún no se resolvió? Entonces no puede ir directo. */
  dependsOnQueued(args: unknown): boolean {
    const queued = new Set(this.entries.map((e) => e.clientId));
    if (unresolvedRefs(args, this.refs).some((id) => queued.has(id))) return true;
    const id = rowIdOf((args ?? {}) as Record<string, unknown>);
    return Boolean(id) && !this.refs.has(id) && queued.has(id);
  }

  /** Cambia las referencias locales ya conocidas (la fila creada sin señal, el archivo subido) por lo real. */
  resolveArgs(args: Record<string, unknown>): Record<string, unknown> {
    let out = args;
    const rid = rowIdOf(out);
    const real = rid ? this.refs.get(rid) : undefined;
    if (real) out = { ...out, id: real };
    return resolveRefs(out, this.refs);
  }

  /** Guarda una operación en el teléfono y devuelve lo que ve la pantalla. */
  async enqueue(input: {
    op: CodeOpName;
    args: Record<string, unknown>;
    file?: File;
  }): Promise<{ queued: true; localId: string; ref: string }> {
    const localId = newClientId();
    const table = typeof input.args.table === 'string' ? input.args.table : '';
    const args = { ...input.args };
    let blobId: string | undefined;
    if (input.file) {
      blobId = `code-${localId}`;
      await this.d.store.putBlob(blobId, input.file);
    }
    const entry: CodeOp = {
      clientId: localId,
      appId: this.storeAppId,
      userKey: this.d.userKey,
      op: input.op,
      table,
      rowKey: input.op === 'tables.insert' ? localId : rowIdOf(args),
      args,
      label: labelOf(input.op, args),
      ...(blobId ? { blobId, fileName: input.file?.name, mime: input.file?.type } : {}),
      createdAt: this.now(),
      attempts: 0,
      nextAt: this.now(),
    };
    this.entries = enqueueEntry(this.entries, entry);
    await this.d.store.put(entry);
    this.emit();
    void this.drain(false);
    return { queued: true, localId, ref: localRef(localId) };
  }

  /** Lo que `drainOutbox` llama por cada entrada, en orden. */
  private async sendOne(e: CodeOp): Promise<OutboxOutcome> {
    const args = this.resolveArgs(e.args);
    if (unresolvedRefs(args, this.refs).length)
      return {
        kind: 'rejected',
        error: 'Depende de una operación anterior que no se pudo enviar.',
      };
    let file: File | undefined;
    if (e.blobId) {
      const blob = await this.d.store.getBlob(e.blobId);
      if (!blob)
        return { kind: 'rejected', error: 'El archivo guardado ya no está en el teléfono.' };
      file = new File([blob], e.fileName || 'archivo', { type: e.mime || blob.type });
    }
    let res: SendResult;
    try {
      res = await this.d.send(e.op, args, file);
    } catch {
      return { kind: 'retry' };
    }
    if (!res.ok) return outcomeOf(res, this.d.isOnline());
    // Lo que produjo (el id de la fila creada, la URL del archivo) queda para las que dependen.
    const data = res.data as { id?: unknown; url?: unknown } | null;
    const produced =
      e.op === 'tables.insert' ? data?.id : e.op === 'files.upload' ? data?.url : undefined;
    if (typeof produced === 'string') this.refs.set(e.clientId, produced);
    await this.rewriteDependents(e.clientId);
    if (e.blobId) await this.d.store.removeBlob(e.blobId);
    await this.d.store.remove(e.clientId);
    this.d.onSent?.(e.table);
    return { kind: 'ok' };
  }

  /** Persiste, ya resueltas, las operaciones que usaban esa referencia (sobrevive a un cierre de la pestaña). */
  private async rewriteDependents(localId: string): Promise<void> {
    const real = this.refs.get(localId);
    if (!real) return;
    const one = new Map([[localId, real]]);
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i] as CodeOp;
      if (e.clientId === localId) continue;
      const args = resolveRefs(e.args, one);
      const idMatches = rowIdOf(e.args) === localId;
      if (JSON.stringify(args) === JSON.stringify(e.args) && !idMatches) continue;
      const next: CodeOp = {
        ...e,
        args: idMatches ? { ...args, id: real } : args,
        rowKey: idMatches ? real : e.rowKey,
      };
      this.entries[i] = next;
      await this.d.store.put(next);
    }
  }

  async drain(force: boolean): Promise<void> {
    if (this.busy || !this.started || !this.d.isOnline() || this.entries.length === 0) return;
    this.busy = true;
    this.emit();
    try {
      const out = await drainOutbox<CodeOp>(this.entries, (e) => this.sendOne(e), {
        now: this.now(),
        force,
        rowOf: (e) => `${e.table}:${e.rowKey}`,
      });
      // `sendOne` pudo reescribir entradas: se toma el estado de `out` con esas versiones.
      const latest = new Map(this.entries.map((e) => [e.clientId, e]));
      this.entries = out.entries.map((e) => {
        const l = latest.get(e.clientId);
        return l ? { ...l, attempts: e.attempts, nextAt: e.nextAt, rejected: e.rejected } : e;
      });
      for (const e of this.entries) await this.d.store.put(e);
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  async retry(): Promise<void> {
    const t = this.now();
    for (const e of [...this.entries]) this.entries = retryEntry(this.entries, e.clientId, t);
    for (const e of this.entries) await this.d.store.put(e);
    this.emit();
    await this.drain(true);
  }

  async discard(localId: string): Promise<void> {
    const e = this.entries.find((x) => x.clientId === localId);
    if (!e) return;
    if (e.blobId) await this.d.store.removeBlob(e.blobId);
    this.entries = this.entries.filter((x) => x.clientId !== localId);
    await this.d.store.remove(localId);
    this.emit();
  }
}
