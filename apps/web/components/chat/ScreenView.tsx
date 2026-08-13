'use client';

import { CaptureContract } from '@/components/privacy/CaptureContract';
import { Button } from '@/components/ui/button';
import {
  NotATabError,
  type ScreenGlance,
  type TabViewHandle,
  canRecordTab,
  startTabView,
} from '@/lib/tab-recorder';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { AlertTriangle, ScanEye, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * «Mira lo que estoy viendo.»
 *
 * ===========================================================================
 * WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT
 * ===========================================================================
 * Somebody is on a portal, in a spreadsheet or in front of an error, and wants
 * to ask about WHAT IS IN FRONT OF THEM without describing it or cropping a
 * screenshot. They share a tab once; from then on every question they type can
 * carry one picture of it.
 *
 * It is not the trámite recorder and must never be confused with it. That one
 * records a sequence in order to repeat it later and produces a procedure; this
 * one produces a sentence and keeps nothing. They share a permission and a
 * promise (see lib/tab-recorder.ts and components/privacy/CaptureContract.tsx)
 * and nothing else — different control, different words, different result.
 *
 * ===========================================================================
 * WHY THE DIALOG EXISTS INSTEAD OF THE BUTTON CALLING getDisplayMedia
 * ===========================================================================
 * Because the browser's share prompt is modal, and once it is up nothing behind
 * it can be read. A person deciding whether to hand a piece of software their
 * screen deserves the three claims BEFORE that prompt appears, not underneath
 * it. One extra click buys the only moment in the flow where the contract can
 * actually be read, and it is the moment that decides whether anybody uses this
 * a second time.
 *
 * ===========================================================================
 * THE STRIP IS NOT A NICETY
 * ===========================================================================
 * Somebody forgetting they are sharing their screen is the worst outcome this
 * feature can produce — worse than it not working — so the live state is a
 * band above the composer that cannot be collapsed, cannot be hidden in a menu,
 * and carries its own stop button. It is on screen for as long as the share is,
 * and it says the two things that matter: that the tab is available, and that
 * nothing has been looked at since the last question.
 *
 * The lamp is dark while nothing is happening and lights for a moment on each
 * glance. That is not decoration: it is the mechanism, drawn. A steady "REC"
 * light would claim continuous watching, which is exactly what this does not
 * do, and a person who believes it is always watching will close the session
 * and never open it again.
 */

export interface ScreenViewSession {
  /** Whether this browser can share a tab at all. Safari cannot, today. */
  supported: boolean;
  live: boolean;
  glances: number;
  error: string | null;
  /** True once the tab is being shared. False means the panel must stay open. */
  start(): Promise<boolean>;
  stop(): void;
  /**
   * One frame of the shared tab, taken NOW. Null when nothing is shared.
   * Synchronous so the composer can call it inside the body it is posting.
   */
  grab(): ScreenGlance | null;
  /** Set for a moment after each glance, so the strip can light its lamp. */
  justLooked: boolean;
}

export function useScreenView(): ScreenViewSession {
  const handle = useRef<TabViewHandle | null>(null);
  const [live, setLive] = useState(false);
  const [glances, setGlances] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [justLooked, setJustLooked] = useState(false);
  const flashTimer = useRef<number | null>(null);
  /**
   * Read after mount, never during render. `canRecordTab` asks the browser a
   * question the server cannot answer, so calling it while rendering would
   * make the server draw no control and the client draw one — a hydration
   * mismatch, on the control whose whole job is to be noticed.
   */
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(canRecordTab()), []);

  const finish = useCallback(() => {
    handle.current?.stop();
    handle.current = null;
    setLive(false);
    setGlances(0);
  }, []);

  // Leaving the chat ends the share. Nothing else in the app could show the
  // strip, and a session whose indicator is not on screen is the exact failure
  // the strip exists to prevent — so it is ended rather than carried.
  useEffect(
    () => () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      handle.current?.stop();
      handle.current = null;
    },
    [],
  );

  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      handle.current = await startTabView({ onEnded: finish });
      setGlances(0);
      setLive(true);
      return true;
    } catch (err) {
      if (err instanceof NotATabError) setError(err.message);
      // The person closed the picker. They already know; saying so is nagging.
      else if ((err as Error).name === 'NotAllowedError') setError(null);
      else setError((err as Error).message);
      setLive(false);
      // The caller keeps its panel open on false. Sharing a whole screen by
      // mistake is the one failure worth explaining, and a dialog that closed
      // itself would take the explanation with it.
      return false;
    }
  }, [finish]);

  const grab = useCallback((): ScreenGlance | null => {
    const glance = handle.current?.grab() ?? null;
    if (glance) {
      setGlances((n) => n + 1);
      setJustLooked(true);
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setJustLooked(false), 1400);
    }
    return glance;
  }, []);

  return {
    supported,
    live,
    glances,
    error,
    start,
    stop: finish,
    grab,
    justLooked,
  };
}

/**
 * The composer control, and the argument for a fifth one.
 *
 * The rule in InputBar.tsx is that a control gets in only if it lets somebody
 * do something they otherwise could NOT do, never because it saves a step. This
 * qualifies on exactly that test and not on convenience: without it there is no
 * way to ask about what is on screen at all. The alternative is not "one more
 * click" — it is take a screenshot with an OS tool, find the file, drag it into
 * the composer, and do that again for the follow-up question. Which is why
 * describing the screen in words is what people actually do instead, and why
 * the answers they get are about the description rather than the screen.
 *
 * It is a different icon and a different word from the recorder next to it —
 * MIRAR versus GRABAR — because two screen-share buttons that look alike would
 * be worse than either of them being missing.
 */
export function ScreenViewButton({
  session,
  disabled,
}: {
  session: ScreenViewSession;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!session.supported) return null;

  // Live: the control is a switch, and pressing it again stops. The strip has
  // its own stop button; two ways out of a state like this one is right.
  if (session.live) {
    return (
      <button
        type="button"
        onClick={session.stop}
        aria-pressed={true}
        aria-label="Dejar de compartir la pestaña"
        title="Dejar de compartir la pestaña"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-soft text-primary ring-1 ring-inset ring-primary/20 transition-colors duration-150 hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <ScanEye className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={false}
          aria-label="Compartir una pestaña para que Cortex la mire"
          title="Compartir una pestaña: pregúntame sobre lo que estás viendo"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
        >
          <ScanEye className="h-4 w-4" aria-hidden="true" />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in motion-reduce:animate-none" />
        <Dialog.Content className="scroll-slim fixed left-1/2 top-1/2 z-50 max-h-[86vh] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card bg-canvas p-4 shadow-pop focus:outline-none sm:p-5">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] font-semibold text-ink">
                Pregúntame por lo que estás viendo
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12.5px] leading-snug text-ink-muted">
                Comparte la pestaña una vez y pregunta lo que quieras sobre ella, sin describirla ni
                recortar una captura.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Cerrar"
                className="-mr-1 -mt-1 shrink-0 rounded-pill p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          <div className="rounded-card border border-border bg-surface p-5 shadow-card">
            {session.error && (
              <div className="mb-4 flex items-start gap-2 rounded-sm border border-rose/20 bg-rose-soft px-3.5 py-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose" aria-hidden="true" />
                <p className="text-[13px] leading-relaxed text-rose">{session.error}</p>
              </div>
            )}

            <p className="max-w-2xl text-[13.5px] leading-relaxed text-ink-muted">
              «¿Qué significa este error?», «¿este formulario está bien lleno?», «¿qué me está
              pidiendo aquí?». Y lo que ningún asistente con cámara puede hacer: cruzarlo con lo que
              ya sabemos de la empresa —{' '}
              <strong className="font-semibold text-ink">
                «este contrato, ¿dice lo mismo que el que firmamos en marzo?»
              </strong>{' '}
              — con su fuente, como cualquier otra respuesta.
            </p>

            <CaptureContract kind="watch" />

            <HowItWorks />

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  void session.start().then((ok) => {
                    if (ok) setOpen(false);
                  });
                }}
              >
                <ScanEye className="h-4 w-4" aria-hidden="true" />
                Compartir una pestaña
              </Button>
              <Dialog.Close asChild>
                <Button variant="ghost">Ahora no</Button>
              </Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Three sentences, and each one answers a question somebody would otherwise
 * discover the hard way: when do I get looked at, what happens to the picture,
 * and how do I stop. No list of tips — the feature has no technique to learn.
 */
function HowItWorks() {
  const points = [
    'Miro un cuadro de la pestaña cada vez que envías una pregunta, y sólo entonces. Entre pregunta y pregunta no estoy mirando nada: mirar todo el rato costaría plata en cada cuadro y sería estar leyendo tu pantalla sin que me lo pidas.',
    'Uso ese cuadro para responderte y se borra. No queda guardado en ninguna parte: en la conversación queda anotado que miré y a qué hora, para que mañana se entienda de qué estabas hablando.',
    'Cortas cuando quieras, desde la franja que queda arriba del cuadro de texto o desde el aviso del propio navegador.',
  ];

  return (
    <ul className="mt-4 space-y-2">
      {points.map((point) => (
        <li key={point} className="flex gap-2.5">
          <span
            className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
          <p className="text-[12.5px] leading-snug text-ink-muted">{point}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The live band. Above the composer, undismissable, with the way out on it.
 *
 * `role="status"` rather than `role="alert"`: it is a standing condition a
 * screen reader should announce when it changes, not an interruption. The count
 * is in the same string so somebody who cannot see the lamp still hears that a
 * glance happened.
 */
export function ScreenViewStrip({ session }: { session: ScreenViewSession }) {
  if (!session.live) return null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> is the result of a calculation and is inline-level; this is a standing condition on a band that contains its own control, which is what role="status" describes.
    <div
      role="status"
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-card border border-primary/20 bg-primary-soft px-3 py-2"
    >
      <span className="relative grid h-4 w-4 shrink-0 place-items-center" aria-hidden="true">
        {/* The lamp: dark while nothing is being read, lit for a moment on each
            glance. Reduced motion gets the same two states without the ring. */}
        <span
          className={clsx(
            'h-2 w-2 rounded-full transition-colors duration-200 motion-reduce:transition-none',
            session.justLooked ? 'bg-primary' : 'bg-primary/35',
          )}
        />
        {session.justLooked && (
          <span className="absolute inset-0 rounded-full bg-primary/25 motion-safe:animate-ping motion-reduce:hidden" />
        )}
      </span>

      <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-primary-ink">
        <strong className="font-semibold">Estás compartiendo una pestaña.</strong>{' '}
        <span className="text-ink-muted">
          {session.glances === 0
            ? 'Todavía no la he mirado: lo hago cuando envíes una pregunta.'
            : `La miré ${session.glances === 1 ? 'una vez' : `${session.glances} veces`}, una por pregunta. Ninguna imagen se guardó.`}
        </span>
      </p>

      <button
        type="button"
        onClick={session.stop}
        className="shrink-0 rounded-pill border border-primary/25 bg-surface px-3 py-1 text-[12px] font-semibold text-primary-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        Dejar de compartir
      </button>
    </div>
  );
}

/**
 * The line under a question that was asked with a picture attached.
 *
 * This is the whole of what is kept, and it is on screen rather than only in
 * the database — a record of when somebody's screen was read that they cannot
 * see is not a record, it is a log. It is rendered from `messages
 * .screen_glance_at` (migration 0092), so it survives a reload and is what
 * makes a two-week-old thread legible: "¿qué significa este error?" with no
 * indication that anything was being looked at is a transcript of half a
 * conversation.
 */
export function GlanceNote({ at }: { at: string }) {
  const when = new Date(at);
  const label = Number.isNaN(when.getTime())
    ? null
    : when.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

  return (
    <p className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-ink-faint">
      <ScanEye className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>
        Miré tu pestaña compartida
        {label ? (
          // The server renders this in the server's timezone and the browser
          // re-renders it in the person's, which is a hydration mismatch on a
          // string that is CORRECT both times. Suppressed rather than deferred
          // to an effect: the time is the point of the line, and a line that
          // appears a frame late reads as a glitch.
          <span className="tabular" suppressHydrationWarning>
            {' '}
            a las {label}
          </span>
        ) : null}
        . La imagen no se guardó.
      </span>
    </p>
  );
}
