'use client';

import { BarChart } from '@/components/charts/BarChart';
import { CHART_COLOR } from '@/components/charts/colors';
import { formatCompact } from '@/components/charts/scales';
import DataGrid from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import type {
  ActionResult,
  AnalyticsView,
  CrmTab,
  CrmTile,
  ForecastView,
  MarginRowView,
  NpsSummaryView,
  OppOption,
  RateRowView,
  RiskView,
  StaleView,
  SurveyView,
  TaskView,
  TimelineEntryView,
} from '@/lib/crm/shape';
import { BOARD_VIEW, CRM_TABS } from '@/lib/crm/shape';
import { CHIP_INTERACTIVE, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  CalendarClock,
  Check,
  Clock3,
  Copy,
  Handshake,
  LoaderCircle,
  Mail,
  MessageSquareHeart,
  PhoneCall,
  Plus,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import {
  Drawer,
  Empty,
  FIELD,
  Feedback,
  Meter,
  SectionTitle,
  TONE_BAR,
  TONE_TEXT,
  Tiles,
} from './parts';

/**
 * /comercial: el embudo (tablero por etapa), la tabla de oportunidades, las
 * tareas de hoy, los clientes en riesgo, el análisis y las encuestas
 * (migración 0193). Todo llega armado del servidor (lib/crm/views.ts); las
 * acciones llegan como funciones para que el escaparate de desarrollo pinte
 * la misma pantalla sin sesión.
 */

export interface CrmHandlers {
  onEdit?: (rowId: string, key: string, value: unknown) => Promise<void>;
  onBulkEdit?: (rowIds: string[], key: string, value: unknown) => Promise<void>;
  onCreate?: (values: Record<string, unknown>) => Promise<GridRow>;
  timeline: (
    id: string,
  ) => Promise<{ items: TimelineEntryView[]; missing: string[]; error?: string }>;
  logActivity: (input: {
    opportunityId?: string | null;
    clientId?: string | null;
    kind: 'call' | 'meeting' | 'email' | 'note' | 'task';
    title: string;
    body?: string | null;
    dueOn?: string | null;
    ownerUserId?: string | null;
  }) => Promise<ActionResult>;
  completeTask: (id: string, done: boolean) => Promise<ActionResult>;
  sendSurvey: (input: {
    client: string;
    email?: string | null;
    linkOnly: boolean;
  }) => Promise<ActionResult>;
}

export interface CrmScreenProps {
  tab: CrmTab;
  userId: string;
  openId: string | null;
  tiles: CrmTile[];
  columns: GridColumn[];
  boardRows: GridRow[];
  rows: GridRow[];
  presets: Array<{ id: string; label: string; view: Partial<GridView> }>;
  forecast: ForecastView;
  stale: StaleView[];
  tasks: TaskView[];
  team: Array<{ id: string; name: string }>;
  opportunities: OppOption[];
  risk: RiskView[];
  analytics: AnalyticsView | null;
  surveys: SurveyView[];
  nps: NpsSummaryView;
  missing: string[];
  counts: Partial<Record<CrmTab, number>>;
  handlers: CrmHandlers;
  /** Para el escaparate: enlaces de pestaña que no navegan. */
  tabHref?: (tab: CrmTab) => string;
}

export function CrmScreen(props: CrmScreenProps) {
  const [openId, setOpenId] = useState<string | null>(props.openId);
  const href =
    props.tabHref ?? ((t: CrmTab) => (t === 'embudo' ? '/comercial' : `/comercial?tab=${t}`));
  const openRow = props.rows.find((r) => r.id === openId) ?? null;
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Embudo comercial"
        subtitle="Los negocios que vienen, en qué etapa va cada uno y cuánto se espera vender por mes; lo que hay que mover hoy; los clientes que se están yendo y lo que opinan."
        icon={<Handshake className="h-5 w-5" aria-hidden />}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href={href('encuestas')}
              className="inline-flex min-h-10 items-center gap-2 rounded-pill border border-border-strong bg-surface px-4 text-sm font-semibold text-ink transition-colors duration-150 hover:bg-surface-2 motion-reduce:transition-none"
            >
              <MessageSquareHeart className="h-4 w-4" aria-hidden />
              Encuesta
            </Link>
            <Link
              href={href('oportunidades')}
              className="cortex-primary-button inline-flex min-h-10 items-center justify-center gap-2 rounded-pill bg-primary px-5 py-2 text-sm font-bold text-white transition-colors duration-150 hover:bg-primary-strong motion-reduce:transition-none"
            >
              <Plus className="h-4 w-4" aria-hidden />
              Oportunidad
            </Link>
          </div>
        }
      />

      <Tiles tiles={props.tiles} />

      <nav
        className="mb-5 mt-7 flex gap-1 overflow-x-auto border-b border-border"
        aria-label="Secciones del embudo comercial"
      >
        {CRM_TABS.map((t) => (
          <Link
            key={t.id}
            href={href(t.id)}
            aria-current={props.tab === t.id ? 'page' : undefined}
            className={clsx(
              '-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold transition-colors duration-150 motion-reduce:transition-none',
              props.tab === t.id
                ? 'border-primary text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
            {(props.counts[t.id] ?? 0) > 0 && (
              <span
                className={chipClass(
                  t.id === 'riesgo' ? 'rose' : t.id === 'actividades' ? 'amber' : 'neutral',
                )}
              >
                {props.counts[t.id]}
              </span>
            )}
          </Link>
        ))}
      </nav>

      {props.missing.length > 0 && (
        <p className="mb-4 flex items-start gap-2 rounded-sm bg-amber-soft px-3 py-2 text-xs leading-relaxed text-amber">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          No pude leer {props.missing.join(', ')}. Lo demás está al día.
        </p>
      )}

      {props.tab === 'embudo' && <PipelineTab {...props} onOpen={setOpenId} />}
      {props.tab === 'oportunidades' && <OpportunitiesTab {...props} />}
      {props.tab === 'actividades' && <ActivitiesTab {...props} onOpen={setOpenId} />}
      {props.tab === 'riesgo' && <RiskTab {...props} />}
      {props.tab === 'analisis' && <AnalyticsTab view={props.analytics} />}
      {props.tab === 'encuestas' && <SurveysTab {...props} />}

      {openRow && (
        <Drawer
          title={String(openRow.values.titulo ?? 'Negocio')}
          subtitle={`${String(openRow.values.cliente ?? '')} · ${stageLabel(props.columns, openRow)}`}
          onClose={() => setOpenId(null)}
        >
          <OpportunityPanel row={openRow} handlers={props.handlers} />
        </Drawer>
      )}
    </div>
  );
}

function stageLabel(columns: GridColumn[], row: GridRow): string {
  const col = columns.find((c) => c.key === 'etapa');
  return col?.options?.find((o) => o.value === row.values.etapa)?.label ?? String(row.values.etapa);
}

// ---------------------------------------------------------------------------
// Embudo: pronóstico, lo que hay que mover y el tablero
// ---------------------------------------------------------------------------

function PipelineTab(props: CrmScreenProps & { onOpen: (id: string) => void }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <ForecastCard forecast={props.forecast} />
        <StaleCard stale={props.stale} onOpen={props.onOpen} handlers={props.handlers} />
      </div>
      {props.boardRows.length === 0 ? (
        <Empty
          title="El embudo está vacío"
          body="Crea el primer negocio en Oportunidades o pídeselo a Cortex en el chat («abre un negocio con Nexa por 40 millones»). Cuando le mandes una cotización desde Ventas, la tarjeta se mueve sola."
        />
      ) : (
        <DataGrid
          columns={props.columns}
          rows={props.boardRows}
          initialView={BOARD_VIEW}
          onEdit={props.handlers.onEdit}
          onCreate={props.handlers.onCreate}
          exportName="embudo"
          noun={{ one: 'negocio', many: 'negocios', gender: 'm' }}
          askCortexContext="mi embudo comercial: negocios por etapa, valor, probabilidad y cierre"
          urlParam={false}
          people={props.team.map((t) => t.name)}
          height="calc(100vh - 220px)"
          renderRowExtra={(row) => <OpportunityPanel row={row} handlers={props.handlers} compact />}
        />
      )}
    </div>
  );
}

function ForecastCard({ forecast }: { forecast: ForecastView }) {
  return (
    <Panel className="overflow-hidden">
      <SectionTitle
        icon={<TrendingUp className="h-4 w-4 text-ink-faint" aria-hidden />}
        title="Pronóstico ponderado"
        note={`Valor × probabilidad, por mes de cierre esperado. Abierto: ${forecast.pipelineTotalLabel}; ponderado: ${forecast.pipelineWeightedLabel}.`}
      />
      <div className="px-5 pb-3">
        <BarChart
          labels={forecast.bars.map((b) => b.label)}
          bars={[
            {
              id: 'weighted',
              label: 'Ponderado',
              color: CHART_COLOR.primary,
              values: forecast.bars.map((b) => b.weighted),
              display: forecast.bars.map((b) => b.weightedLabel),
            },
          ]}
          formatAxis={(n) => formatCompact(n, { money: true })}
          formatValue={(n) => formatCompact(n, { money: true })}
          tooltipExtra={(i) => {
            const b = forecast.bars[i];
            return b ? (
              <span className="block">
                {b.weightedLabel} ponderado de {b.totalLabel} ({b.count} negocio
                {b.count === 1 ? '' : 's'})
              </span>
            ) : null;
          }}
          height={200}
          legend={false}
          emptyNote="Sin negocios con cierre esperado"
          ariaLabel={`Pronóstico ponderado por mes: ${forecast.bars.map((b) => `${b.label} ${b.weightedLabel} ponderado de ${b.totalLabel}`).join('; ')}`}
        />
      </div>
      {forecast.notes.length > 0 && (
        <ul className="space-y-1 border-t border-border bg-surface-2/40 px-5 py-3 text-xs leading-relaxed text-ink-muted">
          {forecast.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function StaleCard({
  stale,
  onOpen,
  handlers,
}: {
  stale: StaleView[];
  onOpen: (id: string) => void;
  handlers: CrmHandlers;
}) {
  const router = useRouter();
  const [done, setDone] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const list = stale.filter((s) => !done.has(s.id));
  function task(s: StaleView) {
    start(async () => {
      const r = await handlers.logActivity({
        opportunityId: s.id,
        kind: 'task',
        title: s.suggestion,
      });
      setResult(r);
      if (r.ok) {
        setDone((prev) => new Set(prev).add(s.id));
        router.refresh();
      }
    });
  }
  return (
    <Panel className="flex flex-col overflow-hidden">
      <SectionTitle
        icon={<Clock3 className="h-4 w-4 text-ink-faint" aria-hidden />}
        title="Para mover hoy"
        note="Negocios abiertos sin actividad en 14 días o con el siguiente paso vencido."
      />
      {list.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-ink-muted">
          Nada quieto. Todo el embudo se movió en las últimas dos semanas.
        </p>
      ) : (
        <ul className="max-h-[260px] flex-1 divide-y divide-border overflow-y-auto">
          {list.map((s) => (
            <li key={s.id} className="px-5 py-3">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => onOpen(s.id)}
                  className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <span className="block truncate text-sm font-semibold text-ink hover:text-primary">
                    {s.title}
                  </span>
                  <span className="block truncate text-xs text-ink-faint">
                    {s.clientName} · {s.stageLabel} · {s.valueLabel}
                    {s.ownerName ? ` · ${s.ownerName}` : ''}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => task(s)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-primary-soft px-2.5 py-1 text-xs font-bold text-primary hover:bg-primary hover:text-white disabled:opacity-50"
                >
                  <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                  Tarea hoy
                </button>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                <span className="text-amber">{s.why}</span> {s.suggestion}
              </p>
            </li>
          ))}
        </ul>
      )}
      {result && (
        <div className="border-t border-border px-5 py-2">
          <Feedback result={result} />
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Oportunidades: la tabla
// ---------------------------------------------------------------------------

function OpportunitiesTab(props: CrmScreenProps) {
  const [preset, setPreset] = useState(props.presets[0]?.id ?? 'abiertas');
  const current = props.presets.find((p) => p.id === preset) ?? props.presets[0];
  return (
    <div className="space-y-4">
      <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
        <legend className="sr-only">Vistas rápidas</legend>
        {props.presets.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={p.id === preset}
            onClick={() => setPreset(p.id)}
            className={clsx(
              chipClass(p.id === preset ? 'primary' : 'neutral'),
              CHIP_INTERACTIVE,
              'min-h-8 px-3 text-xs',
            )}
          >
            {p.label}
          </button>
        ))}
      </fieldset>
      <DataGrid
        key={preset}
        columns={props.columns}
        rows={props.rows}
        initialView={current?.view}
        onEdit={props.handlers.onEdit}
        onBulkEdit={props.handlers.onBulkEdit}
        onCreate={props.handlers.onCreate}
        exportName="oportunidades"
        noun={{ one: 'negocio', many: 'negocios', gender: 'm' }}
        askCortexContext="mis oportunidades de venta: etapa, valor, probabilidad, cierre y siguiente paso"
        emptyState={{
          title: 'Todavía no hay oportunidades',
          body: 'Crea la primera con «Nuevo negocio» o pídesela a Cortex en el chat.',
        }}
        urlParam={false}
        people={props.team.map((t) => t.name)}
        height="calc(100vh - 360px)"
        renderRowExtra={(row) => <OpportunityPanel row={row} handlers={props.handlers} compact />}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// La ficha de un negocio: anotar y la línea de tiempo
// ---------------------------------------------------------------------------

const KIND_OPTIONS = [
  { value: 'call', label: 'Llamada' },
  { value: 'meeting', label: 'Reunión' },
  { value: 'email', label: 'Correo' },
  { value: 'note', label: 'Nota' },
  { value: 'task', label: 'Tarea' },
] as const;

function OpportunityPanel({
  row,
  handlers,
  compact,
}: {
  row: GridRow;
  handlers: CrmHandlers;
  compact?: boolean;
}) {
  const [items, setItems] = useState<TimelineEntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const load = useCallback(() => {
    handlers
      .timeline(row.id)
      .then((r) => {
        setItems(r.items);
        setMissing(r.missing);
        setError(r.error ?? null);
      })
      .catch(() => setError('No pude leer la línea de tiempo.'));
  }, [handlers, row.id]);
  useEffect(() => load(), [load]);

  return (
    <div className={clsx('space-y-4', compact && 'mt-2 border-t border-border pt-4')}>
      {!compact && (
        <dl className="grid grid-cols-2 gap-3 text-sm">
          {[
            ['Valor', row.values.valor],
            [
              'Probabilidad',
              row.values.probabilidad != null ? `${row.values.probabilidad} %` : '—',
            ],
            ['Cierre esperado', row.values.cierre ?? '—'],
            ['Siguiente paso', row.values.siguiente ?? '—'],
          ].map(([k, v]) => (
            <div key={String(k)} className="rounded-sm bg-surface-2/60 px-3 py-2">
              <dt className="text-micro font-semibold text-ink-faint">{String(k)}</dt>
              <dd className="mt-0.5 text-ink">
                {typeof v === 'number' ? `$${Math.round(v).toLocaleString('es-CO')}` : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <LogForm opportunityId={row.id} handlers={handlers} onDone={load} />
      <section aria-label="Línea de tiempo">
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-faint">
          Lo que ha pasado
        </h3>
        {error && <p className="text-xs text-rose">{error}</p>}
        {items === null && !error && (
          <p className="flex items-center gap-2 text-xs text-ink-faint">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> Leyendo…
          </p>
        )}
        {items && items.length === 0 && (
          <p className="text-xs text-ink-muted">
            Todavía nada. Anota la primera llamada o reunión.
          </p>
        )}
        {items && items.length > 0 && <Timeline items={items} />}
        {missing.length > 0 && (
          <p className="mt-2 text-micro text-ink-faint">Sin dato: {missing.join(', ')}.</p>
        )}
      </section>
    </div>
  );
}

function Timeline({ items }: { items: TimelineEntryView[] }) {
  return (
    <ol className="relative space-y-3 border-l border-border pl-4">
      {items.map((i) => (
        <li key={i.id} className="relative">
          <span
            aria-hidden
            className={clsx(
              'absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface',
              i.from === 'hub' ? 'bg-ink-faint' : i.done ? 'bg-primary' : 'bg-amber',
            )}
          />
          <p className="text-micro text-ink-faint">
            {i.whenLabel} · {i.kindLabel}
            {i.by ? ` · ${i.by}` : ''}
            {i.from === 'hub' ? ' · del cliente' : ''}
            {!i.done ? ' · pendiente' : ''}
          </p>
          <p className="text-sm text-ink">
            {i.href ? (
              <a href={i.href} className="hover:text-primary hover:underline">
                {i.title}
              </a>
            ) : (
              i.title
            )}
          </p>
          {i.detail && <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{i.detail}</p>}
        </li>
      ))}
    </ol>
  );
}

function LogForm({
  opportunityId,
  clientId,
  handlers,
  onDone,
  opportunities,
}: {
  opportunityId?: string | null;
  clientId?: string | null;
  handlers: CrmHandlers;
  onDone?: () => void;
  opportunities?: OppOption[];
}) {
  const router = useRouter();
  const [kind, setKind] = useState<(typeof KIND_OPTIONS)[number]['value']>('call');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [opp, setOpp] = useState(opportunityId ?? '');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  function submit() {
    setResult(null);
    start(async () => {
      const r = await handlers.logActivity({
        opportunityId: opp || null,
        clientId: clientId ?? null,
        kind,
        title,
        dueOn: kind === 'task' && due ? due : null,
      });
      setResult(r);
      if (r.ok) {
        setTitle('');
        setDue('');
        onDone?.();
        router.refresh();
      }
    });
  }
  return (
    <form
      className="space-y-2 rounded-sm border border-border bg-surface-2/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0">
        <legend className="sr-only">Qué fue</legend>
        {KIND_OPTIONS.map((k) => (
          <label key={k.value} className="cursor-pointer">
            <input
              type="radio"
              name="crm-kind"
              value={k.value}
              checked={kind === k.value}
              onChange={() => setKind(k.value)}
              className="peer sr-only"
            />
            <span
              className={clsx(
                chipClass(kind === k.value ? 'primary' : 'neutral'),
                CHIP_INTERACTIVE,
                'px-2.5 peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40',
              )}
            >
              {k.label}
            </span>
          </label>
        ))}
      </fieldset>
      {opportunities && (
        <select
          aria-label="Negocio"
          value={opp}
          onChange={(e) => setOpp(e.target.value)}
          className={FIELD}
          required
        >
          <option value="">¿De qué negocio?</option>
          {opportunities.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <div className="flex gap-2">
        <input
          aria-label={kind === 'task' ? 'Qué hay que hacer' : 'Qué pasó'}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={
            kind === 'task'
              ? 'Qué hay que hacer'
              : 'Qué pasó (pidió descuento, quedó de responder…)'
          }
          className={FIELD}
          maxLength={300}
          required
        />
        {kind === 'task' && (
          <input
            type="date"
            aria-label="Para cuándo"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className={clsx(FIELD, 'w-40 shrink-0')}
          />
        )}
        <Button type="submit" disabled={pending || !title.trim()} className="shrink-0">
          {pending ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Plus className="h-4 w-4" aria-hidden />
          )}
          Anotar
        </Button>
      </div>
      <Feedback result={result} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Actividades: mis tareas de hoy
// ---------------------------------------------------------------------------

const BUCKETS: Array<{
  id: TaskView['bucket'];
  label: string;
  tone: 'rose' | 'amber' | 'primary' | 'neutral';
}> = [
  { id: 'vencida', label: 'Vencidas', tone: 'rose' },
  { id: 'hoy', label: 'Hoy', tone: 'amber' },
  { id: 'proxima', label: 'Próximos 7 días', tone: 'primary' },
  { id: 'sin_fecha', label: 'Sin fecha', tone: 'neutral' },
];

function ActivitiesTab(props: CrmScreenProps & { onOpen: (id: string) => void }) {
  const router = useRouter();
  const [mine, setMine] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const tasks = props.tasks.filter(
    (t) => (!mine || t.ownerId === props.userId) && !hidden.has(t.id),
  );
  function complete(id: string) {
    start(async () => {
      const r = await props.handlers.completeTask(id, true);
      if (r.ok) {
        setHidden((p) => new Set(p).add(id));
        router.refresh();
      }
    });
  }
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <fieldset className="m-0 flex gap-2 border-0 p-0">
          <legend className="sr-only">De quién</legend>
          {[
            { v: true, l: 'Mías' },
            { v: false, l: 'De todo el equipo' },
          ].map((o) => (
            <button
              key={o.l}
              type="button"
              aria-pressed={mine === o.v}
              onClick={() => setMine(o.v)}
              className={clsx(
                chipClass(mine === o.v ? 'primary' : 'neutral'),
                CHIP_INTERACTIVE,
                'min-h-8 px-3 text-xs',
              )}
            >
              {o.l}
            </button>
          ))}
        </fieldset>
        {tasks.length === 0 ? (
          <Empty
            title={mine ? 'No tienes tareas para hoy' : 'El equipo no tiene tareas pendientes'}
            body="Las tareas salen de lo que anotes, de un negocio quieto («Tarea hoy»), del piloto automático y de las encuestas con mala calificación."
          />
        ) : (
          BUCKETS.map((b) => {
            const list = tasks.filter((t) => t.bucket === b.id);
            if (!list.length) return null;
            return (
              <Panel key={b.id} className="overflow-hidden">
                <h2 className="flex items-center gap-2 px-5 pb-2 pt-4 text-sm font-bold text-ink">
                  <span className={clsx('h-2 w-2 rounded-full', TONE_BAR[b.tone])} aria-hidden />
                  {b.label}
                  <span className="tabular text-xs font-normal text-ink-faint">{list.length}</span>
                </h2>
                <ul className="divide-y divide-border">
                  {list.map((t) => (
                    <li key={t.id} className="flex items-start gap-3 px-5 py-3">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => complete(t.id)}
                        aria-label={`Marcar hecha: ${t.title}`}
                        className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-[6px] border border-border-strong text-transparent transition-colors hover:border-emerald hover:text-emerald disabled:opacity-50"
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-ink">{t.title}</p>
                        <p className="mt-0.5 text-xs text-ink-faint">
                          {t.dueLabel}
                          {t.oppTitle ? (
                            <>
                              {' · '}
                              <button
                                type="button"
                                onClick={() => t.oppId && props.onOpen(t.oppId)}
                                className="font-medium text-ink-muted hover:text-primary hover:underline"
                              >
                                {t.oppTitle}
                              </button>
                            </>
                          ) : null}
                          {t.clientName ? ` · ${t.clientName}` : ''}
                          {!mine && t.ownerName ? ` · ${t.ownerName}` : ''}
                          {t.originLabel ? ` · ${t.originLabel}` : ''}
                        </p>
                        {t.body && (
                          <p className="mt-1 text-xs leading-relaxed text-ink-muted">{t.body}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </Panel>
            );
          })
        )}
      </div>
      <Panel className="h-fit overflow-hidden">
        <SectionTitle
          icon={<PhoneCall className="h-4 w-4 text-ink-faint" aria-hidden />}
          title="Anotar"
          note="Una llamada, reunión o correo cuenta como movimiento del negocio; una tarea le queda a su responsable."
        />
        <div className="px-5 pb-5">
          <LogForm handlers={props.handlers} opportunities={props.opportunities} />
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// En riesgo
// ---------------------------------------------------------------------------

function RiskTab(props: CrmScreenProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [results, setResults] = useState<Record<string, ActionResult>>({});
  if (props.risk.length === 0)
    return (
      <Empty
        title="Ningún cliente da señales de irse"
        body="Cortex compara a cada cliente con su propia historia: si compra menos seguido, le facturan menos, paga más tarde, nadie le habla, se quejó por WhatsApp o calificó mal la encuesta. Lo revisa cada mañana y te avisa de lo nuevo."
      />
    );
  function act(r: RiskView, kind: 'task' | 'survey') {
    start(async () => {
      const res =
        kind === 'task'
          ? await props.handlers.logActivity({
              clientId: r.clientId,
              kind: 'task',
              title: r.action ?? `Llamar a ${r.clientName}`,
              body: r.evidence.join(' '),
            })
          : await props.handlers.sendSurvey({ client: r.clientName, linkOnly: true });
      setResults((prev) => ({ ...prev, [`${r.clientId}:${kind}`]: res }));
      if (res.ok) router.refresh();
    });
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {props.risk.map((r) => (
        <Panel key={r.clientId} className="relative overflow-hidden">
          <span aria-hidden className={clsx('absolute inset-y-0 left-0 w-1', TONE_BAR[r.tone])} />
          <div className="flex items-start justify-between gap-3 px-5 pt-4">
            <div className="min-w-0">
              <Link
                href={r.href}
                className="inline-flex items-center gap-1 text-base font-bold text-ink hover:text-primary"
              >
                {r.clientName}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
              <p className="text-xs text-ink-faint">
                {r.revenueLabel}
                {r.ownerName ? ` · lo atiende ${r.ownerName}` : ' · sin responsable'}
              </p>
            </div>
            <span className={chipClass(r.tone)}>
              {r.levelLabel} · {r.score}
            </span>
          </div>
          <ul className="mt-3 space-y-1.5 px-5">
            {r.evidence.map((e) => (
              <li key={e} className="flex gap-2 text-sm leading-relaxed text-ink-muted">
                <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint" />
                {e}
              </li>
            ))}
          </ul>
          {r.action && (
            <p className="mx-5 mt-3 rounded-sm bg-primary-soft px-3 py-2 text-sm text-ink">
              <strong className="font-semibold">Qué hacer: </strong>
              {r.action}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2 border-t border-border bg-surface-2/40 px-5 py-3">
            <button
              type="button"
              disabled={pending}
              onClick={() => act(r, 'task')}
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3 py-1.5 text-xs font-bold text-white hover:bg-primary-strong disabled:opacity-50"
            >
              <CalendarClock className="h-3.5 w-3.5" aria-hidden />
              Tarea para su responsable
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => act(r, 'survey')}
              className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-2 disabled:opacity-50"
            >
              <MessageSquareHeart className="h-3.5 w-3.5" aria-hidden />
              Enlace de encuesta
            </button>
          </div>
          {(['task', 'survey'] as const).map((k) => {
            const res = results[`${r.clientId}:${k}`];
            return res ? (
              <div key={k} className="px-5 pb-3">
                <Feedback result={res} />
                {res.ok && res.link && <CopyLink link={res.link} />}
              </div>
            ) : null;
          })}
        </Panel>
      ))}
    </div>
  );
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2">
      <input
        readOnly
        value={link}
        aria-label="Enlace"
        className={clsx(FIELD, 'font-mono text-xs')}
      />
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(link).then(() => setCopied(true));
        }}
        className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-pill border border-border-strong px-3 text-xs font-semibold text-ink hover:bg-surface-2"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Análisis
// ---------------------------------------------------------------------------

function RateList({ rows, empty }: { rows: RateRowView[]; empty: string }) {
  if (!rows.length) return <p className="px-5 pb-4 text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-3 px-5 py-2.5">
          <div className="w-40 min-w-0 shrink-0">
            <p className="truncate text-sm font-medium text-ink">{r.label}</p>
            <p className="truncate text-micro text-ink-faint">{r.detail}</p>
          </div>
          <Meter share={r.rate} label={r.rateLabel} />
        </li>
      ))}
    </ul>
  );
}

function MarginTable({ rows, product }: { rows: MarginRowView[]; product?: boolean }) {
  if (!rows.length)
    return <p className="px-5 pb-4 text-sm text-ink-muted">Sin ventas para medir.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-micro font-semibold uppercase tracking-wide text-ink-faint">
            <th className="px-5 py-2 font-semibold">{product ? 'Producto' : 'Cliente'}</th>
            <th className="px-3 py-2 text-right font-semibold">Venta</th>
            <th className="px-3 py-2 text-right font-semibold">Margen</th>
            <th className="px-5 py-2 font-semibold">{product ? 'Precio' : 'Descuento'}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="max-w-[220px] truncate px-5 py-2 text-ink">{r.label}</td>
              <td className="tabular px-3 py-2 text-right text-ink">{r.revenueLabel}</td>
              <td className="px-3 py-2 text-right">
                <span className={chipClass(r.marginTone)} title={r.coverageLabel}>
                  {r.marginLabel}
                </span>
              </td>
              <td className="px-5 py-2 text-xs text-ink-muted">
                {product ? (r.priceLabel ?? '—') : r.discountLabel}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnalyticsTab({ view }: { view: AnalyticsView | null }) {
  if (!view)
    return (
      <Empty
        title="No pude armar el análisis"
        body="Las cotizaciones o las oportunidades no se pudieron leer. Vuelve a intentarlo en un momento."
      />
    );
  return (
    <div className="space-y-5">
      <Tiles tiles={view.tiles} />
      <div className="grid gap-4 xl:grid-cols-3">
        <Panel className="overflow-hidden">
          <SectionTitle
            icon={<BarChart3 className="h-4 w-4 text-ink-faint" aria-hidden />}
            title="Conversión por mes"
            note="Cotizaciones ganadas sobre las decididas (ganadas, rechazadas y vencidas)."
          />
          <RateList rows={view.byMonth} empty="Todavía no hay cotizaciones decididas." />
        </Panel>
        <Panel className="overflow-hidden">
          <SectionTitle title="Por responsable" note="Quien hizo la cotización." />
          <RateList rows={view.byOwner} empty="Sin cotizaciones." />
        </Panel>
        <Panel className="overflow-hidden">
          <SectionTitle title="Por producto" note="Un producto cuenta una vez por cotización." />
          <RateList rows={view.byProduct.slice(0, 10)} empty="Sin productos cotizados." />
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="overflow-hidden">
          <SectionTitle
            title="Por qué se pierde"
            note="La razón que se anotó al darla por perdida."
          />
          {view.reasons.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-ink-muted">No hay negocios perdidos.</p>
          ) : (
            <ul className="space-y-2.5 px-5 pb-5">
              {view.reasons.map((r) => (
                <li key={r.label} className="flex items-center gap-3">
                  <span className="w-44 shrink-0 truncate text-sm text-ink">{r.label}</span>
                  <Meter share={r.share} tone="neutral" label={String(r.count)} />
                  <span className="tabular w-28 shrink-0 text-right text-xs text-ink-muted">
                    {r.valueLabel}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {view.bySource.length > 0 && (
            <div className="border-t border-border px-5 py-3">
              <p className="mb-1.5 text-micro font-semibold uppercase tracking-wide text-ink-faint">
                Por origen
              </p>
              <ul className="space-y-1 text-xs text-ink-muted">
                {view.bySource.map((s) => (
                  <li key={s.label}>
                    <span className="font-semibold text-ink">{s.label}:</span> {s.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
        <Panel className="overflow-hidden">
          <SectionTitle
            title="Precios y márgenes"
            note={`${view.marginTotals.revenueLabel} vendidos · margen ${view.marginTotals.marginLabel} · ${view.marginTotals.coverageLabel}.`}
          />
          {view.marginNote && (
            <p className="mx-5 mb-3 rounded-sm bg-amber-soft px-3 py-2 text-xs leading-relaxed text-amber">
              {view.marginNote}
            </p>
          )}
          <MarginTable rows={view.marginsByClient} />
        </Panel>
      </div>
      <Panel className="overflow-hidden">
        <SectionTitle
          title="Por producto"
          note="Precio neto (después de descuento, antes de IVA) contra el costo promedio del inventario."
        />
        <MarginTable rows={view.marginsByProduct} product />
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Encuestas
// ---------------------------------------------------------------------------

function SurveysTab(props: CrmScreenProps) {
  const router = useRouter();
  const [client, setClient] = useState('');
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const n = props.nps;
  const total = Math.max(1, n.responses);
  const segments = useMemo(
    () => [
      { label: 'Detractores', count: n.detractors, tone: 'rose' as const },
      { label: 'Pasivos', count: n.passives, tone: 'amber' as const },
      { label: 'Promotores', count: n.promoters, tone: 'emerald' as const },
    ],
    [n],
  );
  function send(linkOnly: boolean) {
    setResult(null);
    start(async () => {
      const r = await props.handlers.sendSurvey({ client, email: email || null, linkOnly });
      setResult(r);
      if (r.ok) router.refresh();
    });
  }
  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <Panel className="overflow-hidden">
          <SectionTitle
            icon={<MessageSquareHeart className="h-4 w-4 text-ink-faint" aria-hidden />}
            title="Satisfacción (NPS)"
            note={n.note}
          />
          <div className="flex flex-wrap items-end gap-6 px-5 pb-5">
            <div>
              <p className={clsx('stat-num text-4xl leading-none', TONE_TEXT[n.tone])}>
                {n.scoreLabel}
              </p>
              <p className="mt-1 text-xs text-ink-faint">
                {n.responses} respuesta{n.responses === 1 ? '' : 's'} · {n.pending} esperando
              </p>
            </div>
            <div className="min-w-[240px] flex-1">
              <div
                className="flex h-3 gap-0.5 overflow-hidden rounded-pill bg-surface-2"
                aria-hidden
              >
                {segments.map((s) =>
                  s.count ? (
                    <span
                      key={s.label}
                      className={TONE_BAR[s.tone]}
                      style={{ width: `${(s.count / total) * 100}%` }}
                      title={`${s.label}: ${s.count}`}
                    />
                  ) : null,
                )}
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
                {segments.map((s) => (
                  <li key={s.label} className="flex items-center gap-1.5">
                    <span className={clsx('h-2 w-2 rounded-full', TONE_BAR[s.tone])} aria-hidden />
                    {s.label} <span className="tabular font-semibold text-ink">{s.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Panel>
        <Panel className="overflow-hidden">
          <SectionTitle
            icon={<Mail className="h-4 w-4 text-ink-faint" aria-hidden />}
            title="Nueva encuesta"
            note="Una pregunta de 0 a 10 con comentario. Si califica de 0 a 6, su responsable recibe una tarea para llamarlo."
          />
          <form
            className="space-y-2 px-5 pb-5"
            onSubmit={(e) => {
              e.preventDefault();
              send(false);
            }}
          >
            <input
              aria-label="Cliente"
              value={client}
              onChange={(e) => setClient(e.target.value)}
              placeholder="Cliente (nombre o NIT)"
              className={FIELD}
              required
            />
            <input
              aria-label="Correo"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Correo (vacío = su contacto principal)"
              className={FIELD}
            />
            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="submit" disabled={pending || !client.trim()}>
                {pending ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Mail className="h-4 w-4" aria-hidden />
                )}
                Mandar por correo
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending || !client.trim()}
                onClick={() => send(true)}
              >
                Sólo el enlace
              </Button>
            </div>
            <Feedback result={result} />
            {result?.ok && result.link && <CopyLink link={result.link} />}
          </form>
        </Panel>
      </div>

      {props.surveys.length === 0 ? (
        <Empty
          title="Todavía no hay encuestas"
          body="Manda la primera a un cliente que acabe de recibir un pedido. También se la puedes pedir a Cortex: «mándale la encuesta a Nexa»."
        />
      ) : (
        <Panel className="overflow-hidden">
          <ul className="divide-y divide-border">
            {props.surveys.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start gap-4 px-5 py-3.5">
                <span
                  className={clsx(
                    'stat-num grid h-11 w-11 shrink-0 place-items-center rounded-sm text-lg',
                    s.score === null ? 'bg-surface-2 text-ink-faint' : 'text-white',
                    s.score !== null && TONE_BAR[s.tone],
                  )}
                  aria-label={s.score === null ? 'Sin respuesta' : `Calificó ${s.score}`}
                >
                  {s.score ?? '—'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">
                    {s.clientId ? (
                      <Link href={`/clients/${s.clientId}`} className="hover:text-primary">
                        {s.clientName}
                      </Link>
                    ) : (
                      s.clientName
                    )}
                    {s.contact && (
                      <span className="font-normal text-ink-faint"> · {s.contact}</span>
                    )}
                  </p>
                  {s.comment ? (
                    <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                      «{s.comment}»{s.respondent ? ` — ${s.respondent}` : ''}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-ink-faint">
                      {s.score === null ? 'Esperando respuesta.' : 'Sin comentario.'}
                    </p>
                  )}
                  {s.followUp && (
                    <p className="mt-1 text-xs font-semibold text-rose">
                      Quedó una tarea de seguimiento.
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className={chipClass(s.tone)}>{s.bucketLabel ?? s.statusLabel}</span>
                  <span className="text-micro text-ink-faint">{s.sentLabel}</span>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
