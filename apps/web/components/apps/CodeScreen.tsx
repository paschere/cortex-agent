'use client';

import { PREFILL_PARAM, decodePrefill } from '@/lib/apps/after-submit';
import { INVALIDATING_OPS, READ_OPS, readCache, serveRead } from '@/lib/apps/code-read-cache';
import { PRINT_MAX_BYTES, buildPrintDoc } from '@/lib/apps/print-html';
import { confirmDialog } from '@/lib/ui/dialog-queue';
import { compressImage } from '@/lib/views/compress-image';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppErrorState } from './AppErrorState';
import { useAppNav } from './AppNav';
import { SkeletonBlock } from './AppSkeleton';
import { useAppToast } from './AppToast';

/**
 * UNA PANTALLA CON CÓDIGO (apps con código, fase 1).
 *
 * El código de la pantalla corre en un iframe con origen nulo
 * (`sandbox` sin `allow-same-origin`): no ve cookies, ni la sesión, ni el DOM de
 * Cortex. Para todo lo demás habla con este componente por `postMessage`
 * (`{cortex:1, id, op, args}` → `{cortex:1, id, ok, data | error}`):
 *
 *  - `nav.go`, `ui.toast`, `ui.confirm`, `ui.download`, `ui.print` y `location.current` los resuelve el host
 *    aquí mismo (el iframe de origen nulo no puede: sin diálogos de Cortex, sin descargas
 *    propias, sin geolocalización).
 *  - `files.upload`, `docs.scan` y `voice.transcribe` llevan un archivo (los Blob viajan por
 *    postMessage): el host lo manda como multipart a la misma ruta.
 *  - Lo demás se reenvía a `/api/apps/<app>/code/<pantalla>/sdk`, donde el
 *    servidor decide el permiso con el rol de quien mira. Aquí nada se decide.
 *
 * Las lecturas pasan por una caché de módulo (`lib/apps/code-read-cache.ts`): se contesta al
 * instante con lo guardado (< 60 s) y se manda el dato fresco como `{cortex:1, update:true, id,
 * data}`; cualquier escritura la vacía. Cuando la pantalla avisa `{cortex:1, ready:true}` (primer
 * render listo) se muestra el marco con un fundido.
 *
 * Solo se atienden mensajes cuyo `event.source` es NUESTRO iframe. Las
 * respuestas van con '*' porque el origen del iframe es nulo; solo se envía la
 * respuesta a lo que pidió, nunca nada más.
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
const READY_CAP_MS = 1_500;
/** Si el marco no termina de cargar en este tiempo, se ofrece reintentar. */
const LOAD_TIMEOUT_MS = 25_000;

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

/** Las demás pantallas con código de la app, para precargar sus bundles y sus rutas. */
export interface CodePrefetch {
  buildId: string;
  screens: Array<{ slug: string; href: string }>;
}

/** Llama al servidor del SDK y devuelve `{ok,data|error}`; con `file`, como multipart. */
async function callSdk(
  url: string,
  op: string,
  args: unknown,
  file?: File,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  let init: RequestInit;
  if (file) {
    const form = new FormData();
    form.set('op', op);
    form.set('args', JSON.stringify(args ?? null));
    form.set('file', file, file.name);
    init = { method: 'POST', body: form };
  } else {
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, args: args ?? null }),
    };
  }
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => null)) as {
    ok?: boolean;
    data?: unknown;
    error?: string;
  } | null;
  if (!res.ok || json?.ok === false || json?.error) {
    return {
      ok: false,
      error: json?.error ?? 'No se pudo completar la operación. Intenta de nuevo.',
    };
  }
  return { ok: true, data: json && 'data' in json ? json.data : json };
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

function isRequest(data: unknown): data is Request {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.cortex === 1 && typeof d.id === 'string' && typeof d.op === 'string' && !('ok' in d);
}

export function CodeScreen({
  appId,
  screen,
  build,
  readOnly = false,
  como = '',
  cacheScope = '',
  prefetch,
}: {
  /** El identificador de la app en las direcciones (slug o id). */
  appId: string;
  screen: string;
  /** Vista previa de una compilación concreta (solo administradores). */
  build?: string;
  readOnly?: boolean;
  /** «?como=…» de «Ver como…», con el signo de pregunta; vacío en el uso normal. */
  como?: string;
  /** Quién mira (rol y persona): cambia → no se reusa lo guardado de otro. */
  cacheScope?: string;
  /** Pantallas hermanas con código y la compilación publicada, para precargar. */
  prefetch?: CodePrefetch;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const nav = useAppNav();
  const toast = useAppToast();
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const base = `/api/apps/${encodeURIComponent(appId)}/code/${encodeURIComponent(screen)}`;
  // Lo prellenado con `nav.go({ screen, prefill })` llega a la pantalla como parámetros de su dirección.
  const pre = decodePrefill(useSearchParams()?.get(PREFILL_PARAM));
  delete pre.build;
  const frameQuery = new URLSearchParams(pre);
  if (build) frameQuery.set('build', build);
  const qs = frameQuery.toString();
  const src = `${base}/frame${qs ? `?${qs}` : ''}`;
  const sdkUrl = `${base}/sdk${como}`;

  // Los controladores cambian de identidad; el oyente lee siempre los últimos.
  const cacheKeyScope = `${cacheScope}|${como}`;
  const latest = useRef({ nav, toast, readOnly, sdkUrl, appId, cacheKeyScope });
  latest.current = { nav, toast, readOnly, sdkUrl, appId, cacheKeyScope };

  const onMessage = useCallback(async (event: MessageEvent) => {
    const win = frame.current?.contentWindow;
    if (!win || event.source !== win) return;
    if (isReady(event.data)) {
      setShown(true);
      return;
    }
    if (!isRequest(event.data)) return;
    const { id, op, args, upd } = event.data;
    const reply = (body: { ok: true; data: unknown } | { ok: false; error: string }) =>
      win.postMessage({ cortex: 1, id, ...body }, '*');
    const {
      nav: appNav,
      toast: pushToast,
      readOnly: ro,
      sdkUrl: url,
      appId: app,
      cacheKeyScope: scope,
    } = latest.current;

    try {
      if (op === 'ui.toast') {
        const text = (args as { text?: unknown } | null)?.text;
        if (typeof text === 'string' && text.trim()) pushToast({ text: text.slice(0, 200) });
        return reply({ ok: true, data: null });
      }
      if (op === 'nav.go') {
        const a = (args ?? {}) as { screen?: unknown; prefill?: Record<string, string | number> };
        if (typeof a.screen !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(a.screen)) {
          return reply({ ok: false, error: 'Esa pantalla no existe.' });
        }
        if (!appNav) return reply({ ok: false, error: 'No se puede navegar desde aquí.' });
        appNav.goThen({ screen: a.screen, prefill: a.prefill }, {});
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
      // Una escritura vacía lo guardado de la app, antes (nadie lee lo viejo mientras corre) y después.
      const invalidates = INVALIDATING_OPS.has(op);
      if (invalidates) readCache.invalidate(app);
      try {
        const fileKey = FILE_OPS[op];
        if (fileKey) {
          const raw = (args ?? {}) as Record<string, unknown>;
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
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => void onMessage(e);
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onMessage]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: cada intento o cambio de dirección reinicia la espera.
  useEffect(() => {
    setLoaded(false);
    setShown(false);
    setFailed(false);
    const t = setTimeout(() => setFailed(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [src, attempt]);

  useEffect(() => {
    if (loaded) setFailed(false);
  }, [loaded]);

  // Se muestra con el aviso «listo»; una pantalla vieja que no lo manda sale a los 1,5 s de cargar.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => setShown(true), READY_CAP_MS);
    return () => clearTimeout(t);
  }, [loaded]);

  // Precarga: con el navegador ocioso, los bundles (y rutas) de las demás pantallas con código.
  useEffect(() => {
    if (!loaded || !prefetch || prefetch.screens.length === 0) return;
    const conn = (
      navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
    ).connection;
    if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '')) return;
    const links: HTMLLinkElement[] = [];
    const run = () => {
      for (const sc of prefetch.screens) {
        if (sc.slug === screen) continue;
        router.prefetch(sc.href);
        // El css solo existe en algunas; un 404 de prefetch no molesta, pero no se pide a ciegas.
        const l = document.createElement('link');
        l.rel = 'prefetch';
        l.href = `/api/apps/code/bundle/${prefetch.buildId}/${encodeURIComponent(sc.slug)}.js`;
        document.head.appendChild(l);
        links.push(l);
      }
    };
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const handle = w.requestIdleCallback
      ? w.requestIdleCallback(run)
      : window.setTimeout(run, 1_500);
    return () => {
      if (w.requestIdleCallback && w.cancelIdleCallback) w.cancelIdleCallback(handle);
      else clearTimeout(handle);
      for (const l of links) l.remove();
    };
  }, [loaded, prefetch, screen, router]);

  if (failed && !loaded) {
    return (
      <AppErrorState
        error={new Error(`La pantalla ${screen} no cargó`)}
        reset={() => setAttempt((n) => n + 1)}
        title="No pudimos cargar esta pantalla"
      />
    );
  }

  return (
    <div className="relative" style={{ height: 'calc(100dvh - 9rem)', minHeight: '28rem' }}>
      {/* El esqueleto conserva la altura y se funde cuando el marco ya pintó (no salta). */}
      <div
        aria-busy={!shown}
        aria-hidden={shown}
        className="pointer-events-none absolute inset-0 space-y-3 transition-opacity duration-200 ease-out motion-reduce:transition-none"
        style={{ opacity: shown ? 0 : 1 }}
      >
        {!shown && <output className="sr-only">Cargando la pantalla</output>}
        <SkeletonBlock className="h-7 w-44 !rounded-pill" />
        <SkeletonBlock className="h-40 w-full !rounded-card" />
        <SkeletonBlock className="h-40 w-full !rounded-card" />
      </div>
      <iframe
        key={`${src}:${attempt}`}
        ref={frame}
        title={`Pantalla ${screen}`}
        src={src}
        sandbox="allow-scripts allow-forms allow-popups allow-downloads"
        onLoad={() => setLoaded(true)}
        className="h-full w-full rounded-card border-0 bg-transparent transition-opacity duration-200 ease-out motion-reduce:transition-none"
        style={{ opacity: shown ? 1 : 0 }}
      />
    </div>
  );
}
