import { PRINT_MAX_BYTES, buildPrintDoc } from '@/lib/apps/print-html';
import { INVALIDATING_OPS, READ_OPS, readCache, serveRead } from '@/lib/apps/code-read-cache';
import { CODE_OPS, type CodeOpName, type CodeOutbox, rowIdOf } from '@/lib/apps/code-outbox';
import type { CodeOutboxState } from '@/lib/apps/code-outbox';
import { callSdk } from '@/lib/apps/code-sdk-call';
import { isOfflineFailure } from '@/lib/views/offline-queue';
import { confirmDialog } from '@/lib/ui/dialog-queue';
import { compressImage } from '@/lib/views/compress-image';
import type { LiveStatus } from '@/lib/apps/code-live';
import type { PrefillSource, ThenNav } from '@/lib/apps/after-submit';

/**
 * EL PUENTE DEL PADRE para UN marco de una pantalla con código: atiende cada mensaje
 * `{cortex:1, id, op, args}` que llega de su iframe (de origen nulo) y contesta con
 * `{cortex:1, id, ok, data | error}`. Es lo que antes vivía dentro de CodeScreen.tsx; ahora
 * está aparte porque el marco sigue vivo (oculto) cuando la pantalla deja de estar a la vista.
 *
 *  - `nav.go`, `ui.toast`, `ui.confirm`, `ui.download`, `ui.print` y `location.current` los
 *    resuelve el host aquí mismo, y SOLO si el marco es el que está a la vista (uno oculto no
 *    puede abrir diálogos, navegar ni imprimir).
 *  - `files.upload`, `docs.scan` y `voice.transcribe` llevan un archivo (multipart).
 *  - `live.set` declara las tablas que mira el marco (canal en vivo); `outbox.*` maneja la cola
 *    sin señal. Las escrituras con `offline: true` se guardan en el teléfono si no hay red.
 *  - Lo demás va a `/api/apps/<app>/code/<pantalla>/sdk`; el servidor decide el permiso.
 *  - Las lecturas pasan por la caché del padre (`code-read-cache.ts`).
 */

/** Operaciones que escriben: en «Ver como…» nunca salen del navegador. */
const WRITE_OPS = new Set([
  'tables.insert',
  'tables.update',
  'tables.action',
  'files.upload',
  'db.query',
  'functions.call',
]);
/** Las que mandan un archivo: op → la clave de los argumentos donde viene el Blob. */
const FILE_OPS: Record<string, string> = {
  'files.upload': 'file',
  'docs.scan': 'file',
  'voice.transcribe': 'audio',
};
/** Lo que cabe en el cuerpo de una función de Vercel (4,5 MB) con margen. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const GEO_TIMEOUT_MS = 12_000;
/** Si el marco carga pero no avisa «listo» (compilaciones viejas), se muestra pasado este tiempo. */
export const READY_CAP_MS = 1_500;
/** Si el marco no termina de cargar en este tiempo, se ofrece reintentar. */
export const LOAD_TIMEOUT_MS = 25_000;

interface Request {
  cortex: 1;
  id: string;
  op: string;
  args?: unknown;
  /** El SDK de la pantalla entiende la segunda respuesta (`update`). */
  upd?: boolean;
}

/** Aviso del marco: primer render hecho. */
function isReady(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.cortex === 1 && d.ready === true;
}

/** El Blob que mandó la pantalla, como File listo para subir (las fotos, comprimidas). */
async function prepareFile(blob: unknown, name: unknown): Promise<File | string> {
  if (!(blob instanceof Blob)) return 'No llegó ningún archivo.';
  const given = typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : '';
  const base =
    blob instanceof File && blob.name
      ? blob.name
      : given || (blob.type.startsWith('audio/') ? 'audio' : 'archivo');
  let file = blob instanceof File ? blob : new File([blob], base, { type: blob.type });
  if (file.type.startsWith('image/') && file.type !== 'image/gif') file = await compressImage(file);
  if (file.size > MAX_FILE_BYTES)
    return 'El archivo pesa más de 4 MB. Usa una foto más pequeña o un archivo más liviano.';
  return file;
}

/** La posición del navegador, o null si no hay señal o la persona no dio permiso. */
function browserPosition(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 10_000 },
    );
  });
}

/** `ui.download`: baja un archivo desde el marco (el iframe sandbox no puede). */
function downloadFile(filename: string, data: Blob | string, mime?: string) {
  const blob =
    data instanceof Blob ? data : new Blob([data], { type: mime || 'text/plain;charset=utf-8' });
  const safe =
    Array.from(filename)
      .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? '_' : c))
      .join('')
      .slice(0, 120) || 'archivo';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safe;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * `ui.print`: imprime un HTML de la app en un iframe oculto SIN scripts (`allow-same-origin`
 * solo para poder llamar a print() desde aquí; `allow-modals` para el diálogo). El HTML ya va
 * saneado. Se retira al terminar de imprimir o por tiempo; nunca toca el DOM de Cortex.
 */
function printHtml(html: string, title?: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText =
      'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none';
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      frame.remove();
      resolve();
    };
    frame.addEventListener('load', async () => {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc) return cleanup();
      try {
        // Espera a las imágenes (tope de 5 s) para no imprimir en blanco.
        const pending = Array.from(doc.images)
          .filter((img) => !img.complete)
          .map(
            (img) =>
              new Promise<void>((r) => {
                img.addEventListener('load', () => r(), { once: true });
                img.addEventListener('error', () => r(), { once: true });
              }),
          );
        if (pending.length) {
          await Promise.race([Promise.all(pending), new Promise<void>((r) => setTimeout(r, 5000))]);
        }
        win.addEventListener('afterprint', () => setTimeout(cleanup, 200), { once: true });
        win.focus();
        win.print();
      } catch {
        return cleanup();
      }
      // Respaldo: algunos navegadores no avisan afterprint.
      setTimeout(cleanup, 120_000);
    });
    frame.srcdoc = buildPrintDoc(html, title);
    document.body.appendChild(frame);
  });
}

/** Lo que la pantalla a la vista le presta al puente: navegar y avisar. */
export interface Controls {
  nav: { goThen(then: ThenNav, source: PrefillSource): void } | null;
  toast: (t: { text: string }) => void;
}

/** Lo que el puente necesita saber del marco al que atiende. */
export interface FrameBridgeCtx {
  frameId: string;
  appId: string;
  screen: string;
  sdkUrl: string;
  /** Rol y persona: parte de la clave de la caché. */
  cacheScope: string;
  readOnly: boolean;
  win(): Window | null;
  /** ¿Es el marco que está a la vista? Solo él puede abrir diálogos, navegar, imprimir… */
  isActive(): boolean;
  controls(): Controls;
  onReady(): void;
  setLiveTables(tables: string[]): LiveStatus;
  outbox(): CodeOutbox | null;
  outboxState(): CodeOutboxState | null;
}

function isRequest(data: unknown): data is Request {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.cortex === 1 && typeof d.id === 'string' && typeof d.op === 'string' && !('ok' in d);
}

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Las escrituras que pueden esperar señal y su tabla. */
function tableOf(args: Record<string, unknown>): string {
  return typeof args.table === 'string' ? args.table : '';
}

export async function handleFrameMessage(ctx: FrameBridgeCtx, event: MessageEvent): Promise<void> {
  const win = ctx.win();
  if (!win || event.source !== win) return;
  if (isReady(event.data)) return ctx.onReady();
  if (!isRequest(event.data)) return;
  const { id, op, args, upd } = event.data;
  const reply = (body: { ok: true; data: unknown } | { ok: false; error: string }) =>
    win.postMessage({ cortex: 1, id, ...body }, '*');
  const app = ctx.appId;
  const url = ctx.sdkUrl;
  const scope = ctx.cacheScope;
  const ro = ctx.readOnly;
  const HOST_ONLY = new Set([
    'ui.toast',
    'nav.go',
    'ui.confirm',
    'ui.download',
    'ui.print',
    'location.current',
  ]);
  // Un marco oculto (iframe vivo) no puede abrir diálogos, navegar, imprimir ni pedir la ubicación.
  if (HOST_ONLY.has(op) && !ctx.isActive())
    return reply({ ok: false, error: 'La pantalla no está a la vista.' });

  try {
    if (op === 'ui.toast') {
      const text = (args as { text?: unknown } | null)?.text;
      if (typeof text === 'string' && text.trim())
        ctx.controls().toast({ text: text.slice(0, 200) });
      return reply({ ok: true, data: null });
    }
    if (op === 'nav.go') {
      const a = (args ?? {}) as { screen?: unknown; prefill?: Record<string, string | number> };
      if (typeof a.screen !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(a.screen)) {
        return reply({ ok: false, error: 'Esa pantalla no existe.' });
      }
      const nav = ctx.controls().nav;
      if (!nav) return reply({ ok: false, error: 'No se puede navegar desde aquí.' });
      nav.goThen({ screen: a.screen, prefill: a.prefill }, {});
      return reply({ ok: true, data: null });
    }
    if (op === 'ui.confirm') {
      const a = (args ?? {}) as { text?: unknown; confirmLabel?: unknown; danger?: unknown };
      const text = typeof a.text === 'string' ? a.text.trim().slice(0, 300) : '';
      if (!text) return reply({ ok: false, error: 'Falta el texto de la pregunta.' });
      const yes = await confirmDialog({
        title: text,
        confirmLabel:
          typeof a.confirmLabel === 'string' && a.confirmLabel.trim()
            ? a.confirmLabel.trim().slice(0, 40)
            : 'Confirmar',
        tone: a.danger === true ? 'danger' : 'default',
      });
      return reply({ ok: true, data: yes });
    }
    if (op === 'ui.download') {
      const a = (args ?? {}) as { filename?: unknown; data?: unknown; mime?: unknown };
      if (typeof a.filename !== 'string' || !a.filename.trim())
        return reply({ ok: false, error: 'Falta el nombre del archivo.' });
      if (!(a.data instanceof Blob) && typeof a.data !== 'string')
        return reply({ ok: false, error: 'Falta el contenido del archivo.' });
      downloadFile(a.filename, a.data, typeof a.mime === 'string' ? a.mime : undefined);
      return reply({ ok: true, data: null });
    }
    if (op === 'ui.print') {
      const a = (args ?? {}) as { html?: unknown; title?: unknown };
      if (typeof a.html !== 'string' || !a.html.trim())
        return reply({ ok: false, error: 'Falta el contenido a imprimir.' });
      if (new Blob([a.html]).size > PRINT_MAX_BYTES)
        return reply({
          ok: false,
          error: 'Lo que se quiere imprimir es demasiado grande (máx. 2 MB).',
        });
      void printHtml(a.html, typeof a.title === 'string' ? a.title : undefined);
      return reply({ ok: true, data: null });
    }
    if (op === 'location.current') {
      // El consentimiento de la app manda: si comparte ubicación y la persona no aceptó, no se pide.
      const status = await callSdk(url, 'location.status', null);
      if (!status.ok) return reply(status);
      const st = status.data as { enabled?: boolean; canShare?: boolean; consented?: boolean };
      if (st.enabled && st.canShare && !st.consented) return reply({ ok: true, data: null });
      const pos = await browserPosition();
      if (!pos) return reply({ ok: true, data: null });
      const zone = await callSdk(url, 'location.evaluate', pos);
      if (!zone.ok) return reply(zone);
      const z = zone.data as { zone: string | null; inside: boolean | null };
      return reply({ ok: true, data: { ...pos, zone: z.zone, inside: z.inside } });
    }

    // --- canal en vivo y cola sin señal -------------------------------------------------------
    if (op === 'live.set') {
      const raw = (args as { tables?: unknown } | null)?.tables;
      const tables = Array.isArray(raw)
        ? raw
            .filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 80)
            .slice(0, 12)
        : [];
      return reply({ ok: true, data: { status: ctx.setLiveTables(tables) } });
    }
    if (op === 'outbox.list') {
      const st = ctx.outboxState();
      return reply({
        ok: true,
        data: st ?? { items: [], pending: 0, failed: 0, online: online() },
      });
    }
    if (op === 'outbox.retry') {
      await ctx.outbox()?.retry();
      return reply({ ok: true, data: null });
    }
    if (op === 'outbox.discard') {
      const localId = (args as { localId?: unknown } | null)?.localId;
      if (typeof localId !== 'string' || !localId)
        return reply({ ok: false, error: 'Falta la operación a descartar.' });
      await ctx.outbox()?.discard(localId);
      return reply({ ok: true, data: null });
    }

    if (ro && WRITE_OPS.has(op)) {
      return reply({ ok: false, error: 'Estás viendo como otro rol: nada se guarda.' });
    }
    if (READ_OPS.has(op)) {
      return await serveRead({
        cache: readCache,
        appId: app,
        scope,
        op,
        args,
        wantsUpdate: upd === true,
        fetchFresh: () => callSdk(url, op, args),
        reply,
        update: (data) => win.postMessage({ cortex: 1, update: true, id, data }, '*'),
      });
    }

    // --- escrituras con `offline: true`: si no hay red, se guardan en el teléfono ------------
    const raw = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    if (raw.offline === true && CODE_OPS.has(op)) {
      const box = ctx.outbox();
      const { offline: _o, ...rest } = raw;
      if (!box) return reply({ ok: false, error: 'Aquí no se pueden guardar cambios sin señal.' });
      let file: File | undefined;
      let plain = rest;
      if (op === 'files.upload') {
        const { file: blob, ...r } = rest;
        const prepared = await prepareFile(blob, r.name);
        if (typeof prepared === 'string') return reply({ ok: false, error: prepared });
        file = prepared;
        plain = r;
      }
      const table = tableOf(plain);
      // Si algo de esa fila (o una referencia local) ya espera en la cola, esto va detrás: el orden manda.
      const rowId = op === 'tables.insert' ? '' : rowIdOf(plain);
      const mustQueue =
        !online() ||
        box.dependsOnQueued(plain) ||
        (rowId !== '' && box.hasPendingFor(table, rowId));
      if (!mustQueue) {
        readCache.invalidate(app);
        try {
          const res = await callSdk(url, op, box.resolveArgs(plain), file);
          if (res.ok) return reply(res);
          // Un «no» por los datos o el permiso se muestra; un 5xx/429 se guarda para reintentar.
          if (!isOfflineFailure({ online: true, status: res.status })) return reply(res);
        } catch {
          // Sin red de verdad aunque el navegador diga que sí: se guarda.
        } finally {
          readCache.invalidate(app);
        }
      }
      const queued = await box.enqueue({ op: op as CodeOpName, args: plain, file });
      return reply({ ok: true, data: queued });
    }

    // Una escritura vacía lo guardado de la app, antes (nadie lee lo viejo mientras corre) y después.
    const invalidates = INVALIDATING_OPS.has(op);
    if (invalidates) readCache.invalidate(app);
    try {
      const fileKey = FILE_OPS[op];
      if (fileKey) {
        const { [fileKey]: blob, ...rest } = raw;
        const file = await prepareFile(blob, rest.name);
        if (typeof file === 'string') return reply({ ok: false, error: file });
        return reply(await callSdk(url, op, rest, file));
      }
      return reply(await callSdk(url, op, args));
    } finally {
      if (invalidates) readCache.invalidate(app);
    }
  } catch {
    reply({ ok: false, error: 'Sin conexión. Revisa la señal e intenta de nuevo.' });
  }
}
