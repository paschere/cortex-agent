import { AppLive, type EventSourceLike, type LiveStatus } from '@/lib/apps/code-live';
import { type HostedOutbox, hostedOutbox } from '@/lib/apps/code-outbox-host';
import type { CodeOutboxState } from '@/lib/apps/code-outbox';
import {
  type Controls,
  type FrameBridgeCtx,
  LOAD_TIMEOUT_MS,
  READY_CAP_MS,
  handleFrameMessage,
} from '@/lib/apps/code-frame-bridge';
import { readCache } from '@/lib/apps/code-read-cache';
import {
  MAX_LIVE_FRAMES,
  type PoolEntry,
  type PoolState,
  activate,
  emptyPool,
} from '@/lib/apps/frame-pool';

/**
 * EL CONJUNTO DE IFRAMES VIVOS DE UNA APP (apps con código), del lado del navegador.
 *
 * Lo crea `CodeFrameHost` (en el layout de la app, que NO se desmonta al navegar entre
 * pantallas) y lo usan los `CodeScreen`: cada uno dice «esta pantalla está a la vista» y aquí se
 * decide qué iframes siguen vivos (`frame-pool.ts`, LRU de 4), dónde se dibuja el activo (sobre
 * el hueco que dejó su `CodeScreen`) y quién atiende sus mensajes.
 *
 * También es el dueño de lo que es de la APP y no de una pantalla: el canal en vivo (un
 * `EventSource` con la unión de las tablas de todos los marcos), la cola sin señal y los avisos
 * `cortex:visible`, `cortex:live-status`, `cortex:changed` y `cortex:outbox` hacia los iframes.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameView {
  id: string;
  screen: string;
  src: string;
  attempt: number;
  active: boolean;
  loaded: boolean;
  shown: boolean;
  failed: boolean;
  /** Dónde se dibuja (el del hueco, si es el activo; el último conocido si está oculto). */
  rect: Rect | null;
}

export interface PoolSnapshot {
  frames: FrameView[];
  activeId: string | null;
}

export interface ActivateInput {
  screen: string;
  src: string;
  /** Ver `poolContext`. */
  ctx: string;
  appId: string;
  sdkUrl: string;
  cacheScope: string;
  readOnly: boolean;
  /** «?como=…» (con el signo de pregunta) o vacío. */
  como: string;
  slot: HTMLElement;
}

interface Runtime {
  entry: PoolEntry;
  appId: string;
  sdkUrl: string;
  cacheScope: string;
  readOnly: boolean;
  attempt: number;
  loaded: boolean;
  shown: boolean;
  failed: boolean;
  rect: Rect | null;
  failTimer?: ReturnType<typeof setTimeout>;
  readyTimer?: ReturnType<typeof setTimeout>;
}

const EMPTY: PoolSnapshot = { frames: [], activeId: null };

export class FramePool {
  private state: PoolState = emptyPool();
  private rt = new Map<string, Runtime>();
  private iframes = new Map<string, HTMLIFrameElement>();
  private activeId: string | null = null;
  private slot: HTMLElement | null = null;
  private wrap: HTMLElement | null = null;
  private snap: PoolSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private live: AppLive | null = null;
  private liveKey = '';
  private liveStatusCache: LiveStatus = 'off';
  private hosted: HostedOutbox | null = null;
  private hostedKey = '';
  private offOutbox: Array<() => void> = [];
  private observer: ResizeObserver | null = null;
  private poll: ReturnType<typeof setInterval> | undefined;
  private attached = false;
  controls: Controls | null = null;

  constructor(private readonly max: number = MAX_LIVE_FRAMES) {}

  // -- suscripción (useSyncExternalStore) -----------------------------------------------------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): PoolSnapshot => this.snap;
  getServerSnapshot = (): PoolSnapshot => EMPTY;

  private emit(): void {
    const frames: FrameView[] = this.state.entries.map((e) => {
      const r = this.rt.get(e.id);
      return {
        id: e.id,
        screen: e.screen,
        src: e.src,
        attempt: r?.attempt ?? 0,
        active: e.id === this.activeId,
        loaded: r?.loaded ?? false,
        shown: r?.shown ?? false,
        failed: r?.failed ?? false,
        rect: r?.rect ?? null,
      };
    });
    this.snap = { frames, activeId: this.activeId };
    for (const fn of [...this.listeners]) fn();
  }

  // -- ciclo de vida --------------------------------------------------------------------------
  attach(wrap: HTMLElement): void {
    this.wrap = wrap;
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('message', this.onMessage);
    window.addEventListener('resize', this.measure);
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.measure);
    this.observer?.observe(wrap);
    if (this.slot) this.observer?.observe(this.slot);
    // El hueco puede moverse sin cambiar de tamaño (menú lateral, animación de entrada).
    this.poll = setInterval(this.measure, 400);
  }

  /** El layout se desmonta (se salió de la app): se suelta todo. */
  destroy(): void {
    window.removeEventListener('message', this.onMessage);
    window.removeEventListener('resize', this.measure);
    this.observer?.disconnect();
    this.observer = null;
    clearInterval(this.poll);
    this.attached = false;
    for (const id of [...this.rt.keys()]) this.dispose(id);
    this.state = emptyPool();
    this.activeId = null;
    this.slot = null;
    this.wrap = null;
    this.live?.close();
    this.live = null;
    this.liveKey = '';
    for (const off of this.offOutbox) off();
    this.offOutbox = [];
    this.hosted?.stop();
    this.hosted = null;
    this.hostedKey = '';
    this.snap = EMPTY;
  }

  // -- activar / desactivar -------------------------------------------------------------------
  activate(input: ActivateInput): string {
    const a = activate(this.state, { screen: input.screen, src: input.src }, input.ctx, this.max);
    this.state = a.state;
    for (const ev of a.evicted) this.dispose(ev.id);
    if (!this.rt.has(a.active.id)) {
      this.rt.set(a.active.id, {
        entry: a.active,
        appId: input.appId,
        sdkUrl: input.sdkUrl,
        cacheScope: input.cacheScope,
        readOnly: input.readOnly,
        attempt: 0,
        loaded: false,
        shown: false,
        failed: false,
        rect: null,
      });
      this.armLoadTimer(a.active.id);
    }
    this.ensureLive(input.appId, input.como);
    if (!input.readOnly) this.ensureOutbox(input.appId, input.cacheScope, input.sdkUrl);
    const prev = this.activeId;
    this.activeId = a.active.id;
    if (this.slot !== input.slot) {
      if (this.slot) this.observer?.unobserve(this.slot);
      this.slot = input.slot;
      this.observer?.observe(input.slot);
    }
    if (prev && prev !== a.active.id) this.postVisible(prev, false);
    this.postVisible(a.active.id, true);
    this.measure();
    this.emit();
    this.burst();
    return a.active.id;
  }

  /** Esta pantalla ya no está a la vista (se navegó): el marco queda vivo y oculto. */
  deactivate(id: string): void {
    if (this.activeId !== id) return;
    this.activeId = null;
    if (this.slot) this.observer?.unobserve(this.slot);
    this.slot = null;
    this.postVisible(id, false);
    this.emit();
  }

  retry(id: string): void {
    const r = this.rt.get(id);
    if (!r) return;
    r.attempt += 1;
    r.loaded = false;
    r.shown = false;
    r.failed = false;
    this.clearTimers(r);
    this.armLoadTimer(id);
    this.emit();
  }

  setIframe(id: string, el: HTMLIFrameElement | null): void {
    if (el) this.iframes.set(id, el);
    else this.iframes.delete(id);
  }

  onFrameLoad(id: string): void {
    const r = this.rt.get(id);
    if (!r) return;
    r.loaded = true;
    r.failed = false;
    if (r.failTimer) clearTimeout(r.failTimer);
    if (r.readyTimer) clearTimeout(r.readyTimer);
    // Una pantalla vieja que no avisa «listo» se muestra a los 1,5 s de cargar.
    r.readyTimer = setTimeout(() => this.markShown(id), READY_CAP_MS);
    this.postVisible(id, id === this.activeId);
    const status = this.live?.getStatus();
    if (status) this.post(id, { event: 'live-status', status });
    if (this.hosted) this.post(id, { event: 'outbox', state: this.hosted.box.state() });
    this.emit();
  }

  private markShown(id: string): void {
    const r = this.rt.get(id);
    if (!r || r.shown) return;
    r.shown = true;
    this.emit();
  }

  private armLoadTimer(id: string): void {
    const r = this.rt.get(id);
    if (!r) return;
    r.failTimer = setTimeout(() => {
      if (r.loaded) return;
      r.failed = true;
      this.emit();
    }, LOAD_TIMEOUT_MS);
  }

  private clearTimers(r: Runtime): void {
    if (r.failTimer) clearTimeout(r.failTimer);
    if (r.readyTimer) clearTimeout(r.readyTimer);
  }

  private dispose(id: string): void {
    const r = this.rt.get(id);
    if (r) this.clearTimers(r);
    this.live?.removeFrame(id);
    this.rt.delete(id);
    this.iframes.delete(id);
    if (this.activeId === id) this.activeId = null;
  }

  // -- mensajes -------------------------------------------------------------------------------
  private post(id: string, body: Record<string, unknown>): void {
    try {
      this.iframes.get(id)?.contentWindow?.postMessage({ cortex: 1, ...body }, '*');
    } catch {
      // El marco ya no existe.
    }
  }

  private postAll(body: Record<string, unknown>): void {
    for (const id of this.iframes.keys()) this.post(id, body);
  }

  private postVisible(id: string, visible: boolean): void {
    this.post(id, { event: 'visible', visible });
  }

  private onMessage = (event: MessageEvent): void => {
    for (const [id, el] of this.iframes) {
      if (el.contentWindow && el.contentWindow === event.source) {
        const ctx = this.bridgeCtx(id);
        if (ctx) void handleFrameMessage(ctx, event);
        return;
      }
    }
  };

  private bridgeCtx(id: string): FrameBridgeCtx | null {
    const r = this.rt.get(id);
    if (!r) return null;
    return {
      frameId: id,
      appId: r.appId,
      screen: r.entry.screen,
      sdkUrl: r.sdkUrl,
      cacheScope: r.cacheScope,
      readOnly: r.readOnly,
      win: () => this.iframes.get(id)?.contentWindow ?? null,
      isActive: () => this.activeId === id,
      controls: () => ({
        nav: this.controls?.nav ?? null,
        toast: this.controls?.toast ?? (() => undefined),
      }),
      onReady: () => this.markShown(id),
      setLiveTables: (tables) => {
        this.live?.setFrameTables(id, tables);
        return this.live?.getStatus() ?? 'off';
      },
      outbox: () => this.hosted?.box ?? null,
      outboxState: () => this.hosted?.box.state() ?? null,
    };
  }

  // -- canal en vivo y cola -------------------------------------------------------------------
  /** Algo cambió en esa tabla: se borra su caché y se avisa a los marcos que la miran. */
  private tableChanged(appId: string, table: string, at: string, interested: string[]): void {
    readCache.invalidateTable(appId, table);
    for (const id of interested) this.post(id, { event: 'changed', table, at });
  }

  private ensureLive(appId: string, como: string): void {
    const key = `${appId}\u0000${como}`;
    if (this.live && this.liveKey === key) return;
    // Cambió la app o «ver como…»: el canal viejo habla con otro rol.
    this.live?.close();
    this.liveKey = key;
    const extra = como ? `&${como.replace(/^\?/, '')}` : '';
    this.live = new AppLive({
      url: (tables) =>
        `/api/apps/${encodeURIComponent(appId)}/live?tables=${encodeURIComponent(tables.join(','))}${extra}`,
      makeSource: (url) => {
        if (typeof EventSource === 'undefined') throw new Error('sin EventSource');
        return new EventSource(url) as unknown as EventSourceLike;
      },
      onChange: (table, at, interested) => this.tableChanged(appId, table, at, interested),
      onStatus: (status) => {
        this.liveStatusCache = status;
        this.postAll({ event: 'live-status', status });
      },
    });
  }

  private ensureOutbox(appId: string, scope: string, sdkUrl: string): void {
    const key = `${appId}\u0000${scope}`;
    if (this.hosted && this.hostedKey === key) {
      this.hosted.urlRef.current = sdkUrl;
      return;
    }
    for (const off of this.offOutbox) off();
    this.offOutbox = [];
    this.hosted?.stop();
    const hosted = hostedOutbox(appId, scope, sdkUrl);
    this.hosted = hosted;
    this.hostedKey = key;
    const onState = (state: CodeOutboxState) => this.postAll({ event: 'outbox', state });
    const onSent = (table: string) =>
      this.tableChanged(appId, table, new Date().toISOString(), this.live?.framesFor(table) ?? []);
    hosted.stateListeners.add(onState);
    hosted.sentListeners.add(onSent);
    this.offOutbox.push(
      () => hosted.stateListeners.delete(onState),
      () => hosted.sentListeners.delete(onSent),
    );
  }

  /** Para pruebas y depuración. */
  liveStatus(): LiveStatus {
    return this.liveStatusCache;
  }

  // -- posición del marco activo sobre su hueco -----------------------------------------------
  measure = (): void => {
    const slot = this.slot;
    const wrap = this.wrap;
    if (!slot || !wrap || !this.activeId) return;
    const s = slot.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const next: Rect = {
      x: Math.round(s.left - w.left),
      y: Math.round(s.top - w.top),
      w: Math.round(s.width),
      h: Math.round(s.height),
    };
    const r = this.rt.get(this.activeId);
    if (!r) return;
    const cur = r.rect;
    if (cur && cur.x === next.x && cur.y === next.y && cur.w === next.w && cur.h === next.h) return;
    r.rect = next;
    this.emit();
  };

  /** Unos fotogramas de medición tras activar: la pantalla entra con una animación. */
  private burst(): void {
    if (typeof requestAnimationFrame === 'undefined') return;
    let n = 0;
    const step = () => {
      this.measure();
      if (++n < 45 && this.activeId) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
