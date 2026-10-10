'use client';

import { BarChart } from '@/components/charts/BarChart';
import { CHART_COLOR } from '@/components/charts/colors';
import { formatCompact } from '@/components/charts/scales';
import DataGrid from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow } from '@/components/datagrid/types';
import { ActionNote, pillLink, pillPrimary, statusPill } from '@/components/finance/pieces';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import {
  MONTHS_SHORT,
  capital,
  change,
  fullMoney,
  monthName,
  pct,
  shortDay,
  shortMoney,
  shortMonthKey,
} from '@/lib/statements/format';
import type { BalanceSheet, Indicator } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  ArrowRight,
  BarChart3,
  CircleAlert,
  FileText,
  Info,
  Landmark,
  Loader2,
  RefreshCw,
  Scale,
  Target,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import type { StatementsScreenProps } from './types';

/**
 * /estados (0191): el estado de resultados de caja con el año anterior al
 * lado, el balance (del programa contable o aproximado, diciendo qué le
 * falta), los indicadores con su «de dónde sale» y cómo se clasifican los
 * gastos. Todo llega calculado del servidor (statements/store.ts); aquí sólo
 * se pinta. Lo mismo se pinta en /v/estados-showcase.
 */

const TABS = [
  { id: 'resultados', label: 'Estado de resultados', icon: BarChart3 },
  { id: 'balance', label: 'Balance general', icon: Scale },
  { id: 'indicadores', label: 'Indicadores', icon: Target },
  { id: 'clasificacion', label: 'Cómo se clasifican los gastos', icon: Landmark },
] as const;
type TabId = (typeof TABS)[number]['id'];

const PROFIT_LINES = new Set(['utilidad_bruta', 'utilidad_operacional', 'utilidad_neta']);

const GROUP_TITLE: Record<Indicator['group'], string> = {
  rentabilidad: 'Rentabilidad',
  liquidez: 'Liquidez y endeudamiento',
  eficiencia: 'Rotación y ciclo de caja',
  equilibrio: 'Punto de equilibrio',
};

const STATUS_TONE = { bien: 'emerald', atencion: 'amber', alerta: 'rose' } as const;
const STATUS_LABEL = { bien: 'Bien', atencion: 'Atención', alerta: 'Alerta' } as const;

export function StatementsScreen(props: StatementsScreenProps) {
  const { data, links } = props;
  const [tab, setTab] = useState<TabId>('resultados');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  // Un solo estado para «traer del programa»: cargando, falló (con motivo
  // humano) o ya se trajo. Lo pinta BasisNotice, no una nota aparte.
  const [refreshIssue, setRefreshIssue] = useState<string | null>(null);
  const y = data.year;
  const m = data.throughMonth;
  const inc = data.income;
  const nowYear = Number(data.today.slice(0, 4));
  const nowMonth = Number(data.today.slice(5, 7));

  const refresh = () =>
    start(async () => {
      setRefreshIssue(null);
      setNote(null);
      try {
        const r = await props.actions.refresh(y, m);
        if (r.ok) {
          setRefreshIssue(r.warning ?? null);
          setNote({ ok: true, text: r.note ?? 'Listo.' });
        } else setRefreshIssue(r.error);
      } catch {
        setRefreshIssue(
          'No pude traer los estados del programa contable. Vuelve a intentar en unos minutos.',
        );
      }
    });

  const h = data.headline;
  const kpis = [
    { label: `Ventas ${y}`, figure: h.sales },
    {
      label:
        h.basis === 'contable' ? 'Utilidad operacional' : 'Utilidad operacional (EBITDA aprox.)',
      figure: h.operating,
    },
    { label: h.basis === 'contable' ? 'Utilidad neta' : 'Utilidad neta (de caja)', figure: h.net },
  ];
  const sourceHint =
    h.basis === 'contable' ? `Según ${h.sourceLabel}` : 'Según el libro de plata, de caja';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Estados financieros"
        subtitle="Cómo le fue a la empresa: resultados contra el año anterior, el balance y los indicadores que pide un banco o un socio. Cada cifra dice de dónde sale."
        icon={<FileText className="h-5 w-5" />}
        actions={
          <>
            {data.accounting.connected && props.canEdit && (
              <button type="button" className={pillLink} onClick={refresh} disabled={pending}>
                {pending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                )}
                Traer de {props.providerLabel ?? 'el programa contable'}
              </button>
            )}
            <Link href={links.budget} className={pillLink}>
              Presupuesto <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
            <Link href={links.board} className={pillPrimary}>
              Informe para socios
            </Link>
          </>
        }
      />

      <PeriodPicker
        year={y}
        month={m}
        nowYear={nowYear}
        nowMonth={nowMonth}
        self={links.self}
        partial={inc.partialMonth}
      />
      <ActionNote note={note} />

      <section aria-label="Resumen del año" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => (
          <Kpi
            key={k.label}
            label={k.label}
            figure={k.figure}
            year={y}
            missing={h.missingExpenses && k.figure !== h.sales}
            prevNote={h.prevNote}
            links={links}
          />
        ))}
        <Panel className="px-4 py-3">
          <p className="field-label text-ink-faint">Margen neto</p>
          <p
            className={clsx(
              'tabular stat-num mt-1 font-mono text-xl font-bold',
              h.netMargin !== null && h.netMargin < 0 ? 'text-rose' : 'text-ink',
              h.netMargin === null && 'text-ink-faint',
            )}
          >
            {h.netMargin === null ? '—' : pct(h.netMargin)}
          </p>
          <p className="mt-1 text-micro text-ink-muted">
            {h.missingExpenses
              ? 'No se calcula: faltan los gastos'
              : `Utilidad neta ÷ ventas, enero a ${monthName(m)}`}
          </p>
        </Panel>
      </section>

      <p className="-mt-3 text-micro text-ink-faint">{sourceHint}.</p>

      <BasisNotice
        data={data}
        providerLabel={props.providerLabel}
        links={links}
        refresh={{
          pending,
          issue: refreshIssue,
          retry: props.canEdit ? refresh : null,
        }}
      />

      <div
        className="flex flex-wrap gap-1 border-b border-border"
        role="tablist"
        aria-label="Estados financieros"
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

      {tab === 'resultados' && <IncomeTab {...props} />}
      {tab === 'balance' && <BalanceTab data={data} providerLabel={props.providerLabel} />}
      {tab === 'indicadores' && <IndicatorsTab indicators={data.indicators} />}
      {tab === 'clasificacion' && <ClassesTab {...props} />}
    </div>
  );
}

function PeriodPicker(p: {
  year: number;
  month: number;
  nowYear: number;
  nowMonth: number;
  self: string;
  partial: boolean;
}) {
  const years = [p.nowYear - 2, p.nowYear - 1, p.nowYear];
  const last = p.year === p.nowYear ? p.nowMonth : 12;
  const href = (yy: number, mm: number) =>
    `${p.self}${p.self.includes('?') ? '&' : '?'}anio=${yy}&mes=${mm}`;
  return (
    <nav aria-label="Período" className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-ink-muted">Año</span>
      {years.map((yy) => (
        <Link
          key={yy}
          href={href(yy, yy === p.nowYear ? p.nowMonth : 12)}
          aria-current={yy === p.year ? 'page' : undefined}
          className={clsx(
            'rounded-pill px-3 py-1 text-xs font-semibold',
            yy === p.year ? 'bg-primary text-white' : 'bg-surface-2 text-ink-muted hover:text-ink',
          )}
        >
          {yy}
        </Link>
      ))}
      <span className="ml-2 text-xs font-semibold text-ink-muted">Hasta</span>
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: last }, (_, i) => i + 1).map((mm) => (
          <Link
            key={mm}
            href={href(p.year, mm)}
            aria-current={mm === p.month ? 'page' : undefined}
            className={clsx(
              'rounded-sm px-2 py-1 text-micro font-semibold uppercase',
              mm === p.month ? 'bg-primary-soft text-primary' : 'text-ink-muted hover:bg-surface-2',
            )}
          >
            {MONTHS_SHORT[mm - 1]}
          </Link>
        ))}
      </div>
      {p.partial && (
        <span className={statusPill('amber')}>{capital(monthName(p.month))} va en curso</span>
      )}
    </nav>
  );
}

function Kpi({
  label,
  figure,
  year,
  missing,
  prevNote,
  links,
}: {
  label: string;
  figure: { now: number | null; prev: number | null };
  year: number;
  /** Hay ventas y ningún gasto: la cifra no se puede afirmar. */
  missing: boolean;
  prevNote: string | null;
  links: StatementsScreenProps['links'];
}) {
  if (missing || figure.now === null)
    return (
      <Panel className="px-4 py-3">
        <p className="field-label text-ink-faint">{label}</p>
        <p className="tabular stat-num mt-1 font-mono text-xl font-bold text-ink-faint">—</p>
        <p className="mt-1 text-micro text-ink-muted">
          Faltan los gastos: sin ellos no se puede afirmar utilidad.{' '}
          <Link href={links.finance} className="font-semibold underline underline-offset-2">
            Traer gastos
          </Link>
        </p>
      </Panel>
    );
  const c = change(figure.now, figure.prev);
  return (
    <Panel className="px-4 py-3">
      <p className="field-label text-ink-faint">{label}</p>
      <p
        className={clsx(
          'tabular stat-num mt-1 font-mono text-xl font-bold',
          figure.now < 0 ? 'text-rose' : 'text-ink',
        )}
      >
        {shortMoney(figure.now)}
      </p>
      <p className="mt-1 text-micro text-ink-muted">
        {figure.prev === null ? (
          (prevNote ?? `Sin datos de ${year - 1} para comparar`)
        ) : (
          <>
            {shortMoney(figure.prev)} en {year - 1}
            {c !== null && (
              <span
                className={clsx('ml-1.5 font-semibold', c >= 0 ? 'text-emerald' : 'text-amber')}
              >
                {pct(c, true)}
              </span>
            )}
            {prevNote && <span className="block text-ink-faint">{prevNote}</span>}
          </>
        )}
      </p>
    </Panel>
  );
}

function BasisNotice({
  data,
  providerLabel,
  links,
  refresh,
}: {
  data: StatementsScreenProps['data'];
  providerLabel: string | null;
  links: StatementsScreenProps['links'];
  refresh: { pending: boolean; issue: string | null; retry: (() => void) | null };
}) {
  const items: Array<{ tone: 'neutral' | 'amber'; text: React.ReactNode }> = [
    {
      tone: 'neutral',
      text:
        data.headline.basis === 'contable'
          ? `Resultados contables de ${providerLabel ?? 'el programa contable'} (con causación). Abajo, el detalle de caja del libro de plata.`
          : 'Resultados de caja: lo que entró y salió del banco según el libro de plata, sin causación ni depreciaciones.',
    },
  ];
  if (data.headline.missingExpenses)
    items.push({
      tone: 'amber',
      text: (
        <>
          Hay ventas pero ningún gasto registrado, por eso no se muestra utilidad ni margen. Trae
          los gastos: sube los extractos del banco en{' '}
          <Link href={links.finance} className="font-semibold underline underline-offset-2">
            Finanzas
          </Link>
          ,{' '}
          {data.accounting.connected
            ? `actualiza ${providerLabel ?? 'el programa contable'}`
            : 'conecta Siigo, Alegra o QuickBooks'}{' '}
          o carga las facturas de compra.
        </>
      ),
    });
  else if (data.income.monthsWithoutExpenses.length && data.headline.basis === 'caja')
    items.push({
      tone: 'amber',
      text: `Sin gastos registrados en ${data.income.monthsWithoutExpenses.map((k) => shortMonthKey(k)).join(', ')}: la utilidad del año puede verse mejor de lo que es.`,
    });
  if (refresh.pending)
    items.push({
      tone: 'neutral',
      text: `Trayendo los estados de ${providerLabel ?? 'el programa contable'}…`,
    });
  else if (refresh.issue)
    items.push({
      tone: 'amber',
      text: (
        <>
          {refresh.issue}
          {refresh.retry && (
            <>
              {' '}
              <button
                type="button"
                onClick={refresh.retry}
                className="font-semibold underline underline-offset-2"
              >
                Reintentar
              </button>
            </>
          )}
        </>
      ),
    });
  if (data.balance.basis === 'aproximado' && !refresh.pending && !refresh.issue)
    items.push({
      tone: 'amber',
      text: data.accounting.connected ? (
        <>
          Balance aproximado: todavía no traje el balance de {providerLabel}.{' '}
          {refresh.retry ? `Usa «Traer de ${providerLabel}».` : 'Quien administra puede traerlo.'}
        </>
      ) : (
        <>
          Balance aproximado: sin programa contable conectado, el balance sale de lo que Cortex
          sabe.{' '}
          <Link href={links.integrations} className="font-semibold underline underline-offset-2">
            Conectar Siigo, Alegra o QuickBooks
          </Link>
        </>
      ),
    });
  else if (data.balance.basis === 'contable')
    items.push({
      tone: 'neutral',
      text: `Balance contable de ${providerLabel ?? 'el programa contable'} al ${shortDay(data.balance.asOf)}${data.balance.fetchedAt ? `, leído el ${shortDay(data.balance.fetchedAt)}` : ''}.`,
    });
  if (data.income.payrollConfidential)
    items.push({
      tone: 'neutral',
      text: 'La nómina va como un solo total: el detalle lo ve quien administra.',
    });
  if (data.gaps.length)
    items.push({ tone: 'amber', text: `No pude leer: ${data.gaps.join(', ')}.` });
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: lista fija
          key={i}
          className={clsx(
            'flex items-start gap-2 rounded-sm px-3 py-2 text-xs',
            it.tone === 'amber' ? 'bg-amber-soft text-ink' : 'bg-surface-2 text-ink-muted',
          )}
        >
          {it.tone === 'amber' ? (
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" aria-hidden />
          ) : (
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
          )}
          <span>{it.text}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Estado de resultados
// ---------------------------------------------------------------------------

function IncomeTab(props: StatementsScreenProps) {
  const { data, lines } = props;
  const inc = data.income;
  const months = inc.months;
  const columns: GridColumn[] = useMemo(
    () => [
      { key: 'renglon', label: 'Renglón', type: 'text', pinned: true, primary: true, width: 280 },
      ...months.map((mo) => ({
        key: mo.month,
        label: capital(MONTHS_SHORT[Number(mo.month.slice(5, 7)) - 1] ?? ''),
        type: 'money' as const,
        width: 130,
      })),
      { key: 'ytd', label: `Acumulado ${data.year}`, type: 'money', width: 150 },
      { key: 'prev', label: `Mismo tramo ${data.year - 1}`, type: 'money', width: 150 },
      { key: 'cambio', label: 'Cambio', type: 'percent', width: 100 },
    ],
    [months, data.year],
  );
  const rows: GridRow[] = lines.map((l) => {
    const values: Record<string, unknown> = { renglon: l.subtotal ? `= ${l.label}` : l.label };
    // Las utilidades de un período con ventas y sin gastos no se afirman.
    const isProfit = PROFIT_LINES.has(l.key);
    for (const mo of months)
      values[mo.month] = isProfit && mo.expensesMissing ? null : mo.values[l.key];
    const hideYtd = isProfit && inc.expensesMissingYtd;
    values.ytd = hideYtd ? null : inc.ytd[l.key];
    values.prev = inc.ytdPrev ? inc.ytdPrev[l.key] : null;
    const c = hideYtd ? null : change(inc.ytd[l.key], inc.ytdPrev?.[l.key]);
    values.cambio = c === null ? null : Math.round(c * 1000) / 10;
    return { id: l.key, values, locked: true };
  });
  const sourceOf = new Map(lines.map((l) => [l.key, l]));
  const catRows: GridRow[] = inc.categories.map((c) => {
    const ch = change(c.ytd, c.ytdPrev);
    return {
      id: c.category,
      locked: true,
      values: {
        categoria: c.label,
        clase: props.classLabels[c.cls] ?? c.cls,
        ytd: c.ytd,
        prev: c.ytdPrev,
        cambio: ch === null ? null : Math.round(ch * 1000) / 10,
        peso: inc.ytd.ingresos > 0.5 ? Math.round((c.ytd / inc.ytd.ingresos) * 1000) / 10 : null,
      },
    };
  });
  // Una utilidad sin gastos registrados no se dibuja: sería la barra de ventas otra vez.
  const netOf = (mo: (typeof months)[number]) => (mo.expensesMissing ? 0 : mo.values.utilidad_neta);
  const monthsWithData = months.filter((mo) => mo.hasData).length;

  return (
    <div className="space-y-6">
      <Panel className="p-5 sm:p-6">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-extrabold text-ink">Mes a mes en {data.year}</h2>
          <ul className="flex gap-4 text-micro text-ink-muted" aria-hidden>
            <li className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded bg-emerald" /> Ventas
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded bg-primary" /> Utilidad neta
            </li>
          </ul>
        </div>
        <BarChart
          barMode="grouped"
          labels={months.map((mo) => MONTHS_SHORT[Number(mo.month.slice(5, 7)) - 1] ?? mo.month)}
          titles={months.map((mo) => mo.month)}
          bars={[
            {
              id: 'sales',
              label: 'Ventas',
              color: CHART_COLOR.emerald,
              values: months.map((mo) => Math.max(mo.values.ingresos, 0)),
              display: months.map((mo) => fullMoney(mo.values.ingresos)),
            },
            {
              id: 'net',
              label: 'Utilidad neta',
              color: CHART_COLOR.primary,
              negativeColor: CHART_COLOR.rose,
              values: months.map((mo) => netOf(mo)),
              display: months.map((mo) =>
                mo.expensesMissing ? 'sin calcular (faltan los gastos)' : fullMoney(netOf(mo)),
              ),
            },
          ]}
          formatAxis={(n) => formatCompact(n, { money: true })}
          formatValue={(n) => fullMoney(n)}
          height={220}
          legend={false}
          emptyNote="Todavía no hay movimientos"
          ariaLabel={`Ventas y utilidad neta por mes en ${data.year}: ${months.map((mo) => `${mo.month} ventas ${fullMoney(mo.values.ingresos)}, ${mo.expensesMissing ? 'utilidad sin calcular' : `utilidad ${fullMoney(netOf(mo))}`}`).join('; ')}`}
        />
        {monthsWithData === 0 ? (
          <p className="mt-3 text-xs text-ink-muted">
            Todavía no hay movimientos en {data.year}: cuando el libro tenga ventas y gastos, salen
            aquí mes a mes.
          </p>
        ) : monthsWithData === 1 ? (
          <p className="mt-3 text-xs text-ink-muted">
            Sólo hay datos de un mes: no alcanza para ver una tendencia.
          </p>
        ) : null}
        {inc.monthsWithoutExpenses.length > 0 && (
          <p className="mt-2 text-xs text-ink-muted">
            Sin barra de utilidad en{' '}
            {inc.monthsWithoutExpenses.map((k) => shortMonthKey(k)).join(', ')}: hay ventas pero
            ningún gasto registrado.
          </p>
        )}
        {props.data.accounting.pnl && (
          <AccountingPnl data={props.data} providerLabel={props.providerLabel} />
        )}
      </Panel>

      <div>
        <h2 className="mb-2 text-lg font-extrabold text-ink">Estado de resultados</h2>
        <p className="mb-3 text-xs text-ink-muted">
          Abre un renglón para ver de dónde sale. El cambio compara enero a{' '}
          {monthName(data.throughMonth)} contra los mismos meses de {data.year - 1}.
        </p>
        <DataGrid
          columns={columns}
          rows={rows}
          initialView={{
            filters: [],
            sort: [],
            hidden: [],
            layout: 'table',
            // Sumar renglones con subtotales no da ninguna cifra.
            aggregates: Object.fromEntries(columns.map((c) => [c.key, 'none' as const])),
          }}
          renderRowDetail={(row) => {
            const l = sourceOf.get(row.id as never);
            return l ? (
              <div className="space-y-3 p-1 text-sm">
                <h3 className="font-bold text-ink">{l.label}</h3>
                <p className="text-ink-muted">{l.source}</p>
                <p className="tabular font-mono text-ink">
                  Acumulado {data.year}: {fullMoney(data.income.ytd[l.key])}
                  {data.income.ytdPrev
                    ? ` · ${data.year - 1}: ${fullMoney(data.income.ytdPrev[l.key])}`
                    : ''}
                </p>
              </div>
            ) : null;
          }}
          exportName={`estado-de-resultados-${data.year}`}
          noun={{ one: 'renglón', many: 'renglones', gender: 'm' }}
          urlParam={false}
          height="auto"
        />
      </div>

      <div>
        <h2 className="mb-2 text-lg font-extrabold text-ink">Gastos por categoría</h2>
        <DataGrid
          columns={[
            {
              key: 'categoria',
              label: 'Categoría',
              type: 'text',
              pinned: true,
              primary: true,
              width: 240,
            },
            { key: 'clase', label: 'Cuenta como', type: 'text', width: 160 },
            { key: 'ytd', label: `Acumulado ${data.year}`, type: 'money', width: 150 },
            { key: 'prev', label: `Mismo tramo ${data.year - 1}`, type: 'money', width: 150 },
            { key: 'cambio', label: 'Cambio', type: 'percent', width: 100 },
            { key: 'peso', label: '% de las ventas', type: 'percent', width: 120 },
          ]}
          rows={catRows}
          initialView={{
            filters: [],
            sort: [{ key: 'ytd', dir: 'desc' }],
            hidden: [],
            layout: 'table',
            aggregates: { cambio: 'none', peso: 'none' },
          }}
          exportName={`gastos-por-categoria-${data.year}`}
          noun={{ one: 'categoría', many: 'categorías', gender: 'f' }}
          emptyState={{
            title: 'Sin gastos en el período',
            body: 'Cuando el libro tenga gastos con categoría, salen aquí.',
          }}
          urlParam={false}
          height="auto"
        />
      </div>
    </div>
  );
}

function AccountingPnl({
  data,
  providerLabel,
}: { data: StatementsScreenProps['data']; providerLabel: string | null }) {
  const p = data.accounting.pnl?.report;
  const prev = data.accounting.pnlPrev?.report;
  if (!p) return null;
  const rows: Array<[string, number, number | undefined]> = [
    ['Ingresos operacionales', p.revenue, prev?.revenue],
    ['Costo de ventas', p.costOfSales, prev?.costOfSales],
    ['Gastos operacionales', p.operatingExpenses, prev?.operatingExpenses],
    ['Otros ingresos', p.otherIncome, prev?.otherIncome],
    [
      'Otros gastos',
      p.otherExpenses + (p.incomeTax ?? 0),
      prev ? prev.otherExpenses + (prev.incomeTax ?? 0) : undefined,
    ],
    ['Utilidad neta', p.netIncome, prev?.netIncome],
  ];
  return (
    <div className="mt-6 rounded-sm border border-border bg-surface-2/60 p-4">
      <h3 className="text-sm font-bold text-ink">
        Según {providerLabel ?? 'el programa contable'} (contable, {shortDay(p.from)} a{' '}
        {shortDay(p.to)})
      </h3>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        {rows.map(([label, v, pv]) => (
          <div key={label} className="flex justify-between gap-2 border-b border-border/60 py-1">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="tabular font-mono text-ink">
              {fullMoney(v)}
              {pv !== undefined && <span className="ml-2 text-ink-faint">({fullMoney(pv)})</span>}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-micro text-ink-faint">
        Con causación: puede diferir de las cifras de caja de arriba. Entre paréntesis, el mismo
        tramo del año anterior.
        {p.revenue > 0.5 && !data.headline.missingExpenses
          ? ` Margen neto contable ${pct(p.netIncome / p.revenue)}.`
          : ''}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

const SECTION_TITLE: Record<string, string> = {
  activo_corriente: 'Activo corriente',
  activo_no_corriente: 'Activo no corriente',
  activo: 'Activo',
  pasivo_corriente: 'Pasivo corriente',
  pasivo_no_corriente: 'Pasivo no corriente',
  pasivo: 'Pasivo',
  patrimonio: 'Patrimonio',
};

function BalanceTab({
  data,
  providerLabel,
}: { data: StatementsScreenProps['data']; providerLabel: string | null }) {
  const b: BalanceSheet = data.balance;
  const side = (sections: string[]) =>
    sections
      .map((s) => ({ s, lines: b.lines.filter((l) => l.section === s) }))
      .filter((g) => g.lines.length > 0);
  const left = side(['activo_corriente', 'activo_no_corriente', 'activo']);
  const right = side(['pasivo_corriente', 'pasivo_no_corriente', 'pasivo', 'patrimonio']);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className={statusPill(b.basis === 'contable' ? 'emerald' : 'amber')}>
          {b.basis === 'contable' ? `Contable · ${providerLabel ?? ''}` : 'Aproximado'}
        </span>
        <span className="text-xs text-ink-muted">Al {shortDay(b.asOf)}</span>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <BalanceSide title="Activos" total={b.totalAssets} groups={left} />
        <BalanceSide
          title="Pasivos y patrimonio"
          total={b.totalLiabilities + b.equity}
          groups={right}
          extra={`Pasivos ${fullMoney(b.totalLiabilities)} · Patrimonio ${fullMoney(b.equity)}`}
        />
      </div>
      {(b.missing.length > 0 || b.notes.length > 0) && (
        <Panel className="p-5">
          {b.missing.length > 0 && (
            <>
              <h3 className="text-sm font-bold text-ink">Lo que este balance no incluye</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-muted">
                {b.missing.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-ink-muted">
                Por eso el patrimonio es una diferencia, no el patrimonio contable. Con el programa
                contable conectado sale el balance completo.
              </p>
            </>
          )}
          {b.notes.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-ink-muted">
              {b.notes.map((n) => (
                <li key={n}>· {n}</li>
              ))}
            </ul>
          )}
        </Panel>
      )}
      {b.basis === 'contable' && (
        <p className="text-xs text-ink-muted">
          Para comparar, lo que Cortex sabe por su cuenta: activos corrientes{' '}
          {fullMoney(data.approxBalance.totalAssets)}, cuentas por pagar{' '}
          {fullMoney(data.approxBalance.totalLiabilities)}.
        </p>
      )}
    </div>
  );
}

function BalanceSide({
  title,
  total,
  groups,
  extra,
}: {
  title: string;
  total: number;
  groups: Array<{ s: string; lines: BalanceSheet['lines'] }>;
  extra?: string;
}) {
  return (
    <Panel className="p-5 sm:p-6">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-extrabold text-ink">{title}</h2>
        <p className="tabular font-mono text-lg font-bold text-ink">{fullMoney(total)}</p>
      </div>
      {extra && <p className="-mt-2 mb-3 text-micro text-ink-muted">{extra}</p>}
      {groups.length === 0 && <p className="text-sm text-ink-muted">Sin partidas.</p>}
      {groups.map((g) => (
        <div key={g.s} className="mb-4">
          <h3 className="mb-1 text-micro font-bold uppercase tracking-wide text-ink-faint">
            {SECTION_TITLE[g.s] ?? g.s}
          </h3>
          <ul className="divide-y divide-border/70">
            {g.lines.map((l) => (
              <li key={l.key} className="py-1.5">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 text-sm [&::-webkit-details-marker]:hidden">
                    <span className="text-ink">{l.label}</span>
                    <span
                      className={clsx('tabular font-mono', l.amount < 0 ? 'text-rose' : 'text-ink')}
                    >
                      {fullMoney(l.amount)}
                    </span>
                  </summary>
                  <p className="mt-1 text-micro text-ink-muted">{l.source}</p>
                </details>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Indicadores
// ---------------------------------------------------------------------------

function IndicatorsTab({ indicators }: { indicators: Indicator[] }) {
  const groups = (['rentabilidad', 'liquidez', 'eficiencia', 'equilibrio'] as const).map((g) => ({
    g,
    items: indicators.filter((i) => i.group === g),
  }));
  return (
    <div className="space-y-6">
      <p className="text-xs text-ink-muted">
        Calculados con los últimos 12 meses de caja y el balance de la pestaña anterior. Abre cada
        uno para ver la fórmula y las cifras que entraron.
      </p>
      {groups.map(({ g, items }) => (
        <section key={g} aria-labelledby={`ind-${g}`}>
          <h2 id={`ind-${g}`} className="mb-3 text-lg font-extrabold text-ink">
            {GROUP_TITLE[g]}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((i) => (
              <IndicatorCard key={i.key} i={i} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function IndicatorCard({ i }: { i: Indicator }) {
  return (
    <Panel className="flex flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{i.label}</p>
        {i.status && (
          <span className={statusPill(STATUS_TONE[i.status])}>{STATUS_LABEL[i.status]}</span>
        )}
      </div>
      <p
        className={clsx(
          'tabular stat-num mt-2 font-mono text-2xl font-bold',
          i.value === null ? 'text-ink-faint' : 'text-ink',
        )}
      >
        {i.display}
      </p>
      {i.note && <p className="mt-1 text-micro text-ink-muted">{i.note}</p>}
      <details className="group mt-3 border-t border-border pt-2">
        <summary className="cursor-pointer list-none text-micro font-semibold text-primary [&::-webkit-details-marker]:hidden">
          De dónde sale
        </summary>
        <p className="mt-2 text-micro text-ink-muted">{i.formula}</p>
        {i.inputs.length > 0 && (
          <dl className="mt-2 space-y-1 text-micro">
            {i.inputs.map((x) => (
              <div key={x.label} className="flex justify-between gap-2">
                <dt className="text-ink-muted" title={x.source}>
                  {x.label}
                </dt>
                <dd className="tabular font-mono text-ink">{x.display}</dd>
              </div>
            ))}
          </dl>
        )}
      </details>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Clasificación de gastos
// ---------------------------------------------------------------------------

function ClassesTab(props: StatementsScreenProps) {
  const { data } = props;
  const categories = useMemo(() => {
    const seen = new Set<string>([
      ...Object.keys(data.classes),
      ...data.income.categories.map((c) =>
        c.category === 'nomina (confidencial)' ? 'nomina' : c.category,
      ),
    ]);
    seen.delete('ventas');
    seen.delete('otros_ingresos');
    return [...seen].sort();
  }, [data]);
  const labelOf = new Map(data.income.categories.map((c) => [c.category, c.label]));
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...data.classes }));
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = categories.some((c) => draft[c] !== data.classes[c]);
  return (
    <Panel className="p-5 sm:p-6">
      <h2 className="text-lg font-extrabold text-ink">Cómo cuenta cada categoría de gasto</h2>
      <p className="mt-1 max-w-3xl text-xs text-ink-muted">
        El costo de ventas resta en la utilidad bruta; lo variable sube y baja con las ventas; lo
        fijo se paga se venda o no (es lo que el punto de equilibrio tiene que cubrir); financieros
        e impuestos van debajo de la utilidad operacional.
      </p>
      <ul className="mt-4 divide-y divide-border">
        {categories.map((c) => (
          <li key={c} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <span className="text-sm text-ink">
              {labelOf.get(c) ?? capital(c.replace(/_/g, ' '))}
              {data.customClasses[c] && (
                <span className={clsx(statusPill('primary'), 'ml-2')}>cambiada</span>
              )}
            </span>
            <select
              aria-label={`Clase de ${c}`}
              disabled={!props.canEdit || pending}
              value={draft[c] ?? 'fijo'}
              onChange={(e) => setDraft((d) => ({ ...d, [c]: e.target.value }))}
              className="min-h-9 rounded-sm border border-border-strong bg-surface px-2 text-sm text-ink"
            >
              {props.classKeys.map((k) => (
                <option key={k} value={k}>
                  {props.classLabels[k]}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {props.canEdit ? (
          <button
            type="button"
            className={pillPrimary}
            disabled={!dirty || pending}
            onClick={() =>
              start(async () => {
                const r = await props.actions.saveClasses(draft);
                setNote(
                  r.ok ? { ok: true, text: r.note ?? 'Guardado.' } : { ok: false, text: r.error },
                );
              })
            }
          >
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Guardar clasificación
          </button>
        ) : (
          <p className="text-xs text-ink-muted">
            Sólo quien administra la empresa cambia la clasificación.
          </p>
        )}
        <ActionNote note={note} />
      </div>
    </Panel>
  );
}
