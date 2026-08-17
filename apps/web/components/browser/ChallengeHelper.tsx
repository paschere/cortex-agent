'use client';

import { clsx } from 'clsx';
import { Loader2, ShieldQuestion } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/**
 * EL MOMENTO EN QUE UN TRÁMITE LLAMA A UNA PERSONA.
 *
 * Dos motivos, y sólo dos, porque son las dos únicas cosas que una grabación no
 * puede grabar:
 *
 *   bot-check     el portal preguntó si somos un robot. La respuesta es un
 *                 ACTO — hay que mirar la pantalla y hacer clic — así que este
 *                 componente pinta la pestaña y manda coordenadas.
 *   input-needed  el trámite llegó a un paso `pause` que él mismo declara: el
 *                 código que acaba de llegar al celular. La respuesta es un
 *                 TEXTO, y no hace falta ver nada; pedirle a alguien que mire
 *                 una foto de un formulario para teclear seis dígitos sería
 *                 ceremonia.
 *
 * A trámite replays with no model in the loop, so when a portal stops there is
 * nobody in the loop to answer. El servicio de navegador sostiene esa pestaña
 * unos minutos en vez de destruirla; esto es la ventana hacia ella. Alguien
 * contesta y el trámite sigue desde el paso donde se quedó, en la MISMA sesión
 * — que es el único sitio donde la respuesta vale algo.
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
  /**
   * La fila que recuerda esta pausa (migración 0111). Cuando está, retomar
   * pasa por ella y no por la sesión a pelo: cerrarla es un UPDATE condicional,
   * así que dos personas contestando lo mismo producen UNA reanudación, y lo
   * que el trámite baje después queda archivado en el cerebro.
   *
   * Opcional porque el servicio puede haber sostenido la pestaña sin que la
   * fila se alcanzara a escribir. Ahí se retoma por la ruta de sesión, que
   * funciona igual de bien para lo único que puede pasar en ese caso: que
   * alguien esté mirando esta pantalla ahora mismo.
   */
  checkpointId?: string | null;
  reason?: 'bot-check' | 'input-needed';
  /** La pregunta, en las palabras de quien enseñó el trámite. */
  ask?: string | null;
  /** El slot que llena la respuesta. Null en un captcha. */
  fills?: string | null;
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
  const [answer, setAnswer] = useState('');
  const [msLeft, setMsLeft] = useState(() => Date.parse(handoff.expiresAt) - Date.now());

  const expired = msLeft <= 0;
  const asksForText = handoff.reason === 'input-needed';

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
  // Sólo para el captcha. Una pregunta de texto no necesita ver la pestaña, y
  // una foto cada dos segundos y medio de un formulario que nadie va a tocar es
  // una petición por nada mientras la persona busca su celular.
  useEffect(() => {
    if (asksForText) return;
    void refresh();
  }, [refresh, asksForText]);

  useEffect(() => {
    if (asksForText || error || resuming || expired) return;
    const t = setInterval(() => void refresh(), IDLE_POLL_MS);
    return () => clearInterval(t);
  }, [refresh, error, resuming, expired, asksForText]);

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
    if (asksForText && answer.trim().length === 0) {
      setError('Escribe el dato que te está pidiendo antes de seguir.');
      return;
    }
    setResuming(true);
    setError(null);
    try {
      // Por la fila si la hay — cierra la pausa de forma atómica y archiva lo
      // que baje — y por la sesión a pelo si no. Ver el comentario de
      // `checkpointId`.
      const res = handoff.checkpointId
        ? await fetch(`/api/browser/checkpoints/${handoff.checkpointId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ answer: answer.trim() }),
          })
        : await fetch(`/api/browser/session/${handoff.sessionId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'continue', fromIndex: handoff.fromIndex }),
          });
      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        message?: string;
        failure?: { label?: string; error?: string };
      } | null;
      if (!res.ok) {
        setError(payload?.error ?? 'No pude retomar el trámite.');
        setResuming(false);
        return;
      }
      onFinished(
        payload?.ok
          ? { ok: true, message: payload.message ?? 'El trámite terminó.' }
          : {
              ok: false,
              message:
                payload?.message ??
                (payload?.failure?.label
                  ? `Se detuvo en «${payload.failure.label}».`
                  : 'Volvió a fallar después de la pausa.'),
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
            {asksForText
              ? (handoff.ask ?? 'El trámite necesita un dato tuyo')
              : 'El portal quiere comprobar que no eres un robot'}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            {expired
              ? 'El navegador ya se cerró, así que esta pausa se quedó sin resolver.'
              : asksForText
                ? 'Escríbelo aquí y Cortex sigue con el trámite desde donde se quedó, en la misma sesión. No se guarda en ninguna parte: sirve una sola vez.'
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
        ) : asksForText ? (
          <label className="block">
            <span className="text-xs font-semibold text-ink-muted">
              {handoff.fills ? `El dato: ${handoff.fills}` : 'Tu respuesta'}
            </span>
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              maxLength={300}
              autoFocus
              autoComplete="one-time-code"
              inputMode="numeric"
              disabled={resuming}
              placeholder="Por ejemplo, 483920"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void resume();
              }}
              className="mt-1.5 w-full rounded-pill border border-border bg-surface-2 px-3.5 py-2 text-sm tabular-nums text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
            />
          </label>
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

        {!expired && !error && !asksForText && (
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

        {!expired && asksForText && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => void resume()}
              disabled={resuming}
              className="inline-flex items-center gap-2 rounded-pill bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card transition-colors duration-150 hover:bg-primary-strong disabled:cursor-not-allowed disabled:bg-ink-faint"
            >
              {resuming && <Loader2 className="h-4 w-4 animate-spin" />}
              {resuming ? 'Siguiendo con el trámite…' : 'Listo, sigue'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
