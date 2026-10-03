'use client';

import { ProcessCatalog } from '@/components/self-service/ProcessCatalog';
import { CATALOG_ICON, SourceTile } from '@/components/sources/visuals';
import { SOURCES, type SourceId, type SourceOption, sourceHref } from '@/lib/self-service/catalog';
import { FIRST_STEPS_SEEN_COOKIE } from '@/lib/self-service/setup';
import type { CatalogIcon, CatalogTone } from '@/lib/sources/catalog';
import { clsx } from 'clsx';
import { ArrowLeft, ArrowRight, Check, Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * El asistente de los primeros 10 minutos: paso 2 (tus datos) y paso 3 (tu
 * primer proceso). El paso 1 —tu empresa— ya lo tiene la guía y la entrevista.
 *
 * Todo el estado es local: qué fuente se eligió y el enlace pegado. Al seguir
 * se navega a donde el catálogo diga (lib/self-service/catalog.ts); aquí no se
 * guarda nada, así que volver atrás o cerrar la pestaña no deja nada a medias.
 */

// Los mismos iconos y colores que «Conecta algo nuevo» en Datos y conexiones:
// una carpeta de Drive se reconoce igual en las dos pantallas.
const VISUAL: Record<SourceId, { icon: CatalogIcon; tone: CatalogTone }> = {
  drive: { icon: 'folder', tone: 'primary' },
  sheet: { icon: 'sheet', tone: 'emerald' },
  email: { icon: 'google', tone: 'rose' },
  file: { icon: 'calculator', tone: 'amber' },
  describe: { icon: 'chat', tone: 'primary' },
  api: { icon: 'api', tone: 'neutral' },
};

type Step = 'source' | 'process';

export function FirstSteps({
  initialStep,
  googleConnected,
  companyKnown,
}: {
  initialStep: Step;
  googleConnected: boolean;
  companyKnown: boolean;
}) {
  const [step, setStep] = useState<Step>(initialStep);

  useEffect(() => {
    document.cookie = `${FIRST_STEPS_SEEN_COOKIE}=1; path=/; max-age=31536000; samesite=lax`;
  }, []);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 pb-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Stepper step={step} onPick={setStep} companyKnown={companyKnown} />
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

function Stepper({
  step,
  onPick,
  companyKnown,
}: {
  step: Step;
  onPick: (s: Step) => void;
  companyKnown: boolean;
}) {
  const items: { id: Step | 'company'; label: string; done: boolean }[] = [
    { id: 'company', label: 'Tu empresa', done: companyKnown },
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
                href="/onboarding/entrevista"
                className={clsx(
                  'flex items-center gap-2 hover:underline',
                  item.done ? 'text-emerald' : 'text-ink-muted',
                )}
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
                  'flex items-start rounded-card border p-4 text-left shadow-card transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  active
                    ? 'border-primary bg-primary-soft/50 ring-1 ring-primary'
                    : 'border-border bg-surface hover:border-border-strong',
                )}
              >
                <SourceTile
                  icon={CATALOG_ICON[VISUAL[s.id].icon]}
                  tone={VISUAL[s.id].tone}
                  title={s.title}
                  body={s.body}
                  badge={
                    s.needsGoogle && googleConnected ? (
                      <span className="rounded-pill bg-emerald-soft px-2 py-0.5 text-micro font-bold text-emerald">
                        Google conectado
                      </span>
                    ) : null
                  }
                />
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
        <Link
          href="/integrations#conecta"
          className="inline-flex items-center gap-1 px-1 text-xs font-bold text-primary hover:underline"
        >
          Ver todo lo que puedes conectar <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </aside>
    </div>
  );
}

function ProcessStep({ onBack }: { onBack: () => void }) {
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

      <ProcessCatalog />

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
