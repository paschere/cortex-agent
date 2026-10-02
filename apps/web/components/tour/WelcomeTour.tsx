'use client';

import { Button } from '@/components/ui/button';
import { ViewCanvas } from '@/components/views/ViewCanvas';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import type { ViewBrand } from '@/lib/branding/shape';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  ArrowRight,
  BellRing,
  CalendarClock,
  Check,
  FlaskConical,
  LayoutDashboard,
  MessageCircle,
  Plug,
  Search,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SAMPLE_ASK,
  SAMPLE_COMPANY,
  SAMPLE_HOME,
  SAMPLE_PROCESS,
  samplePulseView,
} from './sample-data';

/**
 * «MIRA CÓMO SE VE CORTEX CON DATOS DE EJEMPLO».
 *
 * Una empresa recién creada no tiene nada que mostrar, y un Inicio vacío no
 * cuenta para qué sirve el producto. Este recorrido lo cuenta en un minuto y
 * sin conectar nada: el Inicio con cifras, el pulso de la empresa (con los
 * componentes de vista de verdad), un proceso que trabaja solo y la caja de
 * preguntas. Todo con una empresa inventada que vive en `sample-data.ts`, sólo
 * en el navegador: nada se escribe en ninguna tabla.
 *
 * Lo monta el Inicio sólo cuando el espacio está vacío (sin fuentes, sin
 * procesos, sin vistas). Se recuerda por persona en `localStorage`:
 *   - sin marca → la tarjeta grande;
 *   - `seen` (ya abrió el recorrido) → una línea para volver a verlo;
 *   - `hidden` (dijo «ahora no») → nada.
 * Si el navegador no deja guardar, la tarjeta sale cada vez: es una invitación,
 * no un muro.
 *
 * El diálogo es de Radix: atrapa el foco, Escape cierra y el foco vuelve al
 * botón que lo abrió. En el teléfono sube como hoja desde abajo.
 */

type Memory = 'seen' | 'hidden' | null;

const storageKey = (userId: string) => `cortex.welcomeTour.v1.${userId}`;

function readMemory(userId: string): Memory {
  try {
    const v = window.localStorage.getItem(storageKey(userId));
    return v === 'seen' || v === 'hidden' ? v : null;
  } catch {
    return null;
  }
}

function writeMemory(userId: string, value: Exclude<Memory, null>) {
  try {
    window.localStorage.setItem(storageKey(userId), value);
  } catch {
    // Sin almacenamiento (ventana privada, sitio bloqueado): no se recuerda.
  }
}

export const PULSE_PROMPT = 'Dime cómo va la empresa en una vista y actualízala cada día';

const STEPS = [
  { id: 'inicio', title: 'Tu Inicio, con lo que te espera', icon: LayoutDashboard },
  { id: 'pulso', title: 'El pulso de la empresa, en una vista', icon: Sparkles },
  { id: 'proceso', title: 'Un proceso que trabaja solo', icon: Workflow },
  { id: 'preguntar', title: 'Pregúntale lo que quieras', icon: MessageCircle },
  { id: 'empezar', title: 'Ahora, con tus datos', icon: Plug },
] as const;

export function WelcomeTour({
  userId,
  brand = null,
  defaultOpen = false,
  startAt = 0,
  ignoreMemory = false,
}: {
  userId: string;
  /** La marca de la empresa, si tiene: el pulso de ejemplo se pinta con ella. */
  brand?: ViewBrand | null;
  /** Para el escaparate de desarrollo: abrir el recorrido de una vez. */
  defaultOpen?: boolean;
  startAt?: number;
  /** Para el escaparate: mostrar la tarjeta aunque el navegador diga que ya se vio. */
  ignoreMemory?: boolean;
}) {
  // `undefined` hasta leer el navegador: así el servidor y el primer pintado
  // coinciden y la tarjeta no parpadea para quien ya la ocultó.
  const [memory, setMemory] = useState<Memory | undefined>(ignoreMemory ? null : undefined);
  const [open, setOpen] = useState(defaultOpen);
  // Al cerrar, la tarjeta grande se vuelve una línea y su botón desaparece:
  // el foco vuelve al «Ver el recorrido» de la línea, no al documento.
  const againRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useCallback(() => {
    requestAnimationFrame(() => againRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!ignoreMemory) setMemory(readMemory(userId));
  }, [userId, ignoreMemory]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next && memory !== 'hidden') {
        writeMemory(userId, 'seen');
        setMemory('seen');
      }
    },
    [userId, memory],
  );

  const hide = () => {
    writeMemory(userId, 'hidden');
    setMemory('hidden');
  };

  if (memory === undefined || memory === 'hidden') {
    return open ? (
      <TourDialog
        open={open}
        onOpenChange={onOpenChange}
        onClosed={returnFocus}
        brand={brand}
        startAt={startAt}
      />
    ) : null;
  }

  return (
    <>
      {memory === 'seen' ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-border bg-surface px-4 py-3 shadow-card">
          <FlaskConical className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <p className="min-w-0 flex-1 text-sm text-ink-muted">
            ¿Quieres ver otra vez cómo se ve Cortex con datos de ejemplo?
          </p>
          <button
            ref={againRef}
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex min-h-9 items-center gap-1 rounded-pill px-3 text-sm font-bold text-primary transition-colors hover:bg-primary-soft hover:text-primary-ink"
          >
            Ver el recorrido <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={hide}
            aria-label="Ocultar la invitación al recorrido"
            className="grid h-9 w-9 place-items-center rounded-pill text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : (
        <section
          aria-labelledby="welcome-tour-title"
          className="animate-rise relative mb-4 overflow-hidden rounded-card border border-primary/30 bg-surface p-5 shadow-card"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-2/3 bg-gradient-to-l from-primary-soft/70 to-transparent"
          />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
              <FlaskConical className="h-6 w-6" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2
                id="welcome-tour-title"
                className="text-lg font-extrabold tracking-tight text-ink"
              >
                Mira cómo se ve Cortex con datos de ejemplo
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">
                Un recorrido de un minuto con una empresa inventada: tu Inicio con cifras, el pulso
                de la empresa, un proceso que avisa solo y la caja de preguntas. Sin conectar nada.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button type="button" onClick={() => setOpen(true)}>
                Ver el recorrido
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <Button type="button" variant="ghost" onClick={hide}>
                Ahora no
              </Button>
            </div>
          </div>
        </section>
      )}
      {open && (
        <TourDialog
          open={open}
          onOpenChange={onOpenChange}
          onClosed={returnFocus}
          brand={brand}
          startAt={startAt}
        />
      )}
    </>
  );
}

function TourDialog({
  open,
  onOpenChange,
  onClosed,
  brand,
  startAt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Adónde va el foco al cerrar, si el botón que abrió ya no existe. */
  onClosed?: () => void;
  brand: ViewBrand | null;
  startAt: number;
}) {
  const [step, setStep] = useState(() => Math.min(Math.max(startAt, 0), STEPS.length - 1));
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const current = STEPS[step] ?? STEPS[0];
  const last = step === STEPS.length - 1;

  // Cada paso nuevo: el cuerpo arriba y el anuncio por la región viva. El foco
  // se queda en el botón que se pulsó (para avanzar con Enter seguido); sólo
  // si ese botón desapareció (Atrás en el primero, Siguiente en el último) el
  // foco va al título, para no dejarlo suelto en el documento.
  const goTo = (next: number) => {
    setStep(Math.min(Math.max(next, 0), STEPS.length - 1));
    requestAnimationFrame(() => {
      bodyRef.current?.scrollTo({ top: 0 });
      const active = document.activeElement;
      if (!active || active === document.body || !contentRef.current?.contains(active))
        titleRef.current?.focus();
    });
  };
  const go = (delta: number) => goTo(step + delta);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="animate-veil fixed inset-0 z-40 bg-ink/45 backdrop-blur-sm" />
        <div className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
          <Dialog.Content
            ref={contentRef}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              titleRef.current?.focus();
            }}
            onCloseAutoFocus={(e) => {
              if (!onClosed) return;
              e.preventDefault();
              onClosed();
            }}
            onKeyDown={(e) => {
              const tag = (e.target as HTMLElement).tagName;
              if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
              if (e.key === 'ArrowRight') go(1);
              else if (e.key === 'ArrowLeft') go(-1);
            }}
            className="animate-rise pointer-events-auto flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-card border border-border bg-surface shadow-pop outline-none sm:max-h-[90dvh] sm:max-w-5xl sm:rounded-card"
          >
            {/* Cabecera: dónde estoy, que es de mentira y cómo salgo. */}
            <div className="flex items-start gap-3 border-b border-border px-4 py-3.5 sm:px-6">
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
                <current.icon className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-micro font-semibold text-ink-faint">
                  <span aria-live="polite" className="tabular">
                    Paso {step + 1} de {STEPS.length}
                    <span className="sr-only">: {current.title}</span>
                  </span>
                  <SampleBadge />
                </p>
                <Dialog.Title
                  ref={titleRef}
                  tabIndex={-1}
                  className="mt-0.5 text-lg font-extrabold leading-tight tracking-tight text-ink outline-none focus-visible:outline-none sm:text-xl"
                >
                  {current.title}
                </Dialog.Title>
              </div>
              <Dialog.Close
                aria-label="Cerrar el recorrido"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-pill text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <X className="h-5 w-5" aria-hidden />
              </Dialog.Close>
            </div>

            <Dialog.Description className="sr-only">
              Recorrido de cinco pasos con una empresa inventada. Ningún dato es tuyo ni se guarda.
              Usa las flechas o los botones de abajo para avanzar; Escape cierra.
            </Dialog.Description>

            <div
              ref={bodyRef}
              className="scroll-slim min-h-0 flex-1 overflow-y-auto bg-canvas px-4 py-5 sm:px-6"
            >
              <div key={current.id} className="animate-rise">
                {current.id === 'inicio' && <HomeStep />}
                {current.id === 'pulso' && <PulseStep brand={brand} />}
                {current.id === 'proceso' && <ProcessStep />}
                {current.id === 'preguntar' && <AskStep />}
                {current.id === 'empezar' && <StartStep onLeave={() => onOpenChange(false)} />}
              </div>
            </div>

            {/* Pie: el avance y los dos botones. */}
            <div className="flex items-center gap-3 border-t border-border px-4 py-3 sm:px-6">
              <ol className="flex flex-1 items-center gap-1.5" aria-label="Pasos del recorrido">
                {STEPS.map((s, i) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => goTo(i)}
                      aria-label={`Ir al paso ${i + 1}: ${s.title}`}
                      aria-current={i === step ? 'step' : undefined}
                      className="grid h-6 place-items-center px-0.5"
                    >
                      <span
                        className={clsx(
                          'block h-2 rounded-pill transition-all duration-200 motion-reduce:transition-none',
                          i === step
                            ? 'w-6 bg-primary'
                            : i < step
                              ? 'w-2 bg-primary/50'
                              : 'w-2 bg-border-strong',
                        )}
                      />
                    </button>
                  </li>
                ))}
              </ol>
              {step > 0 && (
                <Button type="button" variant="ghost" onClick={() => go(-1)}>
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  <span className="hidden sm:inline">Atrás</span>
                  <span className="sr-only sm:hidden">Atrás</span>
                </Button>
              )}
              {last ? (
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Terminar
                </Button>
              ) : (
                <Button type="button" onClick={() => go(1)}>
                  Siguiente
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SampleBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-pill bg-amber-soft px-2 py-0.5 text-micro font-bold text-ink">
      <FlaskConical className="h-3 w-3 text-amber" aria-hidden />
      Datos de ejemplo
    </span>
  );
}

function Lead({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 max-w-2xl text-sm leading-relaxed text-ink-muted">{children}</p>;
}

const TILE_TONE = {
  amber: 'border-amber/40 bg-amber-soft/60',
  primary: 'border-primary/25 bg-primary-soft/60',
  rose: 'border-rose/30 bg-rose-soft/60',
} as const;

/** (a) El Inicio con números: las colas, la plata y lo que hizo Cortex. */
function HomeStep() {
  return (
    <>
      <Lead>
        Cada mañana abres Cortex y ves en una frase lo que te espera, cuánto dinero se mueve esta
        semana y lo que Cortex ya hizo por ti mientras dormías.
      </Lead>
      <div className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5">
        <p className="text-micro font-semibold capitalize text-ink-faint">jueves, 2 de octubre</p>
        <p className="mt-1 text-xl font-extrabold tracking-tight text-ink sm:text-2xl">
          Hola, Laura. ¿Qué resolvemos hoy?
        </p>
        <p className="mt-1 text-sm font-semibold text-ink-muted">{SAMPLE_HOME.sentence}</p>
        <ul className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {SAMPLE_HOME.tiles.map((t) => (
            <li key={t.label} className={clsx('rounded-card border p-3.5', TILE_TONE[t.tone])}>
              <p className="text-xs font-semibold text-ink-muted">{t.label}</p>
              <p className="tabular mt-1 text-xl font-extrabold tracking-tight text-ink">
                {t.value}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">{t.note}</p>
            </li>
          ))}
        </ul>
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-xs font-bold text-ink">Lo que hizo Cortex anoche</p>
          <ul className="mt-2 space-y-1.5">
            {SAMPLE_HOME.journal.map((line) => (
              <li key={line} className="flex items-start gap-2 text-sm text-ink-muted">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

/** (b) El pulso de la empresa con los componentes de vista de verdad. */
function PulseStep({ brand }: { brand: ViewBrand | null }) {
  const view = useMemo(() => samplePulseView(), []);
  return (
    <>
      <Lead>
        Pídele a Cortex «dime cómo va la empresa» y arma esta vista con tus ventas, tu cartera y lo
        que vence. Cada mañana la pone al día y escribe el resumen arriba.
        {brand ? ' Con tus colores y tu logo.' : ''}
      </Lead>
      <div className="rounded-card border border-border bg-surface p-3 shadow-card sm:p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 px-1">
          <h3 className="text-base font-extrabold tracking-tight text-ink">Pulso de la empresa</h3>
          <span className="text-xs text-ink-faint">· {SAMPLE_COMPANY}</span>
          <span className="ml-auto inline-flex items-center gap-1 text-micro font-semibold text-ink-faint">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden />
            Se actualiza cada día a las 7:00
          </span>
        </div>
        <ViewBrandProvider brand={brand}>
          <ViewCanvas view={view} target={{ kind: 'preview' }} />
        </ViewBrandProvider>
      </div>
    </>
  );
}

/** (c) Un proceso: la cartera que avisa sola. */
function ProcessStep() {
  return (
    <>
      <Lead>
        Un proceso es un trabajo que Cortex hace solo, a la hora que digas. Lo activas una vez y
        sigue andando. Este es uno de los listos para usar:
      </Lead>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5">
          <div className="flex items-center gap-2">
            <Workflow className="h-4 w-4 text-primary" aria-hidden />
            <h3 className="text-base font-extrabold tracking-tight text-ink">
              {SAMPLE_PROCESS.name}
            </h3>
          </div>
          <p className="mt-0.5 text-xs text-ink-faint">{SAMPLE_PROCESS.schedule}</p>
          <ol className="mt-4 space-y-4">
            {SAMPLE_PROCESS.steps.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span
                  aria-hidden
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-extrabold text-primary-ink"
                >
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-ink">{s.title}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-xs font-bold text-ink-muted">
            <BellRing className="h-3.5 w-3.5 text-primary" aria-hidden />
            Lo que te llega al celular
          </p>
          <div className="rounded-card rounded-tl-sm border border-emerald/30 bg-emerald-soft p-3.5 text-sm leading-relaxed text-ink shadow-card">
            <p className="mb-1 text-micro font-bold text-emerald">Cortex · 7:02 a. m.</p>
            {SAMPLE_PROCESS.message}
          </div>
          <div className="mt-1 flex flex-wrap gap-2" aria-hidden>
            <span className="rounded-pill bg-primary px-3 py-1.5 text-xs font-bold text-white">
              Aprobar y enviar
            </span>
            <span className="rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-xs font-bold text-ink">
              Ver el borrador
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/** (d) La caja de preguntas. */
function AskStep() {
  return (
    <>
      <Lead>
        Arriba del Inicio está la caja de preguntas. Escribe como le hablarías a alguien de tu
        equipo: Cortex busca en tus datos, te responde con cifras y te dice de dónde las sacó.
      </Lead>
      <div className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5">
        <div className="flex items-center gap-2 rounded-[1.25rem] border-2 border-primary bg-surface py-2 pl-4 pr-2">
          <Search className="h-5 w-5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 truncate py-1.5 text-base font-medium text-ink">
            {SAMPLE_ASK.question}
          </span>
          <span
            aria-hidden
            className="grid h-10 w-10 shrink-0 place-items-center rounded-card bg-primary text-white"
          >
            <ArrowRight className="h-4 w-4" />
          </span>
        </div>
        <div className="mt-4 flex gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-soft text-primary">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1.5 text-sm leading-relaxed text-ink">
            {SAMPLE_ASK.answer.map((p) => (
              <p key={p}>{p}</p>
            ))}
            <p className="text-micro text-ink-faint">Fuente: Cartera · facturas de clientes</p>
          </div>
        </div>
        <ul className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3" aria-hidden>
          {SAMPLE_ASK.suggestions.map((s) => (
            <li
              key={s}
              className="rounded-pill border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted"
            >
              {s}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** (e) Lo que sigue: tus datos, o el pulso pedido en una frase. */
function StartStep({ onLeave }: { onLeave: () => void }) {
  return (
    <div className="mx-auto max-w-2xl py-2 text-center">
      <p className="text-sm leading-relaxed text-ink-muted">
        Todo lo que viste era de una empresa inventada. Con tus datos, Cortex hace lo mismo con tu
        negocio. Tienes dos caminos:
      </p>
      <div className="mt-5 grid gap-3 text-left sm:grid-cols-2">
        <Link
          href="/onboarding/fuentes"
          onClick={onLeave}
          className="group flex flex-col gap-2 rounded-card border-2 border-primary bg-surface p-4 shadow-card transition-all duration-150 hover:-translate-y-px hover:shadow-pop motion-reduce:transform-none motion-reduce:transition-none"
        >
          <span className="grid h-10 w-10 place-items-center rounded-sm bg-primary-soft text-primary">
            <Plug className="h-5 w-5" aria-hidden />
          </span>
          <span className="text-base font-extrabold text-ink">Conecta tus datos</span>
          <span className="text-sm leading-relaxed text-ink-muted">
            Elige de dónde salen: una hoja de cálculo, tu correo, tu Drive o tu programa contable.
          </span>
          <span className="mt-auto inline-flex items-center gap-1 pt-1 text-sm font-bold text-primary">
            Elegir de dónde
            <ArrowRight
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
              aria-hidden
            />
          </span>
        </Link>
        <Link
          href={`/chat?prompt=${encodeURIComponent(PULSE_PROMPT)}`}
          onClick={onLeave}
          className="group flex flex-col gap-2 rounded-card border border-border-strong bg-surface p-4 shadow-card transition-all duration-150 hover:-translate-y-px hover:shadow-pop motion-reduce:transform-none motion-reduce:transition-none"
        >
          <span className="grid h-10 w-10 place-items-center rounded-sm bg-primary-soft text-primary">
            <Sparkles className="h-5 w-5" aria-hidden />
          </span>
          <span className="text-base font-extrabold text-ink">Pídele el pulso a Cortex</span>
          <span className="text-sm leading-relaxed text-ink-muted">
            «{PULSE_PROMPT}». Arma la vista con lo que ya tengas y te dice qué le falta.
          </span>
          <span className="mt-auto inline-flex items-center gap-1 pt-1 text-sm font-bold text-primary">
            Pedirlo en el chat
            <ArrowRight
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
              aria-hidden
            />
          </span>
        </Link>
      </div>
    </div>
  );
}
