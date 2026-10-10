'use client';

import { BarChart } from '@/components/charts/BarChart';
import { CHART_COLOR } from '@/components/charts/colors';
import { formatCompact } from '@/components/charts/scales';
import {
  type Piece,
  type PnlMonth,
  type PnlPanel,
  categoryChanges,
  changeText,
  findMonth,
  formatMoney,
  isNewFromZero,
  monthLabel,
  monthShort,
  pctChange,
  shiftMonth,
} from '@/lib/finance/dashboard-shape';
import { clsx } from 'clsx';
import { BarChart3, Lock } from 'lucide-react';
import { useState } from 'react';
import { NoData, Section } from './pieces';

/**
 * RESULTADOS DEL MES: ventas, gastos y margen del mes que se mira contra el
 * anterior y contra el mismo mes del año pasado (si hay con qué), la tendencia
 * de doce meses (tocar un mes lo pone arriba) y en qué se fue la plata, por
 * categoría. La nómina, para quien no administra, es sólo un total.
 */
export function PnlSection({ pnl }: { pnl: Piece<PnlPanel> }) {
  const [focus, setFocus] = useState(pnl.ok ? pnl.data.focus : '');
  if (!pnl.ok) {
    return (
      <Section
        id="resultados"
        title="Resultados del mes"
        icon={<BarChart3 className="h-4 w-4" aria-hidden />}
      >
        <NoData reason={pnl.error} />
      </Section>
    );
  }
  const { months, currency, payrollConfidential } = pnl.data;
  const current = findMonth(months, focus);
  // Un mes sin un solo movimiento no es «cero»: es que no hay con qué comparar.
  const withData = (m: PnlMonth | null) =>
    m && (m.sales !== 0 || m.otherIncome !== 0 || m.expenses !== 0) ? m : null;
  const previous = withData(findMonth(months, shiftMonth(focus, -1)));
  const lastYear = withData(findMonth(months, shiftMonth(focus, -12)));
  const trend = months.slice(-12);
  const categories = categoryChanges(current, previous, { payrollConfidential });
  const maxCategory = Math.max(1, ...categories.map((c) => c.amount));
  const fm = (n: number) => formatMoney(n, currency);
  // Ventas sin un solo gasto: el margen sería el 100 % de lo que entró, una
  // cifra inventada por lo que falta. Se dice que faltan los gastos.
  const noExpenses = current
    ? current.sales + current.otherIncome > 0 && current.expenses <= 0
    : false;
  const isCurrentMonth = focus === pnl.data.months[pnl.data.months.length - 1]?.month;

  return (
    <Section
      id="resultados"
      title="Resultados del mes"
      icon={<BarChart3 className="h-4 w-4" aria-hidden />}
      subtitle={
        <>
          {monthLabel(focus)}
          {isCurrentMonth ? ' (va en curso)' : ''}. Plata que entró y salió, sin traslados entre tus
          cuentas.
        </>
      }
    >
      {!current ? (
        <p className="text-sm text-ink-muted">No hay movimientos en {monthLabel(focus)}.</p>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi
              label="Ventas"
              value={fm(current.sales)}
              previous={previous?.sales}
              lastYear={lastYear?.sales}
              now={current.sales}
              note={
                current.otherIncome > 0 ? `+ ${fm(current.otherIncome)} de otros ingresos` : null
              }
            />
            <Kpi
              label="Gastos"
              value={noExpenses ? 'Sin registrar' : fm(current.expenses)}
              previous={noExpenses ? null : previous?.expenses}
              lastYear={noExpenses ? null : lastYear?.expenses}
              now={current.expenses}
              note={
                noExpenses
                  ? 'No hay gastos en este mes: sube los extractos del banco o conecta tu programa contable.'
                  : null
              }
              higherIsWorse
            />
            <Kpi
              label="Margen"
              value={noExpenses ? '—' : fm(current.margin)}
              previous={noExpenses ? null : previous?.margin}
              lastYear={noExpenses ? null : lastYear?.margin}
              now={current.margin}
              note={
                noExpenses
                  ? 'Faltan los gastos: sin ellos no se puede afirmar un margen.'
                  : marginNote(current)
              }
              negative={!noExpenses && current.margin < 0}
            />
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold text-ink-muted">Los últimos 12 meses</h3>
            <Trend months={trend} focus={focus} onFocus={setFocus} currency={currency} />
          </div>

          <div>
            <h3 className="mb-3 text-xs font-semibold text-ink-muted">
              Gastos por categoría en {monthLabel(focus, false)}
              {previous ? ` · contra ${monthLabel(previous.month, false)}` : ''}
            </h3>
            {categories.length === 0 ? (
              <p className="text-sm text-ink-muted">Sin gastos registrados ese mes.</p>
            ) : (
              <ul className="space-y-3">
                {categories.map((c) => (
                  <li key={c.key}>
                    <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                      <span className="flex min-w-0 items-center gap-1.5 truncate font-medium text-ink">
                        {c.confidential && (
                          <Lock className="h-3 w-3 shrink-0 text-ink-faint" aria-hidden />
                        )}
                        {c.label}
                      </span>
                      <span className="flex shrink-0 items-baseline gap-2">
                        <span className="tabular font-mono font-semibold text-ink">
                          {fm(c.amount)}
                        </span>
                        <Change change={c.change} isNew={c.isNew} higherIsWorse />
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-pill bg-surface-2">
                      <div
                        className="h-full rounded-pill bg-primary/70"
                        style={{
                          width: `${Math.max((c.amount / maxCategory) * 100, c.amount > 0 ? 2 : 0)}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {payrollConfidential && (
              <p className="mt-3 text-micro text-ink-faint">
                La nómina se muestra como un total: el detalle por persona lo ven quienes
                administran la empresa.
              </p>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

function marginNote(m: PnlMonth): string | null {
  const income = m.sales + m.otherIncome;
  if (income <= 0) return null;
  return `${Math.round((m.margin / income) * 100)} % de lo que entró`;
}

function Kpi({
  label,
  value,
  now,
  previous,
  lastYear,
  note,
  higherIsWorse,
  negative,
}: {
  label: string;
  value: string;
  now: number;
  previous?: number | null;
  lastYear?: number | null;
  note?: string | null;
  higherIsWorse?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="rounded-sm bg-surface-2 px-4 py-3">
      <p className="field-label text-ink-faint">{label}</p>
      <p
        className={clsx(
          'tabular stat-num mt-1 font-mono text-lg font-bold',
          negative ? 'text-rose' : 'text-ink',
        )}
      >
        {value}
      </p>
      {note && <p className="text-micro text-ink-muted">{note}</p>}
      <dl className="mt-2 space-y-0.5 text-micro text-ink-muted">
        {previous != null && (
          <div className="flex justify-between gap-2">
            <dt>vs mes anterior</dt>
            <dd>
              <Change
                change={pctChange(now, previous)}
                isNew={isNewFromZero(now, previous)}
                higherIsWorse={higherIsWorse}
              />
            </dd>
          </div>
        )}
        {lastYear != null && (
          <div className="flex justify-between gap-2">
            <dt>vs hace un año</dt>
            <dd>
              <Change
                change={pctChange(now, lastYear)}
                isNew={isNewFromZero(now, lastYear)}
                higherIsWorse={higherIsWorse}
              />
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function Change({
  change,
  isNew,
  higherIsWorse,
}: {
  change: number | null;
  isNew?: boolean;
  higherIsWorse?: boolean;
}) {
  if (change == null && isNew)
    return <span className="tabular font-mono text-ink-muted">nuevo</span>;
  if (change == null) return <span className="tabular font-mono text-ink-faint">—</span>;
  const up = change > 0.005;
  const down = change < -0.005;
  const good = higherIsWorse ? down : up;
  const bad = higherIsWorse ? up : down;
  return (
    <span
      className={clsx(
        'tabular font-mono font-semibold',
        good ? 'text-emerald' : bad ? 'text-amber' : 'text-ink-muted',
      )}
    >
      {changeText(change)}
    </span>
  );
}

function Trend({
  months,
  focus,
  onFocus,
  currency,
}: {
  months: PnlMonth[];
  focus: string;
  onFocus: (m: string) => void;
  currency: string;
}) {
  const fm = (n: number) => formatMoney(n, currency);
  const selectedIndex = months.findIndex((m) => m.month === focus);
  return (
    <BarChart
      barMode="grouped"
      labels={months.map((m) => monthShort(m.month))}
      titles={months.map((m) => `${monthLabel(m.month)} · margen ${fm(m.margin)}`)}
      bars={[
        {
          id: 'in',
          label: 'Entró',
          color: CHART_COLOR.emerald,
          values: months.map((m) => m.sales + m.otherIncome),
          display: months.map((m) => fm(m.sales + m.otherIncome)),
        },
        {
          id: 'out',
          label: 'Salió',
          color: 'rgb(var(--ink-faint) / 0.55)',
          values: months.map((m) => m.expenses),
          display: months.map((m) => fm(m.expenses)),
        },
      ]}
      selectedIndex={selectedIndex >= 0 ? selectedIndex : null}
      onSelect={(i) => {
        const m = months[i];
        if (m) onFocus(m.month);
      }}
      formatAxis={(n) => formatCompact(n, { money: currency.toUpperCase() === 'COP' })}
      formatValue={fm}
      tooltipHint="Toca para ver el mes"
      height={220}
      ariaLabel={`Entradas y salidas por mes: ${months.map((m) => `${monthLabel(m.month)} entró ${fm(m.sales + m.otherIncome)}, salió ${fm(m.expenses)}, margen ${fm(m.margin)}`).join('; ')}. Con las flechas se recorre mes por mes y con Enter se elige.`}
    />
  );
}
