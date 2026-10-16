'use client';

import { type PlanState, type PlanStatus, planProgress } from '@/lib/plan-state';
import { clsx } from 'clsx';
import { AlertCircle, Check, ChevronDown, Loader2, Minus } from 'lucide-react';

/**
 * EL PLAN POR ADELANTADO, DIBUJADO.
 *
 * Una sola pieza para los dos sitios: la tarjeta plegable dentro de la
 * conversación y la sección «Plan» del panel de la computadora de Cortex. El
 * estado sale de `lib/plan-state.ts`; aquí sólo se pinta, con los pasos que
 * faltan todavía en gris.
 */

export function PlanStatusIcon({ status }: { status: PlanStatus }) {
  return (
    <span aria-hidden className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center">
      {status === 'done' ? (
        <Check className="h-4 w-4 text-emerald" />
      ) : status === 'failed' ? (
        <AlertCircle className="h-4 w-4 text-rose" />
      ) : status === 'in_progress' ? (
        <Loader2 className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" />
      ) : status === 'skipped' ? (
        <Minus className="h-4 w-4 text-ink-faint" />
      ) : (
        <span className="h-3.5 w-3.5 rounded-full border border-border-strong" />
      )}
    </span>
  );
}

const STATUS_WORD: Record<PlanStatus, string> = {
  pending: 'pendiente',
  in_progress: 'en curso',
  done: 'hecho',
  failed: 'falló',
  skipped: 'omitido',
};

export function PlanSteps({ plan, columns = false }: { plan: PlanState; columns?: boolean }) {
  return (
    <ol className={columns ? 'grid grid-cols-1 gap-x-4 sm:grid-cols-2' : 'flex flex-col'}>
      {plan.steps.map((s) => (
        <li key={s.id} className="flex items-start gap-2.5 py-1.5">
          <PlanStatusIcon status={s.status} />
          <div className="min-w-0 flex-1">
            <p
              className={clsx(
                'text-xs leading-snug [overflow-wrap:anywhere]',
                s.status === 'failed'
                  ? 'font-medium text-rose'
                  : s.status === 'pending' || s.status === 'skipped'
                    ? 'text-ink-faint'
                    : 'text-ink',
                s.status === 'skipped' && 'line-through',
              )}
            >
              <span className="sr-only">{STATUS_WORD[s.status]}: </span>
              {s.label}
            </p>
            {s.note && <p className="text-xs text-ink-muted [overflow-wrap:anywhere]">{s.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** La tarjeta del chat: «Plan · 2 de 5», la barra fina y los pasos en dos columnas. */
export function PlanCard({ plan }: { plan: PlanState }) {
  const { done, total, finished } = planProgress(plan);
  return (
    <details open={!finished} className="group rounded-[14px] border border-border bg-surface">
      <summary className="flex cursor-pointer list-none flex-col gap-2 px-3.5 py-3 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <span className="tabular min-w-0 flex-1 truncate text-micro font-bold text-ink-muted">
            Plan · {finished ? `${done} de ${total} hechos` : `${done} de ${total}`}
          </span>
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform group-open:rotate-180"
            aria-hidden
          />
        </span>
        <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-border">
          <span
            className="block h-full rounded-full bg-emerald transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }}
          />
        </span>
      </summary>
      <div className="px-3.5 pb-2.5">
        <p className="mb-1 truncate text-xs font-semibold text-ink">{plan.title}</p>
        <PlanSteps plan={plan} columns />
      </div>
    </details>
  );
}

/**
 * EL PLAN FIJO ARRIBA DEL CHAT.
 *
 * Mientras un plan está activo, la tarjeta se queda atrás en la conversación al
 * llegar más texto y se pierde de vista. Esta franja se pega arriba del área de
 * mensajes: el avance, el paso en curso y, al abrirla, todos los pasos. La
 * tarjeta del chat sigue donde estaba.
 */
export function PlanDock({ plan, live }: { plan: PlanState; live: boolean }) {
  const { done, total, finished } = planProgress(plan);
  const current =
    plan.steps.find((s) => s.status === 'in_progress') ??
    plan.steps.find((s) => s.status === 'failed') ??
    plan.steps.find((s) => s.status === 'pending');
  return (
    <div className="sticky top-0 z-20 px-4 pt-2 sm:px-6">
      <details className="group mx-auto w-full max-w-[46rem] rounded-[14px] border border-border bg-surface/95 shadow-card backdrop-blur supports-[backdrop-filter]:bg-surface/80">
        <summary className="flex cursor-pointer list-none flex-col gap-1.5 px-3.5 py-2 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            {current && !finished ? (
              <PlanStatusIcon status={live ? current.status : 'pending'} />
            ) : (
              <PlanStatusIcon status="done" />
            )}
            <span className="tabular shrink-0 text-micro font-bold text-ink-muted">
              Plan · {done} de {total}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-ink">
              {finished ? plan.title : (current?.label ?? plan.title)}
            </span>
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform group-open:rotate-180"
              aria-hidden
            />
          </span>
          <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-border">
            <span
              className="block h-full rounded-full bg-emerald transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }}
            />
          </span>
        </summary>
        <div className="scroll-slim max-h-[50vh] overflow-y-auto px-3.5 pb-2.5">
          <p className="mb-1 truncate text-xs font-semibold text-ink">{plan.title}</p>
          <PlanSteps plan={plan} columns />
        </div>
      </details>
    </div>
  );
}
