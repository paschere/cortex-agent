'use client';

import { Panel } from '@/components/ui/panel';
import type { PlanView } from '@/lib/autopilot/screen';
import { chipClass } from '@/lib/status-chip';
import { FlaskConical, Info, Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { ItemCard, ItemList } from './ItemCard';
import type { AutopilotActions } from './types';

/**
 * «PROBAR SIN HACER NADA»: el plan de hoy, armado con los datos de verdad y la
 * misma política que la corrida, sin escribir ni ejecutar nada. Sirve con el
 * piloto apagado: es como se decide encenderlo.
 */
export function DryRunPanel({
  actions,
  initial = null,
}: {
  actions: AutopilotActions;
  initial?: PlanView | null;
}) {
  const [plan, setPlan] = useState<PlanView | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () =>
    start(async () => {
      setError(null);
      const r = await actions.dryRun();
      if (r.ok) setPlan(r.plan);
      else setError(r.note);
    });

  return (
    <Panel className="p-5 sm:p-6" id="ensayo">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
            <FlaskConical className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold text-ink">Probar sin hacer nada</h2>
            <p className="mt-0.5 max-w-xl text-xs text-ink-muted">
              Miro la empresa como lo haría mañana a primera hora y te muestro qué haría solo, qué
              te preguntaría y qué sólo te contaría. No envío, no escribo, no cambio nada.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="cortex-primary-button inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-primary px-4 py-1.5 text-xs font-bold text-white transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <FlaskConical className="h-3.5 w-3.5" aria-hidden />
          )}
          {plan ? 'Probar otra vez' : 'Probar sin hacer nada'}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm font-semibold text-rose">
          {error}
        </p>
      )}

      {plan && (
        <div className="mt-5 space-y-6" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-ink first-letter:uppercase">{plan.dayLabel}</span>
            <span className={chipClass('primary')}>Haría solo: {plan.counts.do}</span>
            <span className={chipClass('amber')}>Te preguntaría: {plan.counts.ask}</span>
            <span className={chipClass('neutral')}>Te contaría: {plan.counts.tell}</span>
            {!plan.enabled && (
              <span className="text-xs text-ink-faint">
                (El piloto está apagado: esto es lo que haría si lo enciendes.)
              </span>
            )}
          </div>
          {plan.groups.length === 0 && (
            <p className="text-sm text-ink-muted">
              Hoy no encontré nada que hacer, preguntar ni contar en los datos de la empresa.
            </p>
          )}
          {plan.groups.map((g) => (
            <section key={g.decision} aria-label={g.title}>
              <h3 className="text-sm font-extrabold text-ink">
                {g.title} <span className="font-semibold text-ink-faint">({g.items.length})</span>
              </h3>
              <p className="mb-3 text-xs text-ink-muted">{g.hint}</p>
              <ItemList>
                {g.items.map((item, i) => (
                  <ItemCard key={`${g.decision}-${i}-${item.title}`} item={item} />
                ))}
              </ItemList>
            </section>
          ))}
          {(plan.stillWaiting > 0 || plan.suppressed > 0 || plan.sourceErrors.length > 0) && (
            <div className="space-y-1 rounded-sm bg-surface-2 px-4 py-3 text-xs text-ink-muted">
              {plan.stillWaiting > 0 && (
                <p className="flex gap-1.5">
                  <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {plan.stillWaiting === 1
                    ? '1 cosa sigue esperando tu decisión desde otro día; no la vuelvo a pedir.'
                    : `${plan.stillWaiting} cosas siguen esperando tu decisión desde otro día; no las vuelvo a pedir.`}
                </p>
              )}
              {plan.suppressed > 0 && (
                <p className="flex gap-1.5">
                  <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {plan.suppressed === 1
                    ? '1 cosa ya la hice o la descartaste esta semana, así que no la repito.'
                    : `${plan.suppressed} cosas ya las hice o las descartaste esta semana, así que no las repito.`}
                </p>
              )}
              {plan.sourceErrors.length > 0 && (
                <p className="flex gap-1.5 text-amber">
                  <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  No pude mirar {plan.sourceErrors.join(', ')}: lo de ahí no está en el plan, y eso
                  no quiere decir que no haya nada.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
