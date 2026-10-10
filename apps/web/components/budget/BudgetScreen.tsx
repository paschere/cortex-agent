'use client';

import { BarChart } from '@/components/charts/BarChart';
import { CHART_COLOR } from '@/components/charts/colors';
import { formatCompact } from '@/components/charts/scales';
import DataGrid from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow } from '@/components/datagrid/types';
import {
  ActionNote,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from '@/components/finance/pieces';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import {
  MONTHS_SHORT,
  capital,
  fullMoney,
  monthName,
  pct,
  shortMoney,
  shortMonthKey,
} from '@/lib/statements/format';
import type { BudgetVsRow } from '@cortex/agent-tools';
import { missingExpensesNote as budgetMissingExpensesNote } from '@cortex/agent-tools/src/budget/notes';
import { clsx } from 'clsx';
import { ArrowRight, CheckCircle2, Loader2, PencilLine, Target, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import type { BudgetScreenProps } from './types';

/**
 * /presupuesto (0191): el presupuesto del año contra lo real (con semáforo),
 * la grilla para editarlo y el pronóstico de 12 meses con su escenario.
 * Todo llega calculado (budget/, forecast/); aquí se pinta y se edita.
 */

const LIGHT_TONE: Record<string, 'emerald' | 'amber' | 'rose' | 'neutral'> = {
  verde: 'emerald',
  amarillo: 'amber',
  rojo: 'rose',
  sin_presupuesto: 'amber',
  pendiente: 'neutral',
};

const TABS = [
  { id: 'real', label: 'Presupuesto contra real', icon: Target },
  { id: 'editar', label: 'Editar el presupuesto', icon: PencilLine },
  { id: 'pronostico', label: 'Pronóstico a 12 meses', icon: TrendingUp },
] as const;

const withParam = (base: string, params: Record<string, string>) => {
  const qs = new URLSearchParams(params).toString();
  return `${base}${base.includes('?') ? '&' : '?'}${qs}`;
};

export function BudgetScreen(props: BudgetScreenProps) {
  const [tab, setTab] = useState(props.tab);
  const { report } = props;
  const budget = report.budget;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Presupuesto y pronóstico"
        subtitle="Lo que la empresa se propuso para el año, contra lo que de verdad entró y salió, y lo que viene si todo sigue al ritmo de hoy."
        icon={<Target className="h-5 w-5" />}
        actions={
          <>
            <Link href={props.links.statements} className={pillLink}>
              Estados financieros <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
            <Link href={props.links.board} className={pillPrimary}>
              Informe para socios
            </Link>
          </>
        }
      />

      <BudgetBar {...props} />

      <div
        className="flex flex-wrap gap-1 border-b border-border"
        role="tablist"
        aria-label="Presupuesto"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={clsx(
              '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold transition-colors duration-150 motion-reduce:transition-none',
              tab === t.id
                ? 'border-primary text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            <t.icon className="h-4 w-4" aria-hidden />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'real' && (budget && report.vs ? <VsTab {...props} /> : <CreateBudget {...props} />)}
      {tab === 'editar' && (budget ? <EditTab {...props} /> : <CreateBudget {...props} />)}
      {tab === 'pronostico' && <ForecastTab {...props} />}
    </div>
  );
}

function BudgetBar(props: BudgetScreenProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const b = props.report.budget;
  const nowYear = Number(props.today.slice(0, 4));
  const years = [nowYear - 1, nowYear, nowYear + 1];
  const status = (s: 'aprobado' | 'archivado' | 'borrador') =>
    start(async () => {
      if (!b) return;
      const r = await props.actions.setStatus(b.id, s);
      setNote(r.ok ? { ok: true, text: r.note ?? 'Listo.' } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return (
    <Panel className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        {years.map((y) => (
          <Link
            key={y}
            href={withParam(props.links.self, { anio: String(y) })}
            aria-current={y === props.year ? 'page' : undefined}
            className={clsx(
              'rounded-pill px-3 py-1 text-xs font-semibold',
              y === props.year
                ? 'bg-primary text-white'
                : 'bg-surface-2 text-ink-muted hover:text-ink',
            )}
          >
            {y}
          </Link>
        ))}
        {props.budgets.length > 1 && (
          <select
            aria-label="Versión del presupuesto"
            className="min-h-8 rounded-sm border border-border-strong bg-surface px-2 text-xs text-ink"
            value={b?.id ?? ''}
            onChange={(e) =>
              router.push(
                withParam(props.links.self, { anio: String(props.year), v: e.target.value }),
              )
            }
          >
            {props.budgets.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · {props.statusLabels[x.status]}
              </option>
            ))}
          </select>
        )}
      </div>
      {b ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ink">{b.name}</span>
          <span
            className={statusPill(
              b.status === 'aprobado' ? 'emerald' : b.status === 'archivado' ? 'neutral' : 'amber',
            )}
          >
            {props.statusLabels[b.status]}
          </span>
          {props.report.canEdit && b.status === 'borrador' && (
            <button
              type="button"
              className={pillPrimary}
              disabled={pending}
              onClick={() => status('aprobado')}
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              )}
              Aprobar
            </button>
          )}
          {props.report.canEdit && b.status === 'aprobado' && (
            <button
              type="button"
              className={pillLink}
              disabled={pending}
              onClick={() => status('borrador')}
            >
              Volver a borrador
            </button>
          )}
          <ActionNote note={note} />
        </div>
      ) : (
        <span className="text-xs text-ink-muted">Sin presupuesto para {props.year}.</span>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

function CreateBudget(props: BudgetScreenProps) {
  const router = useRouter();
  const [basis, setBasis] = useState<'ultimo_anio' | 'desde_cero'>(
    props.hasLastYear ? 'ultimo_anio' : 'desde_cero',
  );
  const [growth, setGrowth] = useState('10');
  const [incomeGrowth, setIncomeGrowth] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  if (!props.report.canEdit)
    return (
      <Panel className="p-6">
        <h2 className="text-lg font-extrabold text-ink">
          Todavía no hay presupuesto para {props.year}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">Lo arma quien administra la empresa.</p>
      </Panel>
    );
  return (
    <Panel className="max-w-2xl p-6">
      <h2 className="text-lg font-extrabold text-ink">Armar el presupuesto de {props.year}</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Lo más rápido es partir de lo que de verdad pasó el año anterior, mes por mes, y subirlo o
        bajarlo un porcentaje. Después se ajusta cada celda en la grilla.
      </p>
      <fieldset className="mt-5 space-y-3">
        <legend className="sr-only">Cómo empezar</legend>
        <label
          className={clsx(
            'flex cursor-pointer items-start gap-3 rounded-sm border p-3',
            basis === 'ultimo_anio' ? 'border-primary bg-primary-soft/40' : 'border-border',
          )}
        >
          <input
            type="radio"
            name="basis"
            checked={basis === 'ultimo_anio'}
            onChange={() => setBasis('ultimo_anio')}
            disabled={!props.hasLastYear}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-semibold text-ink">
              Desde lo real de {props.year - 1}
            </span>
            <span className="block text-xs text-ink-muted">
              {props.hasLastYear
                ? 'Cada categoría y mes igual que el año pasado ± el porcentaje.'
                : `No hay movimientos de ${props.year - 1} en el libro.`}
            </span>
          </span>
        </label>
        <label
          className={clsx(
            'flex cursor-pointer items-start gap-3 rounded-sm border p-3',
            basis === 'desde_cero' ? 'border-primary bg-primary-soft/40' : 'border-border',
          )}
        >
          <input
            type="radio"
            name="basis"
            checked={basis === 'desde_cero'}
            onChange={() => setBasis('desde_cero')}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-semibold text-ink">Desde cero</span>
            <span className="block text-xs text-ink-muted">
              Una grilla vacía para llenar categoría por categoría.
            </span>
          </span>
        </label>
      </fieldset>
      {basis === 'ultimo_anio' && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-semibold text-ink-muted">
            Gastos: cambio frente a {props.year - 1} (%)
            <input
              className={clsx(fieldClass, 'mt-1')}
              inputMode="decimal"
              value={growth}
              onChange={(e) => setGrowth(e.target.value)}
            />
          </label>
          <label className="block text-xs font-semibold text-ink-muted">
            Ingresos: cambio (%) — vacío = el mismo
            <input
              className={clsx(fieldClass, 'mt-1')}
              inputMode="decimal"
              value={incomeGrowth}
              onChange={(e) => setIncomeGrowth(e.target.value)}
            />
          </label>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={pillPrimary}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const g = Number(growth.replace(',', '.'));
              const ig = incomeGrowth.trim() ? Number(incomeGrowth.replace(',', '.')) : null;
              if (!Number.isFinite(g) || (ig !== null && !Number.isFinite(ig))) {
                setNote({ ok: false, text: 'Escribe el porcentaje como número (10 o −5).' });
                return;
              }
              const r = await props.actions.create({
                year: props.year,
                basis,
                growthPct: g,
                incomeGrowthPct: ig,
              });
              setNote(r.ok ? { ok: true, text: r.note ?? 'Listo.' } : { ok: false, text: r.error });
              if (r.ok) router.refresh();
            })
          }
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Crear el borrador
        </button>
        <ActionNote note={note} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Contra lo real
// ---------------------------------------------------------------------------

function VsTab(props: BudgetScreenProps) {
  const vs = props.report.vs;
  const [month, setMonth] = useState(Math.max(vs?.throughMonth ?? 1, 1));
  if (!vs) return null;
  const t = vs.totals;
  const cards = [
    { label: 'Ingresos', real: t.income.actual, budget: t.income.budget, kind: 'ingreso' as const },
    { label: 'Gastos', real: t.expense.actual, budget: t.expense.budget, kind: 'gasto' as const },
    { label: 'Margen', real: t.margin.actual, budget: t.margin.budget, kind: 'ingreso' as const },
  ];
  const columns: GridColumn[] = [
    { key: 'categoria', label: 'Categoría', type: 'text', pinned: true, primary: true, width: 220 },
    {
      key: 'tipo',
      label: 'Tipo',
      type: 'select',
      width: 100,
      options: [
        { value: 'ingreso', label: 'Ingreso', tone: 'emerald' },
        { value: 'gasto', label: 'Gasto', tone: 'neutral' },
      ],
    },
    { key: 'pm', label: `Presupuesto ${monthName(month)}`, type: 'money', width: 160 },
    { key: 'rm', label: `Real ${monthName(month)}`, type: 'money', width: 140 },
    { key: 'vm', label: 'Variación del mes', type: 'money', width: 150 },
    { key: 'py', label: 'Presupuesto a la fecha', type: 'money', width: 170 },
    { key: 'ry', label: 'Real a la fecha', type: 'money', width: 150 },
    { key: 'ej', label: 'Ejecución', type: 'percent', width: 110 },
    {
      key: 'semaforo',
      label: 'Semáforo',
      type: 'status',
      width: 190,
      options: Object.entries(props.lightLabels).map(([value, label]) => ({
        value,
        label,
        tone: LIGHT_TONE[value] ?? 'neutral',
      })),
    },
    { key: 'nota', label: 'Nota', type: 'text', width: 230 },
    { key: 'anio', label: `Presupuesto ${props.year}`, type: 'money', width: 150 },
  ];
  const rows: GridRow[] = vs.rows.map((r: BudgetVsRow) => {
    const c = r.months[month - 1];
    return {
      id: r.category,
      locked: true,
      values: {
        categoria: r.label,
        tipo: r.kind,
        pm: c?.budgetToDate ?? 0,
        rm: c?.actual ?? null,
        vm: c?.variance ?? null,
        py: r.ytd.budget,
        ry: r.ytd.actual,
        ej: r.ytd.pct === null ? null : Math.round(r.ytd.pct * 1000) / 10,
        semaforo: r.ytd.light,
        nota: budgetMissingExpensesNote(r.missingMonths),
        anio: r.yearBudget,
      },
    };
  });
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map((c) => {
          const noExpenses = t.expensesMissing && c.label !== 'Ingresos';
          if (noExpenses)
            return (
              <Panel key={c.label} className="px-4 py-3">
                <p className="field-label text-ink-faint">{c.label} a la fecha</p>
                <p className="tabular stat-num mt-1 font-mono text-xl font-bold text-ink-faint">
                  —
                </p>
                <p className="mt-1 text-micro text-ink-muted">
                  Hay ingresos pero ningún gasto registrado: no se compara con el presupuesto de{' '}
                  {shortMoney(c.budget)}. Trae los gastos (extractos del banco, Siigo o facturas de
                  compra).
                </p>
              </Panel>
            );
          const ratio = c.budget > 0.5 ? c.real / c.budget : null;
          const good = ratio === null ? null : c.kind === 'gasto' ? ratio <= 1 : ratio >= 1;
          return (
            <Panel key={c.label} className="px-4 py-3">
              <p className="field-label text-ink-faint">{c.label} a la fecha</p>
              <p className="tabular stat-num mt-1 font-mono text-xl font-bold text-ink">
                {shortMoney(c.real)}
              </p>
              <p className="mt-1 text-micro text-ink-muted">
                de {shortMoney(c.budget)} presupuestados
                {ratio !== null && (
                  <span
                    className={clsx('ml-1.5 font-semibold', good ? 'text-emerald' : 'text-amber')}
                  >
                    {pct(ratio)}
                  </span>
                )}
              </p>
              {ratio !== null && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-pill bg-surface-2">
                  <div
                    className={clsx('h-full rounded-pill', good ? 'bg-emerald' : 'bg-amber')}
                    style={{ width: `${Math.min(ratio, 1.5) * (100 / 1.5)}%` }}
                  />
                </div>
              )}
            </Panel>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-ink-muted">Mes</span>
        {MONTHS_SHORT.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => setMonth(i + 1)}
            aria-pressed={month === i + 1}
            className={clsx(
              'rounded-sm px-2 py-1 text-micro font-semibold uppercase',
              month === i + 1
                ? 'bg-primary-soft text-primary'
                : 'text-ink-muted hover:bg-surface-2',
            )}
          >
            {label}
          </button>
        ))}
        {vs.currentFraction < 1 && month === vs.throughMonth && (
          <span className={statusPill('amber')}>
            {capital(monthName(month))} va en curso: se compara contra el{' '}
            {Math.round(vs.currentFraction * 100)} % del presupuesto del mes
          </span>
        )}
      </div>
      <DataGrid
        columns={columns}
        rows={rows}
        initialView={{ filters: [], sort: [], hidden: [], layout: 'table' }}
        exportName={`presupuesto-vs-real-${props.year}`}
        noun={{ one: 'categoría', many: 'categorías', gender: 'f' }}
        urlParam={false}
        height="auto"
      />
      {vs.unbudgeted.length > 0 && (
        <p className="text-xs text-ink-muted">
          Tuvieron gasto sin estar en el presupuesto: {vs.unbudgeted.join(', ')}. Agrégalas en
          «Editar el presupuesto».
        </p>
      )}
      {props.report.payrollConfidential && (
        <p className="text-xs text-ink-muted">
          La nómina real se compara como un solo total: el detalle lo ve quien administra.
        </p>
      )}
      <p className="text-xs text-ink-muted">
        Lo real es de caja (el libro de plata). Gasto: verde hasta el 100 %, amarillo hasta 110 %,
        rojo más. Ingreso al revés. En gris, «sin datos reales»: un gasto presupuestado sin ningún
        real casi siempre es un gasto que falta cargar, no un ahorro.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editar
// ---------------------------------------------------------------------------

function EditTab(props: BudgetScreenProps) {
  const router = useRouter();
  const b = props.report.budget;
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const editable = Boolean(b && props.report.canEdit && b.status !== 'archivado');
  const labelOf = useMemo(
    () => new Map(props.categories.map((c) => [c.key, c.label])),
    [props.categories],
  );
  const byCategory = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const c of props.report.cells) {
      const arr = map.get(c.category) ?? Array<number>(12).fill(0);
      arr[c.month - 1] = c.amount;
      map.set(c.category, arr);
    }
    return map;
  }, [props.report.cells]);
  if (!b) return null;
  const columns: GridColumn[] = [
    {
      key: 'categoria',
      label: 'Categoría',
      type: 'text',
      pinned: true,
      primary: true,
      width: 220,
      required: true,
      editable: false,
    },
    {
      key: 'tipo',
      label: 'Tipo',
      type: 'select',
      width: 100,
      options: [
        { value: 'ingreso', label: 'Ingreso', tone: 'emerald' },
        { value: 'gasto', label: 'Gasto', tone: 'neutral' },
      ],
    },
    ...MONTHS_SHORT.map((label, i) => ({
      key: `m${i + 1}`,
      label: capital(label),
      type: 'money' as const,
      editable,
      width: 130,
    })),
    { key: 'total', label: 'Total del año', type: 'money', width: 150 },
  ];
  const rows: GridRow[] = [...byCategory.entries()].map(([category, months]) => {
    const values: Record<string, unknown> = {
      categoria: labelOf.get(category) ?? capital(category.replace(/_/g, ' ')),
      tipo: category === 'ventas' || category === 'otros_ingresos' ? 'ingreso' : 'gasto',
      total: months.reduce((s, v) => s + v, 0),
    };
    months.forEach((v, i) => {
      values[`m${i + 1}`] = v;
    });
    return { id: category, values };
  });
  const run = async (fn: () => Promise<{ ok: boolean; note?: string; error?: string }>) => {
    const r = await fn();
    setNote(
      r.ok
        ? { ok: true, text: r.note ?? 'Guardado.' }
        : { ok: false, text: r.error ?? 'No se pudo.' },
    );
    if (r.ok) router.refresh();
    if (!r.ok) throw new Error(r.error ?? 'No se pudo.');
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-muted">
        {editable
          ? 'Toca una celda para cambiarla; cero la borra. «Nueva categoría» agrega una fila (escribe el nombre: ventas, nómina, arriendo… o una propia).'
          : b.status === 'archivado'
            ? 'Este presupuesto está archivado: crea una versión nueva para cambiarlo.'
            : 'Sólo quien administra la empresa cambia el presupuesto.'}
      </p>
      <ActionNote note={note} />
      <DataGrid
        columns={columns}
        rows={rows}
        initialView={{ filters: [], sort: [], hidden: [], layout: 'table' }}
        onEdit={
          editable
            ? (rowId, key, value) =>
                run(() =>
                  props.actions.setCells(b.id, [
                    {
                      category: rowId,
                      month: Number(key.slice(1)),
                      amount: Math.max(Number(value) || 0, 0),
                    },
                  ]),
                )
            : undefined
        }
        onBulkEdit={
          editable
            ? (rowIds, key, value) =>
                run(() =>
                  props.actions.setCells(
                    b.id,
                    rowIds.map((id) => ({
                      category: id,
                      month: Number(key.slice(1)),
                      amount: Math.max(Number(value) || 0, 0),
                    })),
                  ),
                )
            : undefined
        }
        onCreate={
          editable
            ? async (values) => {
                const name = String(values.categoria ?? '').trim();
                if (!name) throw new Error('Escribe el nombre de la categoría.');
                const known = props.categories.find(
                  (c) => c.label.toLowerCase() === name.toLowerCase() || c.key === name,
                );
                const category = known?.key ?? name;
                const cells = Array.from({ length: 12 }, (_, i) => ({
                  category,
                  month: i + 1,
                  amount: Math.max(Number(values[`m${i + 1}`]) || 0, 0),
                })).filter((c) => c.amount > 0);
                await run(() =>
                  props.actions.setCells(
                    b.id,
                    cells.length ? cells : [{ category, month: 1, amount: 0 }],
                  ),
                );
                return { id: category, values: { ...values, categoria: known?.label ?? name } };
              }
            : undefined
        }
        onDelete={
          editable
            ? async (ids) => {
                for (const id of ids) await run(() => props.actions.removeCategory(b.id, id));
              }
            : undefined
        }
        exportName={`presupuesto-${props.year}`}
        noun={{ one: 'categoría', many: 'categorías', gender: 'f' }}
        emptyState={{
          title: 'El presupuesto está vacío',
          body: 'Agrega una categoría (por ejemplo «Ventas» o «Arriendo») y llena sus meses.',
        }}
        urlParam={false}
        height="auto"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pronóstico
// ---------------------------------------------------------------------------

function ForecastTab(props: BudgetScreenProps) {
  const f = props.forecast;
  if (!f)
    return (
      <Panel className="p-6 text-sm text-ink-muted">
        No pude armar el pronóstico{props.forecastError ? `: ${props.forecastError}` : '.'}
      </Panel>
    );
  const p = f.pnl;
  const s = props.scenario;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          [
            'Ventas esperadas',
            p.totals.sales + p.totals.otherIncome,
            p.baseTotals ? p.baseTotals.sales : null,
          ],
          ['Gastos esperados', p.totals.expenses, p.baseTotals ? p.baseTotals.expenses : null],
          ['Resultado esperado', p.totals.margin, p.baseTotals ? p.baseTotals.margin : null],
        ].map(([label, v, base]) => (
          <Panel key={label as string} className="px-4 py-3">
            <p className="field-label text-ink-faint">
              {label as string} · {p.months.length} meses
            </p>
            <p
              className={clsx(
                'tabular stat-num mt-1 font-mono text-xl font-bold',
                (v as number) < 0 ? 'text-rose' : 'text-ink',
              )}
            >
              {shortMoney(v as number)}
            </p>
            {base !== null && (
              <p className="mt-1 text-micro text-ink-muted">
                Sin el escenario: {shortMoney(base as number)}
              </p>
            )}
          </Panel>
        ))}
      </div>

      <Panel className="p-5 sm:p-6">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-extrabold text-ink">
            Mes a mes (
            {p.method === 'estacional'
              ? 'con estacionalidad'
              : p.method === 'ritmo'
                ? 'al ritmo reciente'
                : 'sin historia'}
            )
          </h2>
          <ul className="flex gap-4 text-micro text-ink-muted" aria-hidden>
            <li className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded bg-emerald" /> Entra
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded bg-ink-faint/55" /> Sale
            </li>
          </ul>
        </div>
        <BarChart
          barMode="grouped"
          labels={p.months.slice(0, 12).map((m) => shortMonthKey(m.month).split(' ')[0] ?? m.month)}
          titles={p.months.slice(0, 12).map((m) => shortMonthKey(m.month))}
          bars={[
            {
              id: 'in',
              label: 'Entra',
              color: CHART_COLOR.emerald,
              values: p.months.slice(0, 12).map((m) => m.sales + m.otherIncome + m.scenarioIn),
            },
            {
              id: 'out',
              label: 'Sale',
              color: 'rgb(var(--ink-faint) / 0.55)',
              values: p.months.slice(0, 12).map((m) => m.expenses + m.scenarioOut),
            },
          ]}
          formatAxis={(n) => formatCompact(n, { money: true })}
          formatValue={(n) => fullMoney(n)}
          height={230}
          legend={false}
          ariaLabel={`Pronóstico por mes: ${p.months
            .slice(0, 12)
            .map(
              (m) =>
                `${m.month} entra ${fullMoney(m.sales + m.otherIncome + m.scenarioIn)}, sale ${fullMoney(m.expenses + m.scenarioOut)}, resultado ${fullMoney(m.margin)}`,
            )
            .join('; ')}`}
        />
        <h3 className="mt-5 text-sm font-bold text-ink">Supuestos</h3>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-ink-muted">
          {p.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
          {f.payrollConfidential && <li>La nómina va como un solo total confidencial.</li>}
          {f.gaps.length > 0 && <li>No pude leer: {f.gaps.join(', ')}.</li>}
        </ul>
      </Panel>

      <Panel className="p-5 sm:p-6">
        <h2 className="text-lg font-extrabold text-ink">¿Y si…?</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Un escenario cambia el pronóstico de esta pantalla; no toca el presupuesto ni la caja.
        </p>
        <form
          method="get"
          action={props.links.self.split('?')[0]}
          className="mt-4 grid gap-3 sm:grid-cols-4"
        >
          {[...new URLSearchParams(props.links.self.split('?')[1] ?? '').entries()].map(
            ([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ),
          )}
          <input type="hidden" name="anio" value={props.year} />
          <input type="hidden" name="vista" value="pronostico" />
          <label className="text-xs font-semibold text-ink-muted">
            Ventas (%)
            <input
              name="esc_ventas"
              defaultValue={s.ventasPct ?? ''}
              placeholder="+10 o −15"
              className={clsx(fieldClass, 'mt-1')}
            />
          </label>
          <label className="text-xs font-semibold text-ink-muted">
            Una categoría de gasto
            <select
              name="esc_cat"
              defaultValue={s.category ?? ''}
              className={clsx(fieldClass, 'mt-1')}
            >
              <option value="">—</option>
              {props.categories
                .filter((c) => c.key !== 'ventas' && c.key !== 'otros_ingresos')
                .map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-ink-muted">
            Esa categoría (%)
            <input
              name="esc_cat_pct"
              defaultValue={s.categoryPct ?? ''}
              placeholder="+20"
              className={clsx(fieldClass, 'mt-1')}
            />
          </label>
          <label className="text-xs font-semibold text-ink-muted">
            Perder un cliente
            <select
              name="esc_sin"
              defaultValue={s.withoutClient ?? ''}
              className={clsx(fieldClass, 'mt-1')}
            >
              <option value="">—</option>
              {(f.clients?.clients ?? []).map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2 sm:col-span-4">
            <button type="submit" className={pillPrimary}>
              Ver el escenario
            </button>
            <Link
              href={withParam(props.links.self, { anio: String(props.year), vista: 'pronostico' })}
              className={pillLink}
            >
              Quitar el escenario
            </Link>
          </div>
        </form>
      </Panel>

      <div>
        <h2 className="mb-2 text-lg font-extrabold text-ink">El pronóstico en tabla</h2>
        <DataGrid
          columns={[
            { key: 'mes', label: 'Mes', type: 'text', pinned: true, primary: true, width: 120 },
            { key: 'ventas', label: 'Ventas', type: 'money', width: 150 },
            { key: 'otros', label: 'Otros ingresos y escenario', type: 'money', width: 190 },
            { key: 'gastos', label: 'Gastos', type: 'money', width: 150 },
            { key: 'resultado', label: 'Resultado', type: 'money', width: 150 },
          ]}
          rows={p.months.map((m) => ({
            id: m.month,
            locked: true,
            values: {
              mes: shortMonthKey(m.month),
              ventas: m.sales,
              otros: m.otherIncome + m.scenarioIn - m.scenarioOut,
              gastos: m.expenses,
              resultado: m.margin,
            },
          }))}
          initialView={{ filters: [], sort: [], hidden: [], layout: 'table' }}
          exportName="pronostico-12-meses"
          noun={{ one: 'mes', many: 'meses', gender: 'm' }}
          urlParam={false}
          height="auto"
        />
      </div>

      {f.clients && f.clients.clients.length > 0 && (
        <div>
          <h2 className="mb-1 text-lg font-extrabold text-ink">Quién sostiene las ventas</h2>
          <p className="mb-2 text-xs text-ink-muted">
            De las facturas de venta de 12 meses: recurrente = facturó en 4 o más de los últimos 6
            meses (se espera la mediana de sus meses); ocasional = su promedio anual.
          </p>
          <DataGrid
            columns={[
              {
                key: 'cliente',
                label: 'Cliente',
                type: 'text',
                pinned: true,
                primary: true,
                width: 240,
              },
              {
                key: 'tipo',
                label: 'Compra',
                type: 'select',
                width: 140,
                options: [
                  { value: 'recurrente', label: 'Casi todos los meses', tone: 'emerald' },
                  { value: 'ocasional', label: 'Ocasional', tone: 'neutral' },
                ],
              },
              { key: 'mes', label: 'Esperado al mes', type: 'money', width: 160 },
              { key: 'activos', label: 'Meses con factura (de 6)', type: 'number', width: 170 },
              { key: 'total', label: 'Facturado en 12 meses', type: 'money', width: 170 },
              { key: 'ultima', label: 'Última factura', type: 'date', width: 140 },
            ]}
            rows={f.clients.clients.map((c) => ({
              id: c.name,
              locked: true,
              values: {
                cliente: c.name,
                tipo: c.recurring ? 'recurrente' : 'ocasional',
                mes: c.monthly,
                activos: c.activeMonths,
                total: c.total12,
                ultima: c.lastInvoice,
              },
            }))}
            initialView={{
              filters: [],
              sort: [{ key: 'mes', dir: 'desc' }],
              hidden: [],
              layout: 'table',
              aggregates: { activos: 'none' },
            }}
            exportName="ventas-por-cliente"
            noun={{ one: 'cliente', many: 'clientes', gender: 'm' }}
            urlParam={false}
            height="auto"
          />
        </div>
      )}

      {f.demand && f.demand.length > 0 && (
        <div>
          <h2 className="mb-1 text-lg font-extrabold text-ink">Demanda por producto</h2>
          <p className="mb-2 text-xs text-ink-muted">
            De las salidas del inventario: lo que se espera que salga y cuánto alcanza lo que hay.
          </p>
          <DataGrid
            columns={[
              {
                key: 'producto',
                label: 'Producto',
                type: 'text',
                pinned: true,
                primary: true,
                width: 240,
              },
              { key: 'existencia', label: 'Hay', type: 'number', width: 100 },
              { key: 'proximo', label: 'Se espera el próximo mes', type: 'number', width: 190 },
              { key: 'trimestre', label: 'Próximos 3 meses', type: 'number', width: 160 },
              { key: 'cobertura', label: 'Alcanza (meses)', type: 'number', width: 140 },
              { key: 'agota', label: 'Se acabaría en', type: 'text', width: 140 },
            ]}
            rows={f.demand.map((d) => ({
              id: d.productId,
              locked: true,
              values: {
                producto: `${d.name} (${d.unit})`,
                existencia: d.onHand,
                proximo: d.next[0]?.qty ?? 0,
                trimestre: d.next.reduce((s2, n) => s2 + n.qty, 0),
                cobertura: d.monthsOfCover,
                agota: d.runsOutIn ? shortMonthKey(d.runsOutIn) : '—',
              },
            }))}
            initialView={{
              filters: [],
              sort: [],
              hidden: [],
              layout: 'table',
              aggregates: { cobertura: 'none', existencia: 'none' },
            }}
            exportName="demanda-por-producto"
            noun={{ one: 'producto', many: 'productos', gender: 'm' }}
            urlParam={false}
            height="auto"
          />
        </div>
      )}
    </div>
  );
}
