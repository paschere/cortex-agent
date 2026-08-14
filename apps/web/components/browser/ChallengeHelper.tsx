'use client';

import { clsx } from 'clsx';
import { Loader2, ShieldQuestion } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/**
 * THE CAPTCHA, HANDED TO A PERSON.
 *
 * A trámite replays with no model in the loop, so when a portal stops to ask
 * «¿eres un robot?» there is nobody in the loop to answer. The browser service
 * now keeps that tab alive for a few minutes instead of destroying it; this is
 * the window onto it. Somebody ticks the box and the errand carries on from the
 * step it stopped at, in the same session — which is the only place the unlock
 * counts for anything.
 *
 * A PICTURE AND A CLICK, NOT A REMOTE DESKTOP. It polls a screenshot and sends
 * coordinates. That is unglamorous and it is the right amount of machinery: a
 * captcha widget lives in a cross-origin iframe with no accessible name, so
 * there is nothing to address it by, and a person looking at an image and
 * clicking on it is the only thing that works. Anything richer — a live stream,
 * a CDP bridge — would be a permanent second way to drive a browser, built for
 * a job that takes eight seconds.
 *
 * THE CLOCK IS ON SCREEN because the tab really does go away. A window that
 * silently stops working teaches people the feature is broken; one that says
 * «quedan 2:14» teaches them to hurry.
 */

interface View {
  png: string;
  url: string;
  title: string;
  width: number;
  height: number;
}

export interface ChallengeHandoff {
  sessionId: string;
  fromIndex: number;
  expiresAt: string;
}

/** How often the picture is refreshed while nobody is doing anything. */
const IDLE_POLL_MS = 2_500;

export function ChallengeHelper({
  handoff,
  onFinished,
}: {
  handoff: ChallengeHandoff;
  /** The errand ran to its end, or died again. Either way this window is done. */
  onFinished: (result: { ok: boolean; message: string }) => void;
}) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [msLeft, setMsLeft] = useState(() => Date.parse(handoff.expiresAt) - Date.now());

  const expired = msLeft <= 0;

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/browser/session/${handoff.sessionId}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? 'No pude ver la pantalla del navegador.');
      return;
    }
    setView((await res.json()) as View);
    setError(null);
  }, [handoff.sessionId]);

  // First picture, then a slow poll. Stopped once the session is gone or the
  // errand has been handed back: polling a dead tab is a request per two
  // seconds that can only ever return the same error.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (error || resuming || expired) return;
    const t = setInterval(() => void refresh(), IDLE_POLL_MS);
    return () => clearInterval(t);
  }, [refresh, error, resuming, expired]);

  useEffect(() => {
    const t = setInterval(() => setMsLeft(Date.parse(handoff.expiresAt) - Date.now()), 1_000);
    return () => clearInterval(t);
  }, [handoff.expiresAt]);

  async function send(body: Record<string, unknown>) {
    if (busy || resuming || expired) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/browser/session/${handoff.sessionId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? 'No pude enviar eso al navegador.');
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Where the click landed on the REAL page, not on the picture.
   *
   * The screenshot is drawn at whatever width the layout gives it and the tab
   * is a fixed 1366×900, so a click has to be scaled back. Read off the
   * element's own box rather than assumed, because the same component has to
   * work in a narrow column and on a wide screen.
   */
  function handleClick(e: React.MouseEvent<HTMLImageElement>) {
    if (!view) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    void send({
      kind: 'click',
      x: ((e.clientX - box.left) / box.width) * view.width,
      y: ((e.clientY - box.top) / box.height) * view.height,
    });
  }

  async function resume() {
    setResuming(true);
    setError(null);
    try {
      const res = await fetch(`/api/browser/session/${handoff.sessionId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'continue', fromIndex: handoff.fromIndex }),
      });
      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        failure?: { label?: string; error?: string };
      } | null;
      if (!res.ok) {
        setError(payload?.error ?? 'No pude retomar el trámite.');
        setResuming(false);
        return;
      }
      onFinished(
        payload?.ok
          ? { ok: true, message: 'El trámite terminó.' }
          : {
              ok: false,
              message: payload?.failure?.label
                ? `Se detuvo en «${payload.failure.label}».`
                : 'Volvió a fallar después de la verificación.',
            },
      );
    } catch {
      setError('No pude retomar el trámite.');
      setResuming(false);
    }
  }

  const mins = Math.max(0, Math.floor(msLeft / 60_000));
  const secs = Math.max(0, Math.floor((msLeft % 60_000) / 1000));

  return (
    <div className="rounded-card border border-border bg-surface">
      <div className="flex flex-wrap items-start gap-3 border-b border-border px-5 py-4">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-card bg-amber-soft text-amber">
          <ShieldQuestion className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">
            El portal quiere comprobar que no eres un robot
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            {expired
              ? 'El navegador ya se cerró, así que esta verificación se quedó sin resolver.'
              : 'Resuélvelo aquí abajo y Cortex sigue con el trámite desde donde se quedó. El navegador se queda abierto un rato; nada de lo que hagas aquí se guarda.'}
          </p>
        </div>
        <span
          className={clsx(
            'shrink-0 rounded-pill px-2.5 py-1 text-micro font-semibold tabular-nums',
            expired ? 'bg-rose-soft text-rose' : 'bg-surface-2 text-ink-muted',
          )}
        >
          {expired ? 'se cerró' : `quedan ${mins}:${String(secs).padStart(2, '0')}`}
        </span>
      </div>

      {view && (
        <div className="border-b border-border px-5 py-2">
          <div className="truncate font-mono text-micro text-ink-faint" title={view.url}>
            {view.url}
          </div>
        </div>
      )}

      <div className="p-5">
        {error ? (
          <p className="rounded-card bg-rose-soft px-4 py-3 text-xs leading-relaxed text-rose">
            {error}
          </p>
        ) : expired ? (
          <p className="rounded-card bg-surface-2 px-4 py-3 text-xs leading-relaxed text-ink-muted">
            La sesión se cerró sola. Vuelve a ejecutar el trámite para intentarlo otra vez.
          </p>
        ) : view ? (
          <div className="relative overflow-hidden rounded-card border border-border">
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: the target is a captcha widget in a cross-origin frame; there is nothing to give keyboard focus to. The text field below is the keyboard path. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:image/png;base64,${view.png}`}
              alt="La pantalla del navegador que está haciendo el trámite"
              onClick={handleClick}
              className={clsx(
                'block w-full',
                busy || resuming ? 'cursor-wait opacity-70' : 'cursor-pointer',
              )}
            />
            {(busy || resuming) && (
              <span className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-full bg-ink/70">
                <Loader2 className="h-4 w-4 animate-spin text-white" />
              </span>
            )}
          </div>
        ) : (
          <div className="grid h-40 place-items-center text-xs text-ink-faint">
            Abriendo la pantalla del navegador…
          </div>
        )}

        {!expired && !error && (
          <>
            {/* The keyboard path. Some challenges want letters from an image, and
                a click alone cannot give them. */}
            <form
              className="mt-4 flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const field = new FormData(e.currentTarget).get('texto');
                if (typeof field === 'string' && field.length > 0) {
                  void send({ kind: 'type', text: field });
                  e.currentTarget.reset();
                }
              }}
            >
              <input
                name="texto"
                maxLength={200}
                placeholder="Si te pide escribir algo, escríbelo aquí"
                className="min-w-0 flex-1 rounded-pill border border-border bg-surface-2 px-3.5 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
              />
              <button
                type="submit"
                disabled={busy || resuming}
                className="rounded-pill border border-border px-3.5 py-2 text-xs font-semibold text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
              >
                Escribir
              </button>
              <button
                type="button"
                disabled={busy || resuming}
                onClick={() => void send({ kind: 'key', text: 'Enter' })}
                className="rounded-pill border border-border px-3.5 py-2 text-xs font-semibold text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
              >
                Enter
              </button>
            </form>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void resume()}
                disabled={resuming || busy}
                className="inline-flex items-center gap-2 rounded-pill bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card transition-colors duration-150 hover:bg-primary-strong disabled:cursor-not-allowed disabled:bg-ink-faint"
              >
                {resuming && <Loader2 className="h-4 w-4 animate-spin" />}
                {resuming ? 'Siguiendo con el trámite…' : 'Ya lo resolví, sigue'}
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={busy || resuming}
                className="text-xs font-semibold text-ink-muted transition-colors duration-150 hover:text-ink disabled:text-ink-faint"
              >
                Actualizar la imagen
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
