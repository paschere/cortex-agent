'use client';

import {
  PROCESS_TEMPLATES,
  type ProcessTemplate,
  SOURCES,
  type SourceId,
  type SourceOption,
  sourceHref,
} from '@/lib/self-service/catalog';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  FileSpreadsheet,
  FileText,
  Folder,
  Lock,
  Mail,
  MessageSquareText,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * El asistente de los primeros 10 minutos: paso 2 (tus datos) y paso 3 (tu
 * primer proceso). El paso 1 —tu empresa— ya lo tiene la guía y la entrevista.
 *
 * Todo el estado es local: qué fuente se eligió y el enlace pegado. Al seguir
 * se navega a donde el catálogo diga (lib/self-service/catalog.ts); aquí no se
 * guarda nada, así que volver atrás o cerrar la pestaña no deja nada a medias.
 */

const ICONS: Record<SourceId, typeof Folder> = {
  drive: Folder,
  sheet: FileSpreadsheet,
  email: Mail,
  file: FileText,
  describe: MessageSquareText,
  api: Braces,
};

const TONES: Record<SourceId, string> = {
  drive: 'bg-primary-soft text-primary',
  sheet: 'bg-emerald-soft text-emerald',
  email: 'bg-rose-soft text-rose',
  file: 'bg-amber-soft text-amber',
  describe: 'bg-primary-soft text-primary',
  api: 'bg-surface-2 text-ink-muted',
};

type Step = 'source' | 'process';

export function FirstSteps({
  initialStep,
  googleConnected,
}: {
  initialStep: Step;
  googleConnected: boolean;
}) {
  const [step, setStep] = useState<Step>(initialStep);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 pb-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Stepper step={step} onPick={setStep} />
        <Link
          href="/dashboard"
          className="text-sm font-semibold text-ink-faint transition-colors hover:text-ink"
        >
          Lo hago después
        </Link>
      </header>

      {step === 'source' ? (
        <SourceStep googleConnected={googleConnected} onSkip={() => setStep('process')} />
      ) : (
        <ProcessStep onBack={() => setStep('source')} />
      )}
    </div>
  );
}

function Stepper({ step, onPick }: { step: Step; onPick: (s: Step) => void }) {
  const items: { id: Step | 'company'; label: string; done: boolean }[] = [
    { id: 'company', label: 'Tu empresa', done: true },
    { id: 'source', label: 'Tus datos', done: step === 'process' },
    { id: 'process', label: 'Tu primer proceso', done: false },
  ];
  return (
    <ol aria-label="Pasos" className="flex flex-wrap items-center gap-2 text-sm font-bold">
      {items.map((item, i) => {
        const current = item.id === step;
        const content = (
          <>
            <span
              className={clsx(
                'grid h-6 w-6 place-items-center rounded-full text-xs',
                item.done
                  ? 'bg-emerald text-white'
                  : current
                    ? 'bg-primary text-white'
                    : 'border-2 border-border-strong text-ink-faint',
              )}
              aria-hidden
            >
              {item.done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
            </span>
            {item.label}
          </>
        );
        return (
          <li key={item.id} className="flex items-center gap-2">
            {i > 0 && (
              <span
                aria-hidden
                className={clsx(
                  'h-0.5 w-6 sm:w-10',
                  item.done || current ? 'bg-primary/40' : 'bg-border',
                )}
              />
            )}
            {item.id === 'company' ? (
              <Link
                href="/onboarding"
                className="flex items-center gap-2 text-emerald hover:underline"
              >
                {content}
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => onPick(item.id as Step)}
                aria-current={current ? 'step' : undefined}
                className={clsx(
                  'flex items-center gap-2',
                  item.done
                    ? 'text-emerald'
                    : current
                      ? 'text-primary'
                      : 'text-ink-faint hover:text-ink',
                )}
              >
                {content}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function SourceStep({
  googleConnected,
  onSkip,
}: {
  googleConnected: boolean;
  onSkip: () => void;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<SourceId>('drive');
  const [url, setUrl] = useState('');
  const option = SOURCES.find((s) => s.id === picked) as SourceOption;
  const blockedByGoogle = option.needsGoogle && !googleConnected;
  const urlOk = !option.needsUrl || option.needsUrl.pattern.test(url.trim());

  function go() {
    if (blockedByGoogle || !urlOk) return;
    router.push(sourceHref(option, url));
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section className="flex flex-col gap-5">
        <div>
          <p className="text-sm font-bold text-primary">Paso 2 de 3 · unos 3 minutos</p>
          <h1 className="mt-1.5 text-balance text-2xl font-extrabold leading-tight tracking-tight text-ink sm:text-3xl">
            ¿Dónde vive hoy la información de tu empresa?
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted sm:text-base">
            Elige una para empezar. Cortex la lee, entiende qué tiene y te arma una tabla. Puedes
            sumar más cuando quieras.
          </p>
        </div>

        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">Fuente de datos</legend>
          {SOURCES.map((s) => {
            const Icon = ICONS[s.id];
            const active = s.id === picked;
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setPicked(s.id);
                  setUrl('');
                }}
                className={clsx(
                  'flex items-start gap-3.5 rounded-card border p-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  active
                    ? 'border-primary bg-primary-soft/50 ring-1 ring-primary'
                    : 'border-border bg-surface hover:border-border-strong',
                )}
              >
                <span
                  className={clsx(
                    'grid h-10 w-10 shrink-0 place-items-center rounded-card',
                    TONES[s.id],
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="flex flex-col gap-1">
                  <span className="text-sm font-extrabold text-ink">{s.title}</span>
                  <span className="text-xs leading-relaxed text-ink-muted">{s.body}</span>
                </span>
              </button>
            );
          })}
        </fieldset>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
          className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card"
        >
          {blockedByGoogle ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink-muted">
                Para leer {option.id === 'email' ? 'tu correo' : 'tu Drive'} primero conecta tu
                cuenta de Google. Cortex solo lee lo que le pidas.
              </p>
              <a
                href="/api/integrations/google?preset=all"
                className="cortex-primary-button inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-sm font-bold text-white hover:bg-primary-strong"
              >
                Conectar Google <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
            </div>
          ) : (
            <>
              {option.needsUrl && (
                <>
                  <label htmlFor="source-url" className="text-sm font-extrabold text-ink">
                    {option.needsUrl.label}
                  </label>
                  <input
                    id="source-url"
                    type="url"
                    inputMode="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder={option.needsUrl.placeholder}
                    aria-invalid={url.trim() !== '' && !urlOk}
                    className="w-full rounded-card border border-border-strong bg-surface-2/60 px-3.5 py-2.5 font-mono text-sm text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                  {url.trim() !== '' && !urlOk && (
                    <p className="text-xs text-rose">
                      Ese enlace no parece de {option.title.toLowerCase()}.
                    </p>
                  )}
                </>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-ink-faint">
                  {'href' in option.go
                    ? 'Te llevo a la pantalla para hacerlo.'
                    : 'Cortex te muestra lo que encontró y pregunta antes de crear nada.'}
                </p>
                <button
                  type="submit"
                  disabled={!urlOk || (!!option.needsUrl && url.trim() === '')}
                  className="cortex-primary-button inline-flex items-center gap-1.5 rounded-pill bg-primary px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {option.cta} <ArrowRight className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </>
          )}
        </form>

        <div className="flex items-center justify-between">
          <Link
            href="/onboarding"
            className="inline-flex items-center gap-1 text-sm font-semibold text-ink-faint hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Guía completa
          </Link>
          <button
            type="button"
            onClick={onSkip}
            className="text-sm font-semibold text-ink-muted hover:text-primary"
          >
            Ya tengo mis datos: elegir un proceso →
          </button>
        </div>
      </section>

      <aside className="flex flex-col gap-4">
        <div className="rounded-card bg-ink p-5 text-surface shadow-pop">
          <h2 className="text-base font-extrabold">En 10 minutos vas a tener</h2>
          <ol className="mt-3 flex flex-col gap-2.5 text-sm leading-relaxed opacity-90">
            <li className="flex gap-2.5">
              <span className="font-extrabold text-primary-soft">1</span>Tus datos en una tabla que
              se llena sola
            </li>
            <li className="flex gap-2.5">
              <span className="font-extrabold text-primary-soft">2</span>Una vista para tu equipo,
              con su enlace
            </li>
            <li className="flex gap-2.5">
              <span className="font-extrabold text-primary-soft">3</span>Un aviso cuando llegue algo
              nuevo
            </li>
          </ol>
        </div>
        <p className="flex items-start gap-2.5 px-1 text-xs leading-relaxed text-ink-muted">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-emerald" aria-hidden />
          Cortex solo lee lo que le das. Nada sale de tu empresa sin que lo apruebes, y cada acción
          queda registrada.
        </p>
      </aside>
    </div>
  );
}

function ProcessStep({ onBack }: { onBack: () => void }) {
  const [area, setArea] = useState<ProcessTemplate['area'] | 'Todos'>('Todos');
  const areas = ['Todos', ...new Set(PROCESS_TEMPLATES.map((t) => t.area))] as const;
  const shown = PROCESS_TEMPLATES.filter((t) => area === 'Todos' || t.area === area);

  return (
    <section className="flex flex-col gap-5">
      <div>
        <p className="text-sm font-bold text-primary">Paso 3 de 3 · unos 2 minutos</p>
        <h1 className="mt-1.5 text-balance text-2xl font-extrabold leading-tight tracking-tight text-ink sm:text-3xl">
          Elige el primer proceso que Cortex hará solo
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted sm:text-base">
          Cada uno trae su tabla, su vista y sus avisos. Lo activas, Cortex te pregunta lo justo y
          queda andando.
        </p>
      </div>

      <div role="tablist" aria-label="Áreas" className="flex flex-wrap gap-2">
        {areas.map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={area === a}
            onClick={() => setArea(a)}
            className={clsx(
              'rounded-pill px-3.5 py-1.5 text-xs font-bold transition-colors',
              area === a
                ? 'bg-ink text-surface'
                : 'border border-border bg-surface text-ink-muted hover:text-ink',
            )}
          >
            {a}
          </button>
        ))}
      </div>

      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((t) => (
          <li
            key={t.id}
            className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5 shadow-card"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-micro font-bold uppercase tracking-wider text-ink-faint">
                {t.area}
              </span>
              {t.featured && (
                <span className="rounded-pill bg-amber-soft px-2 py-0.5 text-micro font-bold text-amber">
                  El más usado
                </span>
              )}
            </div>
            <h2 className="text-base font-extrabold text-ink">{t.title}</h2>
            <p className="text-sm leading-relaxed text-ink-muted">{t.body}</p>
            <p className="text-xs text-ink-faint">Necesita: {t.needs}</p>
            <Link
              href={`/chat?prompt=${encodeURIComponent(t.prompt)}`}
              className={clsx(
                'mt-auto inline-flex items-center justify-center gap-1.5 rounded-pill px-4 py-2.5 text-sm font-bold transition-colors',
                t.featured
                  ? 'cortex-primary-button bg-primary text-white hover:bg-primary-strong'
                  : 'border border-border-strong bg-surface text-ink hover:bg-surface-2',
              )}
            >
              Activar en 2 minutos
            </Link>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-4 rounded-card border-2 border-dashed border-border-strong bg-surface p-5">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
          <Sparkles className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-extrabold text-ink">
            ¿No está el tuyo? Descríbelo y Cortex lo arma.
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            «Cuando llegue un pedido nuevo al correo, ponlo en la tabla y avísale al de turno.»
          </p>
        </div>
        <Link
          href={`/chat?prompt=${encodeURIComponent('Quiero que hagas esto solo, cada vez que pase: ')}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-ink px-4 py-2.5 text-sm font-bold text-surface hover:opacity-90"
        >
          Describir mi proceso
        </Link>
      </div>

      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 self-start text-sm font-semibold text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Volver a tus datos
      </button>
    </section>
  );
}
