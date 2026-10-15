'use client';

import { CartesianChart } from '@/components/charts/CartesianChart';
import { MetricChart } from '@/components/charts/MetricChart';
import { CHART_COLOR } from '@/components/charts/colors';
import type { MetricModel } from '@/components/charts/metric-types';
import { formatCompact } from '@/components/charts/scales';
import { ActionNote, fieldClass, pillLink, pillPrimary } from '@/components/finance/pieces';
import { Panel } from '@/components/ui/panel';
import { MONTHS_SHORT, capital, fullMoney, monthName } from '@/lib/statements/format';
import type { BudgetVsRow } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { AlertTriangle, ArrowRight, BellRing, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import type { BudgetScreenProps } from './types';

/**
 * LO QUE SE AGREGA A «PRESUPUESTO CONTRA REAL» (0228): las alertas del mes con
 * su umbral editable, el gráfico de presupuesto contra real mes a mes (y la
 * evolución contra el año pasado) y el detalle de movimientos de una categoría.
 * Todo llega calculado (budget/alerts.ts, budget/store.ts); aquí se pinta.
 */

const INCOME = new Set(['ventas', 'otros_ingresos']);
export const ALL_EXPENSES = '__gastos__';

const withQuery = (base: string, params: Record<string, string>) =>
  `${base}${base.includes('?') ? '&' : '?'}${new URLSearchParams(params).toString()}`;

// ---------------------------------------------------------------------------
// Alertas y umbrales
// ---------------------------------------------------------------------------

export function AlertsStrip(props: BudgetScreenProps) {
  const { report } = props;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(report.thresholds.enabled);
  const [warn, setWarn] = useState(String(report.thresholds.warnPct));
  const [over, setOver] = useState(String(report.thresholds.overPct));
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const alerts = report.alerts;
  const t = report.thresholds;
  const year = report.budget?.year ?? props.year;
  return (
    <Panel className="px-4 py-3" aria-label="Alertas de presupuesto">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BellRing
            className={clsx('h-4 w-4', alerts.length ? 'text-amber' : 'text-ink-faint')}
            aria-hidden
          />
          <h3 className="text-sm font-semibold text-ink">
            {alerts.length
              ? `${alerts.length} ${alerts.length === 1 ? 'gasto' : 'gastos'} de ${monthName(report.vs?.throughMonth ?? 1)} ${alerts.length === 1 ? 'pide' : 'piden'} atención`
              : 'Sin alertas este mes'}
          </h3>
          <span className="tabular text-micro text-ink-faint">
            {t.enabled
              ? `Aviso desde ${t.warnPct} % · «se pasó» desde ${t.overPct} % del presupuesto del mes`
              : 'Alertas apagadas'}
          </span>
        </div>
        {report.canEdit && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="rounded-pill bg-surface-2 px-3 py-1 text-xs font-semibold text-ink transition-colors hover:bg-border"
          >
            {open ? 'Cerrar' : 'Cambiar umbrales'}
          </button>
        )}
      </div>

      {alerts.length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {alerts.map((a) => (
            <li
              key={`${a.category}-${a.level}`}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <AlertTriangle
                  className={clsx(
                    'h-4 w-4 shrink-0',
                    a.level === 'excedido' ? 'text-rose' : 'text-amber',
                  )}
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{a.title}</p>
                  <p className="tabular text-micro text-ink-muted">
                    {fullMoney(a.actual)} de {fullMoney(a.budget)}
                    {a.over > 0 && (
                      <span className="ml-1.5 font-semibold text-rose">
                        · {fullMoney(a.over)} de más
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <Link
                href={withQuery(props.links.self, {
                  anio: String(year),
                  detalle: a.category,
                  mes: String(a.month),
                })}
                className={pillLink}
              >
                Ver los movimientos <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <form
          className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await props.actions.saveThresholds({
                enabled,
                warnPct: Number(warn),
                overPct: Number(over),
              });
              setNote(
                r.ok ? { ok: true, text: r.note ?? 'Guardado.' } : { ok: false, text: r.error },
              );
              if (r.ok) router.refresh();
            });
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
            Avisar desde (%)
            <input
              className={clsx(fieldClass, 'tabular w-24')}
              inputMode="numeric"
              value={warn}
              onChange={(e) => setWarn(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
            «Se pasó» desde (%)
            <input
              className={clsx(fieldClass, 'tabular w-24')}
              inputMode="numeric"
              value={over}
              onChange={(e) => setOver(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs font-semibold text-ink-muted">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-[rgb(var(--primary))]"
            />
            Mandar avisos
          </label>
          <button type="submit" disabled={pending} className={pillPrimary}>
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Guardar
          </button>
          <p className="basis-full text-micro text-ink-faint">
            Los avisos llegan a quienes administran, por la campana (respetando sus preferencias de
            avisos), y salen en «Para ti, hoy». Uno por categoría, mes y nivel.
          </p>
          <ActionNote note={note} />
        </form>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Gráficos
// ---------------------------------------------------------------------------

function seriesFor(rows: BudgetVsRow[], key: string) {
  const picked =
    key === ALL_EXPENSES
      ? rows.filter((r) => r.kind === 'gasto')
      : rows.filter((r) => r.category === key);
  const budget = Array.from({ length: 12 }, (_, i) =>
    picked.reduce((s, r) => s + (r.months[i]?.budget ?? 0), 0),
  );
  const actual = Array.from({ length: 12 }, (_, i) =>
    picked.some((r) => r.months[i]?.actual !== null)
      ? picked.reduce((s, r) => s + (r.months[i]?.actual ?? 0), 0)
      : null,
  );
  const toDate = Array.from({ length: 12 }, (_, i) =>
    picked.reduce((s, r) => s + (r.months[i]?.budgetToDate ?? 0), 0),
  );
  return { budget, actual, toDate };
}

export function TrendSection({
  props,
  month,
  setMonth,
}: {
  props: BudgetScreenProps;
  month: number;
  setMonth: (m: number) => void;
}) {
  const vs = props.report.vs;
  const [key, setKey] = useState<string>(ALL_EXPENSES);
  const rows = vs?.rows ?? [];
  const options = useMemo(
    () => [
      { value: ALL_EXPENSES, label: 'Todos los gastos' },
      ...rows.filter((r) => r.kind === 'gasto').map((r) => ({ value: r.category, label: r.label })),
    ],
    [rows],
  );
  const { budget, actual, toDate } = useMemo(() => seriesFor(rows, key), [rows, key]);
  const through = vs?.throughMonth ?? 0;
  const label = options.find((o) => o.value === key)?.label ?? 'Gastos';

  const metric: MetricModel = useMemo(() => {
    const monthly = props.report.monthly.map((m) => ({
      date: `${m.month}-15`,
      value:
        key === ALL_EXPENSES
          ? Object.entries(m.byCategory)
              .filter(([k]) => !INCOME.has(k))
              .reduce((s, [, v]) => s + v, 0)
          : (m.byCategory[key] ?? 0),
    }));
    const current = budget[Math.max(through, 1) - 1] ?? 0;
    return {
      id: `evolucion-${key}`,
      label: `${label}, mes a mes`,
      hint: 'Lo real de cada mes; «comparar» lo pone contra el año pasado',
      fmt: 'money',
      currency: 'COP',
      kind: 'flow',
      tone: 'primary',
      goodWhenUp: false,
      daily: monthly,
      ...(current > 0
        ? {
            threshold: {
              value: current,
              label: `Presupuesto de ${monthName(Math.max(through, 1))}`,
            },
          }
        : {}),
    };
  }, [props.report.monthly, key, label, budget, through]);

  if (!vs) return null;
  const real = actual[month - 1] ?? null;
  const base = toDate[month - 1] ?? 0;
  const variance = real === null ? null : real - base;
  const partial = month === through && vs.currentFraction < 1;
  const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '');
  return (
    <Panel className="px-4 py-4" aria-label="Presupuesto contra real mes a mes">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Presupuesto contra real, mes a mes</h3>
          <p className="tabular text-micro text-ink-muted">
            {capital(monthName(month))}:{' '}
            {real === null
              ? `${fullMoney(budget[month - 1] ?? 0)} presupuestados, todavía no pasa`
              : `${fullMoney(real)} reales de ${fullMoney(base)}${partial ? ` (el ${Math.round(vs.currentFraction * 100)} % del mes de ${fullMoney(budget[month - 1] ?? 0)})` : ''}${
                  variance !== null && base > 0
                    ? ` · ${sign(variance)}${fullMoney(Math.abs(variance))} (${sign(variance)}${Math.abs(Math.round((variance / base) * 100))} %)`
                    : ''
                }`}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
          Categoría
          <select
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className={clsx(fieldClass, 'max-w-[220px]')}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <CartesianChart
        labels={[...MONTHS_SHORT].slice(0, 12).map((m) => capital(m))}
        titles={Array.from({ length: 12 }, (_, i) => `${capital(monthName(i + 1))} ${vs.year}`)}
        bars={[
          {
            id: 'real',
            label: 'Real',
            color: CHART_COLOR.primary,
            values: actual.map((v) => v ?? 0),
            goodWhenUp: false,
            dim: actual.flatMap((v, i) => (v === null ? [i] : [])),
          },
        ]}
        lines={[
          {
            id: 'presupuesto',
            label: 'Presupuesto',
            color: CHART_COLOR.amber,
            values: budget,
            dashed: true,
            curve: 'linear',
            dots: true,
          },
        ]}
        selectedIndex={month - 1}
        onSelect={(i) => setMonth(i + 1)}
        formatAxis={(n) => formatCompact(n, { money: true })}
        formatValue={(n) => fullMoney(n)}
        height={230}
        legend
        ariaLabel={`Presupuesto contra real de ${label} en ${vs.year}`}
      />
      <div className="mt-5 border-t border-border pt-4">
        <MetricChart metric={metric} today={props.today} defaultRange="12m" height={210} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Detalle de una categoría en un mes
// ---------------------------------------------------------------------------

export function DrillPanel({ props }: { props: BudgetScreenProps }) {
  const d = props.drill;
  if (!d) return null;
  const back = withQuery(props.links.self, { anio: String(d.year) });
  return (
    <Panel className="px-4 py-4" aria-label="Movimientos de la categoría">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">
            {d.label} en {monthName(d.month)} de {d.year}
          </h3>
          <p className="tabular text-micro text-ink-muted">
            {d.confidential
              ? 'El detalle de la nómina lo ve quien administra.'
              : `${d.count} ${d.count === 1 ? 'movimiento' : 'movimientos'} · ${fullMoney(d.total)}`}
          </p>
        </div>
        <Link href={back} className={pillLink}>
          <X className="h-3.5 w-3.5" aria-hidden /> Cerrar el detalle
        </Link>
      </div>
      {!d.confidential && d.rows.length === 0 ? (
        <p className="text-xs text-ink-muted">No hay movimientos de esta categoría en ese mes.</p>
      ) : (
        !d.confidential && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead className="text-micro text-ink-faint">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Fecha</th>
                  <th className="py-1.5 pr-3 font-medium">Contraparte</th>
                  <th className="py-1.5 pr-3 font-medium">Descripción</th>
                  <th className="tabular py-1.5 text-right font-medium">Valor</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="tabular py-1.5 pr-3 font-mono text-ink-muted">
                      {r.date.slice(8)}/{r.date.slice(5, 7)}
                    </td>
                    <td className="max-w-[200px] truncate py-1.5 pr-3 font-medium text-ink">
                      {r.counterparty ?? '—'}
                    </td>
                    <td className="max-w-[320px] truncate py-1.5 pr-3 text-ink-muted">
                      {r.description}
                    </td>
                    <td
                      className={clsx(
                        'tabular py-1.5 text-right font-mono font-semibold',
                        r.amount < 0 ? 'text-emerald' : 'text-ink',
                      )}
                    >
                      {fullMoney(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {d.truncated && (
        <p className="mt-2 text-micro text-ink-faint">
          Hay más movimientos de los que se leen de una vez; la lista muestra los mayores.
        </p>
      )}
    </Panel>
  );
}
