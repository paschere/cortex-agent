'use client';

import { CaptureContract } from '@/components/privacy/CaptureContract';
import { Button } from '@/components/ui/button';
import {
  WATCH_MAX_LOOKS,
  WATCH_RECENT_NOTICES,
  WATCH_SAMPLE_MS,
  type WatchState,
  frameChange,
  isRepeatNotice,
  newWatchState,
  recordLook,
  spendSummary,
  stepWatch,
} from '@/lib/screen-watch';
import {
  NotATabError,
  type ScreenGlance,
  type TabViewHandle,
  canRecordTab,
  startTabView,
} from '@/lib/tab-recorder';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { AlertTriangle, BellRing, Eye, ScanEye, X } from 'lucide-react';
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
 * light would claim continuous watching, and a person who believes it is always
 * watching when it is not will close the session and never open it again.
 *
 * ===========================================================================
 * Y LUEGO ESTÁ LA VIGILANCIA, QUE ES OTRA PROMESA
 * ===========================================================================
 * «Mira solo y avísame»: Cortex mira la pestaña sin que nadie pregunte y dice
 * «ese mensaje significa que el RUT está vencido» antes de que la persona tenga
 * que ir a preguntarlo. Vive en este mismo archivo porque es el mismo permiso y
 * la misma pestaña, y está separada de todo lo demás por tres cosas que no son
 * negociables:
 *
 *   ES UNA DECISIÓN APARTE, Y APAGADA. Compartir la pestaña NO la enciende.
 *   Está detrás de su propio botón, con su propio contrato (`kind="alert"` en
 *   CaptureContract) y su propia frase, porque «puedes preguntarme por lo que
 *   ves» y «voy a estar mirando» son promesas distintas y la segunda es mucho
 *   más grande. Un interruptor que se enciende junto con otro es un interruptor
 *   que nadie eligió.
 *
 *   SE VE MIENTRAS ESTÁ ENCENDIDA, CON EL CONTADOR. La franja cambia de texto,
 *   dice cuántas veces ha mirado de cuántas puede y cuánto lleva costando, y
 *   lleva el botón de apagar encima. Un tope sin contador visible es una
 *   sorpresa aplazada, y la factura no es sitio para enterarse de nada.
 *
 *   SE APAGA SOLA Y LO DICE. Al llegar al tope de la sesión se apaga y deja la
 *   razón escrita en la franja. No se renueva, no se pregunta si quiere más: se
 *   apaga, y volver a encenderla es otro clic de la persona.
 *
 * LO QUE NO SE GASTA ES LO QUE HACE QUE ESTO EXISTA. La decisión de mirar se
 * toma en el navegador comparando dos miniaturas de 48×27 — ver
 * lib/screen-watch.ts, donde está la aritmética, el umbral y el tope, probados
 * en Node. El modelo sólo se entera de los cuadros donde la pantalla cambió de
 * verdad y luego se quedó quieta, así que una pestaña abierta en la que nadie
 * hace nada cuesta exactamente cero.
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

  // --- Vigilancia: mirar sin que nadie pregunte -----------------------------
  /** Encendida sólo si la persona la encendió a propósito. Nunca por defecto. */
  watching: boolean;
  startWatching(): void;
  stopWatching(): void;
  /** El contador, ya redactado: cuántas van, de cuántas, y cuánto lleva. */
  watchSummary: string;
  /** Por qué se apagó sola, si se apagó sola. Se muestra en la franja. */
  watchOff: string | null;
}

/** Lo que la vigilancia necesita del resto de la aplicación, y nada más. */
export interface ScreenViewOptions {
  /**
   * Hay algo que decir. Lo llama con la frase ya limpia y ya comprobada como no
   * repetida; que sea un mensaje del chat, un aviso aparte o nada es decisión de
   * quien monta el hook.
   *
   * Cuando NO hay nada que decir —que es casi siempre— esto no se llama. Es la
   * mitad del contrato que importa: el silencio no produce ningún mensaje en
   * ninguna parte, y no hay ninguna rama de este archivo capaz de producir uno.
   */
  onNotice?(text: string): void;
  /**
   * Si hay un turno respondiéndose ahora mismo. Se consulta en cada tick, así
   * que es una función y no un booleano: un valor capturado en el cierre del
   * efecto llevaría dos segundos de retraso justo cuando importa.
   */
  isBusy?(): boolean;
}

export function useScreenView(options: ScreenViewOptions = {}): ScreenViewSession {
  const handle = useRef<TabViewHandle | null>(null);
  const [live, setLive] = useState(false);
  const [glances, setGlances] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [justLooked, setJustLooked] = useState(false);
  const flashTimer = useRef<number | null>(null);
  /**
   * Las devoluciones de llamada, siempre las últimas. El efecto del muestreo se
   * monta una vez por sesión de vigilancia y no puede volver a montarse en cada
   * render — reiniciaría el intervalo y, con él, el ritmo de las miradas.
   */
  const opts = useRef(options);
  opts.current = options;
  /**
   * Read after mount, never during render. `canRecordTab` asks the browser a
   * question the server cannot answer, so calling it while rendering would
   * make the server draw no control and the client draw one — a hydration
   * mismatch, on the control whose whole job is to be noticed.
   */
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(canRecordTab()), []);

  // --- Vigilancia -----------------------------------------------------------
  const [watching, setWatching] = useState(false);
  const [watchOff, setWatchOff] = useState<string | null>(null);
  /**
   * El estado de la vigilancia vive en un ref Y en un estado, y no es
   * duplicación por descuido. El intervalo lee y escribe el ref, que siempre
   * está al día; el estado sólo existe para redibujar el contador de la franja.
   * Contarlo únicamente con `useState` obligaría al efecto a volver a montarse
   * en cada mirada, y con él el intervalo.
   */
  const watch = useRef<WatchState>(newWatchState());
  const [watchShown, setWatchShown] = useState<WatchState>(newWatchState());
  /** La miniatura del tick anterior. Contra esta se mide si algo se movió. */
  const previousThumb = useRef<Uint8ClampedArray | null>(null);
  /** Los últimos avisos, para no decir dos veces lo mismo. */
  const recent = useRef<string[]>([]);
  /** Una petición a la vez. Sin esto, una red lenta encola miradas ya pagadas. */
  const inFlight = useRef(false);
  /**
   * Qué encendido es este. Sube al encender y al apagar, y es lo que hace que
   * «apagable de un clic» sea cierto de verdad.
   *
   * Entre que sale una mirada y vuelve pasan uno o dos segundos, y en ese rato
   * la persona puede haber pulsado «Dejar de mirar». Sin este contador, esa
   * respuesta llegaría igual y aparecería un aviso DESPUÉS de apagarlo — que es
   * exactamente la clase de cosa que hace que alguien no vuelva a encender nada.
   * Se compara el número de antes con el de después y, si cambió, la respuesta
   * se tira. Ya se pagó; hacerla hablar no la abarata.
   */
  const run = useRef(0);

  const stopWatching = useCallback((reason: string | null = null) => {
    run.current++;
    setWatching(false);
    setWatchOff(reason);
    previousThumb.current = null;
    inFlight.current = false;
  }, []);

  const finish = useCallback(() => {
    handle.current?.stop();
    handle.current = null;
    setLive(false);
    setGlances(0);
    // Dejar de compartir apaga la vigilancia sin dejar explicación: la persona
    // acaba de hacerlo ella misma, y un cartel diciéndole por qué se apagó lo
    // que ella apagó es ruido.
    stopWatching(null);
    watch.current = newWatchState();
    setWatchShown(watch.current);
    recent.current = [];
  }, [stopWatching]);

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

  /** La lámpara. Se enciende un momento cada vez que se mira, por lo que sea. */
  const flash = useCallback(() => {
    setJustLooked(true);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setJustLooked(false), 1400);
  }, []);

  const grab = useCallback((): ScreenGlance | null => {
    const glance = handle.current?.grab() ?? null;
    if (glance) {
      setGlances((n) => n + 1);
      flash();
    }
    return glance;
  }, [flash]);

  /**
   * Apagarla a mano no deja explicación en la franja, y apagarse sola sí. Son
   * dos gestos distintos: quien acaba de pulsar «Dejar de mirar» no necesita que
   * le cuenten por qué dejó de mirar.
   */
  const stopWatchingByHand = useCallback(() => stopWatching(null), [stopWatching]);

  const startWatching = useCallback(() => {
    // Un contador nuevo por encendido: el tope es POR SESIÓN de vigilancia, y
    // volver a encenderla es un acto explícito de la persona con su propio
    // botón. Ver `WATCH_MAX_LOOKS`.
    watch.current = { ...newWatchState(), dirty: true };
    setWatchShown(watch.current);
    previousThumb.current = null;
    recent.current = [];
    run.current++;
    setWatchOff(null);
    setWatching(true);
  }, []);

  /**
   * EL BUCLE. Cada dos segundos, y casi siempre no hace nada.
   *
   * Lo caro está detrás de tres puertas y las tres se cierran sin gastar un
   * peso: `thumbnail()` dibuja 1 296 píxeles dentro de esta pestaña,
   * `frameChange` los compara con los del tick anterior y `stepWatch` decide.
   * Sólo cuando esa cadena dice que sí se llama a `grab()`, que es lo único que
   * cuesta dinero, y sólo entonces sale una petición.
   *
   * Se monta una vez por encendido: sus dependencias son estables a propósito
   * (`opts` es un ref, `watch` es un ref), porque un efecto que se vuelve a
   * montar reinicia el intervalo y con él el ritmo de las miradas.
   */
  useEffect(() => {
    if (!watching || !live) return;

    const timer = window.setInterval(() => {
      const view = handle.current;
      if (!view) return;

      const thumb = view.thumbnail();
      if (!thumb) return;
      const before = previousThumb.current;
      previousThumb.current = thumb;
      // Sin cuadro anterior no hay comparación posible: el primer tick no dice
      // que se movió nada, y aun así se mira, porque `startWatching` arranca en
      // `dirty` — quien acaba de encender esto lo encendió por algo que ya está
      // en pantalla.
      const change = before ? frameChange(before, thumb) : 0;

      const step = stepWatch(watch.current, {
        change,
        now: Date.now(),
        busy: opts.current.isBusy?.() ?? false,
      });
      watch.current = step.state;

      if (step.exhausted) {
        stopWatching(
          `Llegué a las ${WATCH_MAX_LOOKS} miradas de esta sesión y me apagué solo, para que esto no siga costando sin que lo hayas pedido. Sigues compartiendo la pestaña: puedes preguntarme lo que quieras, o volver a encenderme.`,
        );
        return;
      }

      if (!step.look || inFlight.current) return;

      const glance = view.grab();
      if (!glance) return;

      // Se anota ANTES de que la respuesta vuelva. El fotograma ya se tomó y ya
      // se va a enviar: contarlo sólo si la petición sale bien haría que una red
      // mala pareciera gratis y dejaría el tope sin defender el caso que más
      // falta hace, que es el de los reintentos.
      watch.current = recordLook(watch.current, Date.now(), glance.width, glance.height);
      setWatchShown(watch.current);
      flash();
      inFlight.current = true;

      const thisRun = run.current;

      void (async () => {
        try {
          const res = await fetch('/api/chat/watch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ screen: glance, recent: recent.current }),
          });
          // Se apagó mientras esto iba en camino. Callar es lo único correcto:
          // la persona ya decidió.
          if (run.current !== thisRun) return;
          if (!res.ok) return;
          const data = (await res.json()) as {
            aviso?: string | null;
            motivo?: string;
            mensaje?: string;
          };
          if (data.motivo === 'plan') {
            stopWatching(data.mensaje ?? 'Apagué la vigilancia.');
            return;
          }
          // Aquí está la mitad que importa del contrato: sin aviso no se llama a
          // nadie. «No hay nada que valga la pena» no produce ningún mensaje, ni
          // un mensaje vacío, ni una fila que diga que no había nada.
          const aviso = data.aviso;
          if (!aviso) return;
          if (isRepeatNotice(aviso, recent.current)) return;
          recent.current = [...recent.current, aviso].slice(-WATCH_RECENT_NOTICES);
          opts.current.onNotice?.(aviso);
        } catch {
          // Una mirada que no llegó es una mirada que no dice nada, que es lo que
          // pasa casi siempre. No hay nada que contarle a nadie.
        } finally {
          inFlight.current = false;
        }
      })();
    }, WATCH_SAMPLE_MS);

    return () => window.clearInterval(timer);
  }, [watching, live, flash, stopWatching]);

  return {
    supported,
    live,
    glances,
    error,
    start,
    stop: finish,
    grab,
    justLooked,
    watching,
    startWatching,
    stopWatching: stopWatchingByHand,
    watchSummary: spendSummary(watchShown),
    watchOff,
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
              <Dialog.Title className="text-base font-semibold text-ink">
                Pregúntame por lo que estás viendo
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs leading-snug text-ink-muted">
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
                <p className="text-sm leading-relaxed text-rose">{session.error}</p>
              </div>
            )}

            <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
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
    'Miro un cuadro de la pestaña cada vez que envías una pregunta, y sólo entonces. Entre pregunta y pregunta no estoy mirando nada. Si además quieres que mire solo y te avise cuando vea un error o algo vencido, eso se enciende aparte, con su propio botón en la franja, y lo decides tú.',
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
          <p className="text-xs leading-snug text-ink-muted">{point}</p>
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

  const watching = session.watching;

  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> is the result of a calculation and is inline-level; this is a standing condition on a band that contains its own control, which is what role="status" describes.
    <div
      role="status"
      className={clsx(
        'mb-2 rounded-card border px-3 py-2',
        // La vigilancia se ve DISTINTA, no sólo dice algo distinto. Es la
        // promesa más grande de las dos y tiene que reconocerse sin leer: ámbar
        // es el color con el que este producto marca lo que hay que tener
        // presente, y el índigo se queda para el estado tranquilo.
        watching ? 'border-amber/25 bg-amber-soft' : 'border-primary/20 bg-primary-soft',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="relative grid h-4 w-4 shrink-0 place-items-center" aria-hidden="true">
          {/* La lámpara: apagada mientras no se lee nada, encendida un momento
              en cada mirada. No es adorno, es el mecanismo dibujado — y por eso
              tampoco se queda fija cuando la vigilancia está encendida: fija
              afirmaría que se está mirando todo el rato, que es justamente lo
              que no ocurre y lo que haría carísima esta función. */}
          <span
            className={clsx(
              'h-2 w-2 rounded-full transition-colors duration-200 motion-reduce:transition-none',
              watching
                ? session.justLooked
                  ? 'bg-amber'
                  : 'bg-amber/35'
                : session.justLooked
                  ? 'bg-primary'
                  : 'bg-primary/35',
            )}
          />
          {session.justLooked && (
            <span
              className={clsx(
                'absolute inset-0 rounded-full motion-safe:animate-ping motion-reduce:hidden',
                watching ? 'bg-amber/25' : 'bg-primary/25',
              )}
            />
          )}
        </span>

        <p
          className={clsx(
            'min-w-0 flex-1 text-xs leading-snug',
            watching ? 'text-amber' : 'text-primary-ink',
          )}
        >
          {watching ? (
            <>
              <strong className="font-semibold">
                Estoy mirando tu pestaña y te aviso si veo algo.
              </strong>{' '}
              <span className="text-ink-muted">{session.watchSummary}</span>
            </>
          ) : (
            <>
              <strong className="font-semibold">Estás compartiendo una pestaña.</strong>{' '}
              <span className="text-ink-muted">
                {session.glances === 0
                  ? 'Todavía no la he mirado: lo hago cuando envíes una pregunta.'
                  : `La miré ${session.glances === 1 ? 'una vez' : `${session.glances} veces`}, una por pregunta. Ninguna imagen se guardó.`}
              </span>
            </>
          )}
        </p>

        {/* La salida, siempre en la franja y siempre a un clic. Cuando la
            vigilancia está encendida hay DOS salidas y son cosas distintas:
            dejar de avisar sigue compartiendo la pestaña para preguntar, y
            dejar de compartir termina todo. Decirlo con dos botones evita la
            pregunta de qué apaga qué. */}
        {watching ? (
          <button
            type="button"
            onClick={session.stopWatching}
            className="shrink-0 rounded-pill border border-amber/30 bg-surface px-3 py-1 text-xs font-semibold text-amber transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/40 motion-reduce:transition-none"
          >
            Dejar de mirar
          </button>
        ) : (
          <WatchOffer session={session} />
        )}

        <button
          type="button"
          onClick={session.stop}
          className={clsx(
            'shrink-0 rounded-pill border bg-surface px-3 py-1 text-xs font-semibold transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none motion-reduce:transition-none',
            watching
              ? 'border-amber/30 text-amber focus-visible:ring-2 focus-visible:ring-amber/40'
              : 'border-primary/25 text-primary-ink focus-visible:ring-2 focus-visible:ring-primary/40',
          )}
        >
          Dejar de compartir
        </button>
      </div>

      {/* Por qué se apagó sola. Queda escrito en la franja hasta que la persona
          vuelva a encenderla o deje de compartir, porque un tope que se agota en
          silencio es idéntico a una función que dejó de servir. */}
      {session.watchOff && (
        <p className="mt-1.5 border-t border-border pt-1.5 text-xs leading-snug text-ink-muted">
          {session.watchOff}
        </p>
      )}
    </div>
  );
}

/**
 * ENCENDER LA VIGILANCIA: una decisión aparte, con su propio contrato.
 *
 * El mismo argumento que justifica el diálogo antes de `getDisplayMedia`, un
 * escalón más arriba. Compartir la pestaña ya está concedido cuando aparece este
 * botón; lo que se está pidiendo aquí es algo que la persona no concedió al
 * compartirla, y que no se sigue de haberla compartido: que Cortex mire cuando
 * a ella no se le ocurra preguntar.
 *
 * Así que no es un interruptor suelto en la franja. Es un botón que abre las
 * mismas tres celdas del contrato de captura —con el texto de ESTA promesa, ver
 * `kind="alert"`— más las tres frases que responden lo que cualquiera se
 * pregunta al leerlo: cada cuánto mira, cuándo habla y cuánto puede costar. Y
 * las tres se pueden verificar en pantalla mientras corre, que es lo que
 * distingue un contrato de un eslogan.
 */
function WatchOffer({ session }: { session: ScreenViewSession }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-primary/25 bg-surface px-3 py-1 text-xs font-semibold text-primary-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
        >
          <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
          Avísame si ves algo
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in motion-reduce:animate-none" />
        <Dialog.Content className="scroll-slim fixed left-1/2 top-1/2 z-50 max-h-[86vh] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card bg-canvas p-4 shadow-pop focus:outline-none sm:p-5">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold text-ink">
                ¿Miro solo y te aviso?
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs leading-snug text-ink-muted">
                Esto es distinto de lo que ya autorizaste: hasta ahora miro cuando preguntas, y esto
                es mirar sin que preguntes.
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
            <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
              Te aviso cuando aparezca{' '}
              <strong className="font-semibold text-ink">
                un error, algo vencido o un campo mal puesto
              </strong>{' '}
              — «ese mensaje significa que el RUT está vencido» — sin que tengas que venir a
              preguntarme. El resto del tiempo no digo nada, que es lo que va a pasar la mayoría de
              las veces.
            </p>

            <CaptureContract kind="alert" />

            <WatchTerms />

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  session.startWatching();
                  setOpen(false);
                }}
              >
                <Eye className="h-4 w-4" aria-hidden="true" />
                Empieza a mirar
              </Button>
              <Dialog.Close asChild>
                <Button variant="ghost">Mejor no</Button>
              </Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Tres frases, y cada una responde algo que alguien descubriría de otro modo a
 * la mala: cada cuánto miro, cuándo hablo, y cuánto puede costarme esto.
 *
 * La tercera lleva el número. Es incómodo poner un tope y un precio en un
 * diálogo de permiso y es exactamente por eso que va: la alternativa a decirlo
 * aquí es que se entere cuando la función se apague sola, o peor, en la factura.
 */
function WatchTerms() {
  const points = [
    `Comparo la imagen aquí, en tu navegador, cada ${WATCH_SAMPLE_MS / 1000} segundos, y eso no cuesta nada. Sólo miro de verdad cuando la pantalla cambió y se quedó quieta: una página cargando es una mirada, no diez, y una pestaña en la que no pasa nada son cero.`,
    'Hablo sólo por un error, algo vencido o por vencer, una advertencia o un campo mal diligenciado. Si no hay nada de eso, no aparece ningún mensaje. Y no repito un aviso que ya te di.',
    `Tengo un tope de ${WATCH_MAX_LOOKS} miradas por sesión — del orden de diez centavos de dólar en total — y cuando se acaba me apago solo y te lo digo. En la franja de arriba vas viendo cuántas llevo y cuánto va costando.`,
  ];

  return (
    <ul className="mt-4 space-y-2">
      {points.map((point) => (
        <li key={point} className="flex gap-2.5">
          <span
            className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber"
            aria-hidden="true"
          />
          <p className="text-xs leading-snug text-ink-muted">{point}</p>
        </li>
      ))}
    </ul>
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
    <p className="mt-1 flex items-center justify-end gap-1.5 text-micro text-ink-faint">
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
