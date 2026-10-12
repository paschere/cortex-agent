'use client';

import { uploadFile } from '@/components/views/inputs/FileInput';
import { registerBox, unregisterBox } from '@/lib/apps/capture-clear';
import {
  type Conflict,
  type OutboxItem,
  type OutboxOutcome,
  type OutboxSummary,
  type QueuedOp,
  drainOutbox,
  itemState,
  newOp,
  resolveConflict,
  retryEntry,
  sortEntries,
  summarizeOutbox,
} from '@/lib/apps/op-queue';
import { screensToDrop } from '@/lib/apps/screen-cache';
import {
  editAppRowAction,
  runAppActionAction,
  submitAppFormAction,
} from '@/lib/apps/write-actions';
import { hasPending, pendingIds, resolvePending } from '@/lib/views/offline-files';
import { type QueuedSubmission, RETRY_EVERY_MS, newClientId } from '@/lib/views/offline-queue';
import {
  type StoredOp,
  clearEverything,
  loadOps,
  loadQueue,
  loadScreens,
  putItem,
  putOp,
  removeBlob,
  removeItem,
  removeOp,
  removeScreen,
} from '@/lib/views/offline-store';

/**
 * EL BUZÓN DE SALIDA DE UNA APP, EN EL TELÉFONO.
 *
 * Una sola cola, en IndexedDB, para TODO lo que una persona hace en una app sin
 * señal: formularios (los que ya guardaba `useFormQueue`), ediciones de celda,
 * pases de estado con sus fotos y firmas, botones de fila. Se envía en el orden
 * en que se hizo (op-queue.ts) apenas vuelve la señal, y cada pendiente muestra
 * su estado. La lógica de orden, reintento y conflictos es pura y está probada
 * en op-queue.test.ts; aquí sólo está lo que toca el navegador.
 *
 * Una instancia por (app, persona): lo de otra persona nunca se envía desde
 * aquí, y al iniciar se borra lo que dejó otra persona en este teléfono.
 */

type Entry =
  | ({ type: 'op' } & StoredOp)
  | ({ type: 'form'; screen: string; conflict?: Conflict[] } & QueuedSubmission);

export interface OutboxSnapshot {
  online: boolean;
  syncing: boolean;
  items: OutboxItem[];
  summary: OutboxSummary;
}

const EMPTY: OutboxSnapshot = {
  online: true,
  syncing: false,
  items: [],
  summary: { pending: 0, review: 0, text: null, tone: null },
};

/** `capp:<app>:<pantalla>:<bloque>` → pantalla y bloque; null si la llave es de otra cosa. */
export function parseFormKey(
  key: string,
  appKey: string,
): { screen: string; blockId: string } | null {
  const prefix = `capp:${appKey}:`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const at = rest.indexOf(':');
  if (at <= 0) return null;
  return { screen: rest.slice(0, at), blockId: rest.slice(at + 1) };
}

function shortValue(v: string): string {
  const t = v.trim();
  if (!t || t.startsWith('{') || t.startsWith('[')) return '';
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
}

function formLabel(values: Record<string, string>): string {
  const parts = Object.values(values).map(shortValue).filter(Boolean).slice(0, 2);
  return `Registro nuevo${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
}

export class AppOutbox {
  private ops: StoredOp[] = [];
  private forms: QueuedSubmission[] = [];
  private online = true;
  private syncing = false;
  private busy = false;
  private started = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<() => void>();
  private snap: OutboxSnapshot = EMPTY;

  constructor(
    readonly appKey: string,
    readonly userKey: string,
    readonly external: boolean,
  ) {}

  // -- suscripción (useSyncExternalStore) -----------------------------------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  private emit() {
    const entries = this.merged();
    const items: OutboxItem[] = entries.map((e) => ({
      id: e.clientId,
      kind: e.type === 'form' ? 'form' : e.kind,
      label: e.type === 'form' ? formLabel(e.values) : e.label,
      state: itemState(e),
      attempts: e.attempts,
      createdAt: e.createdAt,
      error: e.rejected,
      conflict: e.conflict,
    }));
    this.snap = {
      online: this.online,
      syncing: this.syncing,
      items,
      summary: summarizeOutbox(items, this.online, this.syncing),
    };
    for (const fn of this.listeners) fn();
  }

  private merged(): Entry[] {
    const forms: Entry[] = this.forms.map((f) => {
      const parsed = parseFormKey(f.key, this.appKey);
      return { type: 'form' as const, screen: parsed?.screen ?? '', ...f };
    });
    return sortEntries<Entry>([...this.ops.map((o) => ({ type: 'op' as const, ...o })), ...forms]);
  }

  // -- ciclo de vida --------------------------------------------------------
  async start() {
    if (this.started) return;
    this.started = true;
    this.online = typeof navigator === 'undefined' || navigator.onLine !== false;
    await this.reload();
    this.emit();
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('cortex:outbox-changed', this.onChanged);
    this.timer = setInterval(() => void this.drain(false), RETRY_EVERY_MS);
    void this.drain(true);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('cortex:outbox-changed', this.onChanged);
    clearInterval(this.timer);
  }

  private onOnline = () => {
    this.online = true;
    this.emit();
    void this.drain(true);
  };
  private onChanged = () => {
    if (!this.busy) void this.refreshForms();
  };
  private onOffline = () => {
    this.online = false;
    this.emit();
  };

  private async reload() {
    const [ops, forms] = await Promise.all([loadOps(), loadQueue()]);
    // Lo que dejó OTRA persona en este teléfono no se envía desde aquí: se borra.
    for (const o of ops)
      if (o.appId === this.appKey && o.userKey !== this.userKey) await removeOp(o.clientId);
    this.ops = ops.filter((o) => o.appId === this.appKey && o.userKey === this.userKey);
    this.forms = forms.filter((f) => parseFormKey(f.key, this.appKey) !== null);
    // Y las copias de pantallas de otras personas.
    try {
      const shots = await loadScreens();
      const gone = screensToDrop(shots, { appKey: this.appKey, userKey: this.userKey }, Date.now());
      for (const key of gone) await removeScreen(key);
    } catch {}
  }

  /** Para que quien lee los formularios guardados por `useFormQueue` los vea sin esperar al reloj. */
  async refreshForms() {
    this.forms = (await loadQueue()).filter((f) => parseFormKey(f.key, this.appKey) !== null);
    this.emit();
  }

  // -- guardar --------------------------------------------------------------
  async queueEdit(input: {
    screen: string;
    blockId: string;
    rowId: string;
    label: string;
    patch: Record<string, string>;
    expect?: Record<string, string>;
  }): Promise<void> {
    const op: StoredOp = {
      ...newOp({
        clientId: newClientId(),
        appId: this.appKey,
        screen: input.screen,
        kind: 'edit',
        blockId: input.blockId,
        rowId: input.rowId,
        label: input.label,
        patch: input.patch,
        expect: input.expect,
        now: Date.now(),
      }),
      userKey: this.userKey,
    };
    await this.add(op);
  }

  async queueAct(input: {
    screen: string;
    blockId: string;
    rowId: string;
    actionId: string;
    reason?: string;
    label: string;
  }): Promise<void> {
    const op: StoredOp = {
      ...newOp({
        clientId: newClientId(),
        appId: this.appKey,
        screen: input.screen,
        kind: 'act',
        blockId: input.blockId,
        rowId: input.rowId,
        actionId: input.actionId,
        reason: input.reason,
        label: input.label,
        now: Date.now(),
      }),
      userKey: this.userKey,
    };
    await this.add(op);
  }

  private async add(op: StoredOp) {
    this.ops = [...this.ops, op];
    await putOp(op);
    this.emit();
  }

  // -- enviar ---------------------------------------------------------------
  private uploader(screen: string, blockId: string) {
    return (file: File, field: string) =>
      uploadFile(
        { kind: 'custom_app', appId: this.appKey, screen, external: this.external },
        blockId,
        field,
        file,
        () => {},
      );
  }

  private async send(e: Entry): Promise<OutboxOutcome> {
    try {
      if (e.type === 'form') {
        let values = e.values;
        if (hasPending(values)) {
          values = await resolvePending(values, this.uploader(e.screen, e.blockId));
          await putItem({ ...e, values });
        }
        const res = await submitAppFormAction(this.appKey, e.screen, e.blockId, values, e.clientId);
        return res.ok ? { kind: 'ok' } : { kind: 'rejected', error: res.error };
      }
      if (e.kind === 'edit') {
        let patch = e.patch ?? {};
        if (hasPending(patch)) {
          patch = await resolvePending(patch, this.uploader(e.screen, e.blockId));
          await putOp({ ...e, patch });
        }
        const res = await editAppRowAction(
          this.appKey,
          e.screen,
          e.blockId,
          e.rowId,
          patch,
          e.expect,
        );
        if (res.ok) return { kind: 'ok' };
        if ('conflict' in res && res.conflict?.length)
          return {
            kind: 'conflict',
            conflicts: res.conflict.map(
              (c): Conflict => ({
                field: c.field,
                was: e.expect?.[c.field] ?? '',
                mine: patch[c.field] ?? '',
                theirs: c.theirs,
              }),
            ),
          };
        return { kind: 'rejected', error: res.error };
      }
      const res = await runAppActionAction(
        this.appKey,
        e.screen,
        e.blockId,
        e.actionId ?? '',
        e.rowId,
        e.reason,
      );
      return res.ok ? { kind: 'ok' } : { kind: 'rejected', error: res.error };
    } catch (err) {
      // Sin red, o el servidor no contestó: se reintenta. Una foto que ya no está, no.
      return err instanceof Error && err.message.startsWith('Una foto guardada')
        ? { kind: 'rejected', error: err.message }
        : { kind: 'retry' };
    }
  }

  async drain(force: boolean): Promise<void> {
    if (this.busy || !this.started || !this.online) return;
    await this.refreshForms();
    if (!this.ops.length && !this.forms.length) return;
    this.busy = true;
    this.syncing = true;
    this.emit();
    try {
      const out = await drainOutbox<Entry>(this.merged(), (e) => this.send(e), {
        now: Date.now(),
        force,
        rowOf: (e) => (e.type === 'op' ? e.rowId : null),
      });
      // Lo que cambió (intentos, rechazos, conflictos) y lo que salió.
      const nextOps: StoredOp[] = [];
      const nextForms: QueuedSubmission[] = [];
      for (const e of out.entries) {
        if (e.type === 'op') {
          const { type: _t, ...op } = e;
          nextOps.push(op);
          await putOp(op);
        } else {
          const { type: _t, screen: _s, ...form } = e;
          nextForms.push(form);
          await putItem(form);
        }
      }
      for (const id of out.sent) {
        if (this.ops.some((o) => o.clientId === id)) await removeOp(id);
        else await removeItem(id);
      }
      this.ops = nextOps;
      this.forms = nextForms;
      if (out.sent.length) window.dispatchEvent(new Event('cortex:refresh-view'));
    } finally {
      this.busy = false;
      this.syncing = false;
      this.emit();
    }
  }

  // -- decisiones de la persona --------------------------------------------
  async retry(id: string) {
    this.ops = retryEntry(this.ops, id, Date.now());
    this.forms = retryEntry(this.forms, id, Date.now());
    for (const o of this.ops) if (o.clientId === id) await putOp(o);
    for (const f of this.forms) if (f.clientId === id) await putItem(f);
    this.emit();
    await this.drain(true);
  }

  async discard(id: string) {
    const op = this.ops.find((o) => o.clientId === id);
    const form = this.forms.find((f) => f.clientId === id);
    for (const v of Object.values(op?.patch ?? form?.values ?? {}))
      for (const blob of pendingIds(v)) await removeBlob(blob);
    this.ops = this.ops.filter((o) => o.clientId !== id);
    this.forms = this.forms.filter((f) => f.clientId !== id);
    await removeOp(id);
    await removeItem(id);
    this.emit();
  }

  async resolve(id: string, choice: 'mine' | 'theirs') {
    if (choice === 'theirs') return this.discard(id);
    this.ops = resolveConflict(this.ops, id, 'mine', Date.now());
    const mine = this.ops.find((o) => o.clientId === id);
    if (mine) await putOp(mine);
    this.emit();
    await this.drain(true);
  }
}

// ---------------------------------------------------------------------------
// El registro de buzones activos (uno por app abierta)
// ---------------------------------------------------------------------------

const registry = new Map<string, AppOutbox>();

/** El buzón de esta app y esta persona; si cambió la persona, uno nuevo (el viejo se detiene). */
export function outboxFor(appKey: string, userKey: string, external: boolean): AppOutbox {
  const hit = registry.get(appKey);
  if (hit && hit.userKey === userKey) return hit;
  hit?.stop();
  if (hit) unregisterBox(appKey);
  const next = new AppOutbox(appKey, userKey, external);
  registry.set(appKey, next);
  registerBox(appKey, {
    drain: () => next.drain(true),
    stop: () => next.stop(),
  });
  return next;
}

/** El buzón activo de la app, si la pantalla lo montó (los formularios y botones lo usan). */
export function activeOutbox(appKey: string): AppOutbox | null {
  return registry.get(appKey) ?? null;
}
