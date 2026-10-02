import { readSetupSteps } from '@/lib/self-service/read';
import { setupProgress } from '@/lib/self-service/setup';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { clsx } from 'clsx';
import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';

/**
 * «TU CORTEX ESTÁ LISTO AL 60%».
 *
 * Cinco pasos con su botón, en una franja. Desaparece sola cuando los cinco
 * están hechos: una lista de tareas cumplidas en la primera pantalla es ruido.
 * El paso que sigue va resaltado — es la única decisión que pide la franja.
 */
export async function SetupStrip({
  organizationId,
  userId,
  isAdmin,
}: {
  organizationId: string;
  userId: string;
  isAdmin: boolean;
}) {
  const all = await readSetupSteps(getOrgScopedClient(organizationId), userId);
  // Invitar personas y contar la empresa son cosas de quien administra; a los
  // demás no se les pide lo que no pueden hacer.
  const steps = isAdmin ? all : all.filter((s) => s.id !== 'team' && s.id !== 'company');
  const progress = setupProgress(steps);
  if (progress.complete) return null;

  return (
    <section
      aria-labelledby="setup-title"
      className="mb-4 grid gap-5 rounded-card border border-border bg-surface p-5 shadow-card lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:items-center"
    >
      <div className="flex flex-col gap-2.5">
        <h2 id="setup-title" className="text-lg font-extrabold tracking-tight text-ink">
          Tu Cortex está listo al <span className="tabular">{progress.percent}%</span>
        </h2>
        <p className="text-sm leading-relaxed text-ink-muted">
          {progress.total - progress.ready === 1
            ? 'Un paso más y Cortex empieza a trabajar solo.'
            : `${progress.total - progress.ready} pasos más y Cortex empieza a trabajar solo: avisa lo que vence, persigue pendientes y te resume el día.`}
        </p>
        <div className="h-2 overflow-hidden rounded-pill bg-surface-2" aria-hidden>
          <div
            className="h-full rounded-pill bg-primary transition-[width] duration-500"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        <Link
          href="/onboarding"
          className="text-xs font-semibold text-ink-faint transition-colors hover:text-primary"
        >
          Ver la guía completa
        </Link>
      </div>

      <ol
        className={clsx(
          'grid grid-cols-1 gap-2.5 sm:grid-cols-2',
          steps.length >= 5 ? 'xl:grid-cols-5' : 'xl:grid-cols-3',
        )}
      >
        {steps.map((step, i) => {
          const isNext = progress.next?.id === step.id;
          return (
            <li
              key={step.id}
              className={clsx(
                'flex flex-col gap-1.5 rounded-card border p-3.5',
                step.ready
                  ? 'border-emerald/25 bg-emerald-soft/60'
                  : isNext
                    ? 'border-primary bg-primary-soft/60 ring-1 ring-primary'
                    : 'border-border bg-surface',
              )}
            >
              <span
                className={clsx(
                  'grid h-7 w-7 place-items-center rounded-full text-xs font-extrabold',
                  step.ready
                    ? 'bg-emerald text-white'
                    : isNext
                      ? 'border-2 border-primary text-primary'
                      : 'border-2 border-border-strong text-ink-faint',
                )}
                aria-hidden
              >
                {step.ready ? <Check className="h-4 w-4" strokeWidth={3} /> : i + 1}
              </span>
              <span className="text-sm font-bold text-ink">{step.title}</span>
              {step.ready ? (
                <span className="text-xs text-emerald">
                  <span className="sr-only">Hecho: </span>
                  {step.done || 'Listo'}
                </span>
              ) : (
                <Link
                  href={step.action.href}
                  className={clsx(
                    'inline-flex items-center gap-1 text-xs font-bold',
                    isNext
                      ? 'text-primary hover:text-primary-strong'
                      : 'text-ink-muted hover:text-primary',
                  )}
                >
                  {step.action.label}
                  <ArrowRight className="h-3 w-3" aria-hidden />
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
