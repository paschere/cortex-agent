'use client';

import {
  type ForecastPanel,
  type Piece,
  chartWeeks,
  dashboardHref,
  formatDay,
  formatMoney,
  fullMoney,
  parseMoneyInput,
} from '@/lib/finance/dashboard-shape';
import type { ForecastAlert } from '@cortex/agent-tools/src/ledger/types';
import { clsx } from 'clsx';
import { AlertOctagon, AlertTriangle, CalendarRange, Info } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { CashFlowChart } from './CashFlowChart';
import { WeekDrawer } from './WeekDrawer';
import { NoData, Section, fieldClass, pillLink } from './pieces';
import type { FinanceActions } from './types';

const ALERT_STYLE: Record<ForecastAlert['severity'], { box: string; icon: typeof Info }> = {
  critical: { box: 'border-rose/25 bg-rose-soft text-rose', icon: AlertOctagon },
  warn: { box: 'border-amber/25 bg-amber-soft text-amber', icon: AlertTriangle },
  info: { box: 'border-sky/20 bg-sky-soft text-sky', icon: Info },
};

/**
 * FLUJO DE CAJA, 13 SEMANAS: las alertas en frases arriba, el dibujo, y cada
 * semana se abre para ver por qué. Si hay un escenario abierto, su línea va
 * encima de la base y la frase de la comparación encabeza la sección.
 */
export function ForecastSection({
  forecast,
  self,
  scenarioId,
  includeEstimatedSales,
  minimumCash,
  companyMinimumCash = null,
  saveMinimumCash,
}: {
  forecast: Piece<ForecastPanel>;
  self: string;
  scenarioId: string | null;
  includeEstimatedSales: boolean;
  /** `?minimo=`: sólo para esta vista. */
  minimumCash: number | null;
  /** La guardada de la empresa (0175). */
  companyMinimumCash?: number | null;
  /** Sólo para quien administra o es dueño; sin ella no hay botón de guardar. */
  saveMinimumCash?: FinanceActions['saveMinimumCash'];
}) {
  const [week, setWeek] = useState<string | null>(null);
  const data = forecast.ok ? forecast.data : null;
  const weeks = useMemo(
    () => (data ? chartWeeks(data.base, data.scenario, data.minimumCash) : []),
    [data],
  );
  const params = { scenarioId, includeEstimatedSales, minimumCash };
  const shown = data ? (data.scenario ?? data.base) : null;
  const alerts = shown?.alerts ?? [];

  return (
    <Section
      id="flujo"
      title="Flujo de caja, 13 semanas"
      icon={<CalendarRange className="h-4 w-4" aria-hidden />}
      subtitle={
        data
          ? `Desde hoy, ${formatDay(data.base.asOf)}, con ${formatMoney(data.base.startingCash, data.currency)} en caja. Toca una semana para ver por qué.`
          : undefined
      }
      right={
        <Link
          href={dashboardHref(
            self,
            { ...params, includeEstimatedSales: !includeEstimatedSales },
            'flujo',
          )}
          role="switch"
          aria-checked={includeEstimatedSales}
          scroll={false}
          className={clsx(
            pillLink,
            includeEstimatedSales && 'border-primary/30 bg-primary-soft text-primary-ink',
          )}
        >
          <span
            aria-hidden
            className={clsx(
              'relative inline-block h-4 w-7 rounded-pill transition-colors',
              includeEstimatedSales ? 'bg-primary' : 'bg-border-strong',
            )}
          >
            <span
              className={clsx(
                'absolute top-0.5 h-3 w-3 rounded-pill bg-surface transition-all',
                includeEstimatedSales ? 'left-3.5' : 'left-0.5',
              )}
            />
          </span>
          Incluir ventas estimadas
        </Link>
      }
    >
      {!data ? (
        <NoData reason={(forecast as { error: string }).error} />
      ) : (
        <div className="space-y-4">
          {data.comparison && (
            <p className="rounded-sm border border-amber/25 bg-amber-soft px-4 py-3 text-sm font-medium text-ink">
              {data.comparison.summary}
            </p>
          )}
          {alerts.length > 0 && (
            <ul className="space-y-2" aria-label="Alertas de caja">
              {alerts.slice(0, 4).map((a, i) => {
                const style = ALERT_STYLE[a.severity];
                const Icon = style.icon;
                return (
                  <li
                    key={`${a.kind}-${a.week ?? i}`}
                    className={clsx(
                      'flex items-start gap-2.5 rounded-sm border px-3.5 py-2.5',
                      style.box,
                    )}
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <p className="text-sm text-ink">
                      <span className="sr-only">
                        {a.severity === 'critical'
                          ? 'Urgente: '
                          : a.severity === 'warn'
                            ? 'Atención: '
                            : 'Nota: '}
                      </span>
                      {a.message}
                      {a.week && (
                        <button
                          type="button"
                          onClick={() => setWeek(a.week ?? null)}
                          className="ml-1.5 text-xs font-semibold text-primary hover:underline"
                        >
                          Ver la semana
                        </button>
                      )}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}

          <CashFlowChart
            weeks={weeks}
            currency={data.currency}
            minimumCash={data.minimumCash}
            scenarioLabel={data.scenario?.scenario?.label ?? null}
            selected={week}
            onSelect={setWeek}
          />

          <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3">
            <MinimumForm
              self={self}
              params={params}
              currency={data.currency}
              companyMinimum={companyMinimumCash}
              save={saveMinimumCash}
            />
            {data.base.assumptions.length > 0 && (
              <details className="max-w-xl text-xs text-ink-muted">
                <summary className="cursor-pointer select-none font-semibold hover:text-ink">
                  Cómo se calcula ({data.base.assumptions.length} supuestos)
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  {data.base.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          <WeekDrawer
            result={shown ?? data.base}
            base={data.scenario ? data.base : null}
            week={week}
            onClose={() => setWeek(null)}
          />
        </div>
      )}
    </Section>
  );
}

/**
 * LA CAJA MÍNIMA. «Marcar» la pone sólo en esta vista (`?minimo=`). «Guardar
 * como mínimo de la empresa» la guarda para todos (`ledger_settings`): la
 * proyección, el centro de mando, el pulso y la revisión semanal miden contra
 * ella. Ese botón sólo sale a quien administra o es dueño, y el servidor lo
 * vuelve a revisar. Se puede deshacer desde el mismo aviso.
 */
function MinimumForm({
  self,
  params,
  currency,
  companyMinimum,
  save,
}: {
  self: string;
  params: { scenarioId: string | null; includeEstimatedSales: boolean; minimumCash: number | null };
  currency: string;
  companyMinimum: number | null;
  save?: FinanceActions['saveMinimumCash'];
}) {
  const router = useRouter();
  const shown = params.minimumCash ?? companyMinimum;
  const [value, setValue] = useState(
    shown != null ? new Intl.NumberFormat('es-CO').format(shown) : '',
  );
  const [note, setNote] = useState<{ ok: boolean; text: string; undo?: number | null } | null>(
    null,
  );
  const [pending, start] = useTransition();
  const afterSave = () => {
    // Lo guardado manda: si la vista traía su propio `?minimo=`, se quita.
    if (params.minimumCash != null)
      router.push(dashboardHref(self, { ...params, minimumCash: null }, 'flujo'), {
        scroll: false,
      });
    else router.refresh();
  };
  const store = (amount: string | null, previous: number | null | undefined) =>
    start(async () => {
      if (!save) return;
      const r = await save({ amount, currency });
      if (r.ok) {
        setNote({ ok: true, text: r.note, undo: previous });
        afterSave();
      } else setNote({ ok: false, text: r.error });
    });
  const differs = params.minimumCash != null && params.minimumCash !== companyMinimum;
  return (
    <div className="space-y-1.5">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const min = parseMoneyInput(value);
          router.push(dashboardHref(self, { ...params, minimumCash: min }, 'flujo'), {
            scroll: false,
          });
        }}
      >
        <label className="block">
          <span className="field-label text-ink-faint">Caja mínima que quiero tener</span>
          <input
            className={`${fieldClass} tabular mt-1 w-40 font-mono`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="20.000.000"
            inputMode="decimal"
          />
        </label>
        <button type="submit" className={pillLink}>
          Marcar
        </button>
        {save && (
          <button
            type="button"
            className={clsx(pillLink, 'border-primary/30 text-primary-ink')}
            disabled={pending}
            onClick={() => store(value.trim() || null, companyMinimum)}
          >
            {pending ? 'Guardando…' : 'Guardar como mínimo de la empresa'}
          </button>
        )}
      </form>
      <p className="text-xs text-ink-muted">
        {companyMinimum != null
          ? `Mínimo de la empresa: ${fullMoney(companyMinimum, currency)}.`
          : 'La empresa no ha fijado una caja mínima: se mide contra un mes de gastos fijos.'}
        {differs ? ' Esta vista usa la que marcaste.' : ''}
      </p>
      {note && (
        <output
          aria-live="polite"
          className={clsx('block text-xs font-medium', note.ok ? 'text-emerald' : 'text-rose')}
        >
          {note.text}
          {note.ok && note.undo !== undefined && save && (
            <button
              type="button"
              className="ml-1.5 font-semibold text-primary hover:underline"
              disabled={pending}
              onClick={() => {
                const previous = note.undo;
                setNote(null);
                store(previous != null ? String(Math.round(previous)) : null, undefined);
              }}
            >
              Deshacer
            </button>
          )}
        </output>
      )}
    </div>
  );
}
