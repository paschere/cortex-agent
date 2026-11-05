'use client';

import { confirmDialog } from '@/lib/ui/dialog-queue';
import { compressImage } from '@/lib/views/compress-image';
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
 *  - `nav.go`, `ui.toast`, `ui.confirm`, `ui.download` y `location.current` los resuelve el host
 *    aquí mismo (el iframe de origen nulo no puede: sin diálogos de Cortex, sin descargas
 *    propias, sin geolocalización).
 *  - `files.upload`, `docs.scan` y `voice.transcribe` llevan un archivo (los Blob viajan por
 *    postMessage): el host lo manda como multipart a la misma ruta.
 *  - Lo demás se reenvía a `/api/apps/<app>/code/<pantalla>/sdk`, donde el
 *    servidor decide el permiso con el rol de quien mira. Aquí nada se decide.
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
/** Si el marco no termina de cargar en este tiempo, se ofrece reintentar. */
const LOAD_TIMEOUT_MS = 25_000;

interface Request {
  cortex: 1;
  id: string;
  op: string;
  args?: unknown;
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
}: {
  /** El identificador de la app en las direcciones (slug o id). */
  appId: string;
  screen: string;
  /** Vista previa de una compilación concreta (solo administradores). */
  build?: string;
  readOnly?: boolean;
  /** «?como=…» de «Ver como…», con el signo de pregunta; vacío en el uso normal. */
  como?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const nav = useAppNav();
  const toast = useAppToast();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const base = `/api/apps/${encodeURIComponent(appId)}/code/${encodeURIComponent(screen)}`;
  const src = `${base}/frame${build ? `?build=${encodeURIComponent(build)}` : ''}`;
  const sdkUrl = `${base}/sdk${como}`;

  // Los controladores cambian de identidad; el oyente lee siempre los últimos.
  const latest = useRef({ nav, toast, readOnly, sdkUrl });
  latest.current = { nav, toast, readOnly, sdkUrl };

  const onMessage = useCallback(async (event: MessageEvent) => {
    const win = frame.current?.contentWindow;
    if (!win || event.source !== win) return;
    if (!isRequest(event.data)) return;
    const { id, op, args } = event.data;
    const reply = (body: { ok: true; data: unknown } | { ok: false; error: string }) =>
      win.postMessage({ cortex: 1, id, ...body }, '*');
    const { nav: appNav, toast: pushToast, readOnly: ro, sdkUrl: url } = latest.current;

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
      const fileKey = FILE_OPS[op];
      if (fileKey) {
        const raw = (args ?? {}) as Record<string, unknown>;
        const { [fileKey]: blob, ...rest } = raw;
        const file = await prepareFile(blob, rest.name);
        if (typeof file === 'string') return reply({ ok: false, error: file });
        return reply(await callSdk(url, op, rest, file));
      }
      return reply(await callSdk(url, op, args));
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
    setFailed(false);
    const t = setTimeout(() => setFailed(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [src, attempt]);

  useEffect(() => {
    if (loaded) setFailed(false);
  }, [loaded]);

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
      {!loaded && (
        <div aria-busy="true" className="absolute inset-0 space-y-3">
          <output className="sr-only">Cargando la pantalla</output>
          <SkeletonBlock className="h-7 w-44 !rounded-pill" />
          <SkeletonBlock className="h-40 w-full !rounded-card" />
          <SkeletonBlock className="h-40 w-full !rounded-card" />
        </div>
      )}
      <iframe
        key={`${src}:${attempt}`}
        ref={frame}
        title={`Pantalla ${screen}`}
        src={src}
        sandbox="allow-scripts allow-forms allow-popups allow-downloads"
        onLoad={() => setLoaded(true)}
        className="h-full w-full rounded-card border-0 bg-transparent"
        style={{ opacity: loaded ? 1 : 0 }}
      />
    </div>
  );
}
