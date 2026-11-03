'use client';

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
 *  - `nav.go` y `ui.toast` los resuelve el host aquí mismo.
 *  - Lo demás se reenvía a `/api/apps/<app>/code/<pantalla>/sdk`, donde el
 *    servidor decide el permiso con el rol de quien mira. Aquí nada se decide.
 *
 * Solo se atienden mensajes cuyo `event.source` es NUESTRO iframe. Las
 * respuestas van con '*' porque el origen del iframe es nulo; solo se envía la
 * respuesta a lo que pidió, nunca nada más.
 */

/** Operaciones que escriben: en «Ver como…» nunca salen del navegador. */
const WRITE_OPS = new Set(['tables.insert', 'tables.update', 'db.query', 'functions.call']);
/** Si el marco no termina de cargar en este tiempo, se ofrece reintentar. */
const LOAD_TIMEOUT_MS = 25_000;

interface Request {
  cortex: 1;
  id: string;
  op: string;
  args?: unknown;
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
      if (ro && WRITE_OPS.has(op)) {
        return reply({ ok: false, error: 'Estás viendo como otro rol: nada se guarda.' });
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, args: args ?? null }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: unknown;
        error?: string;
      } | null;
      if (!res.ok || json?.ok === false || json?.error) {
        return reply({
          ok: false,
          error: json?.error ?? 'No se pudo completar la operación. Intenta de nuevo.',
        });
      }
      return reply({ ok: true, data: json && 'data' in json ? json.data : json });
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
