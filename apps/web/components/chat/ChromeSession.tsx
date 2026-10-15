'use client';

import { type BrowserStep, hostOf } from '@/lib/browser-live-steps';
import { clsx } from 'clsx';
import { Hand, Loader2, OctagonX, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * LA PANTALLA DE «CORTEX EN TU CHROME» EN EL PANEL «NAVEGADOR».
 *
 * La pestaña vive en el Chrome de la persona, no en nuestro servicio, así que
 * no hay transmisión en vivo: se ve el estado (a qué sitio entró, cuántas
 * acciones lleva, si espera algo de ella) y la última foto chica que dejó la
 * extensión. Los pasos de abajo salen de las invocaciones, igual que en la
 * pestaña de la nube. «Detener» corta la sesión al instante (la extensión se
 * entera en su próxima espera y la barra de la pestaña desaparece).
 */

interface SessionState {
  status: 'open' | 'closed' | 'stopped';
  awaiting: { kind: 'help' | 'secret'; text: string } | null;
  url: string | null;
  title: string | null;
  actions: number;
  cap: number;
  deviceName: string | null;
  deviceOnline: boolean;
}

export function ChromeSessionScreen({
  sessionId,
  lastShot,
  running,
  onSay,
  onStopped,
}: {
  sessionId: string;
  lastShot: string | null;
  running: string | null;
  onSay?: (text: string) => void;
  onStopped?: () => void;
}) {
  const [state, setState] = useState<SessionState | null>(null);
  const [stopping, setStopping] = useState(false);
  const awaitingRef = useRef<SessionState['awaiting']>(null);
  const [shotFailed, setShotFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: otra foto, otra oportunidad.
  useEffect(() => setShotFailed(false), [lastShot]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/browser/chrome/sessions/${encodeURIComponent(sessionId)}`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const next = (await res.json()) as SessionState;
      const before = awaitingRef.current;
      awaitingRef.current = next.awaiting;
      // La persona terminó lo que Cortex le pidió: se lo decimos en su nombre,
      // con las mismas frases de control que usa la pestaña de la nube.
      if (before && !next.awaiting && next.status === 'open' && onSay) {
        onSay(
          before.kind === 'secret'
            ? `Ya escribí «${before.text}» en la página. Sigue.`
            : 'Ya terminé en la página. Mira cómo quedó y sigue.',
        );
      }
      setState(next);
    } catch {
      // Una lectura fallida no cambia lo que se ve.
    }
  }, [sessionId, onSay]);

  useEffect(() => {
    void poll();
    const t = window.setInterval(() => void poll(), 2_500);
    return () => window.clearInterval(t);
  }, [poll]);

  const stop = async () => {
    setStopping(true);
    try {
      await fetch(`/api/browser/chrome/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      await poll();
      onStopped?.();
    } finally {
      setStopping(false);
    }
  };

  const open = !state || state.status === 'open';
  const host = state?.url ? hostOf(state.url) : '';
  return (
    <section
      aria-label="Cortex en tu Chrome"
      className="flex flex-col gap-3 rounded-card border border-border bg-surface-2 p-3"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface text-primary">
          <ShieldCheck className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">
            {open
              ? 'Cortex trabaja en tu Chrome'
              : state?.status === 'stopped'
                ? 'Detuviste a Cortex en tu Chrome'
                : 'La sesión en tu Chrome se cerró'}
          </p>
          <p className="truncate text-xs text-ink-muted" title={state?.title ?? undefined}>
            {host
              ? `${host}${state?.title ? ` · ${state.title}` : ''}`
              : (state?.deviceName ?? 'Conectando…')}
          </p>
          {state ? (
            <p className="tabular mt-0.5 text-xs text-ink-faint">
              {state.actions} de {state.cap} acciones
              {open && !state.deviceOnline ? ' · tu Chrome no responde' : ''}
            </p>
          ) : null}
        </div>
        {open ? (
          <button
            type="button"
            onClick={stop}
            disabled={stopping}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-pill bg-rose px-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {stopping ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <OctagonX className="h-3.5 w-3.5" aria-hidden />
            )}
            Detener
          </button>
        ) : null}
      </div>

      {state?.awaiting && open ? (
        <p className="flex items-start gap-2 rounded-lg border border-amber/30 bg-amber-soft px-3 py-2 text-sm text-ink">
          <Hand className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
          <span className="[overflow-wrap:anywhere]">
            {state.awaiting.kind === 'secret'
              ? `Escribe «${state.awaiting.text}» en la pestaña de tu Chrome y pulsa «Ya lo escribí» en la franja de arriba.`
              : `Cortex te pide ayuda en tu Chrome: ${state.awaiting.text}. Cuando termines, pulsa «Ya terminé» en la franja de la pestaña.`}
          </span>
        </p>
      ) : running && open ? (
        <p className="flex items-center gap-2 text-xs text-ink-muted">
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden
          />
          {running}
        </p>
      ) : null}

      {lastShot && !shotFailed ? (
        <img
          src={lastShot}
          alt="Última foto de tu pestaña"
          loading="lazy"
          decoding="async"
          onError={() => setShotFailed(true)}
          className={clsx(
            'w-full rounded-lg border border-border object-contain',
            !open && 'opacity-60',
          )}
        />
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-ink-muted">
          Aquí aparece una foto de tu pestaña después de cada paso.
        </p>
      )}
      <p className="text-xs text-ink-faint">
        No hay transmisión en vivo: la pantalla es tu propio Chrome. Cortex no ve las contraseñas
        que escribes.
      </p>
    </section>
  );
}

export function lastShotOf(steps: BrowserStep[], sessionId: string): string | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = steps[i];
    if (s?.thumb && (s.sessionId === sessionId || s.sessionId === null)) return s.thumb;
  }
  return null;
}
