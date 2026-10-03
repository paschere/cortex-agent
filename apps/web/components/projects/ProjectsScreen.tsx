'use client';

import DataGrid from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import {
  Empty,
  FIELD,
  Feedback,
  Modal,
  NUMBER_FIELD,
  Tiles,
  readNumber,
} from '@/components/inventory/parts';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import type {
  ActionResult,
  Option,
  ProjectChoice,
  ProjectsTab,
  RateView,
  Tile,
  TimesheetView,
  WonOpportunityView,
} from '@/lib/projects/shape';
import { PROJECTS_TABS } from '@/lib/projects/shape';
import { CHIP_INTERACTIVE, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  LoaderCircle,
  Plus,
  Sparkles,
  Timer,
  Trophy,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { LogTimeDialog, type LogTimeInput } from './LogTimeDialog';

/**
 * /proyectos: órdenes de servicio y proyectos con su cuenta (migración 0196).
 * Todo llega armado del servidor (lib/projects/views.ts); las acciones llegan
 * como funciones para que el escaparate de desarrollo pinte la misma pantalla.
 */

export interface NewProjectInput {
  title: string;
  kind: 'orden_servicio' | 'proyecto';
  client: string | null;
  budgetAmount: number | null;
  budgetHours: number | null;
  contractAmount: number | null;
  startOn: string | null;
  dueOn: string | null;
  ownerId: string | null;
  tasks: string[];
}

export interface ProjectsHandlers {
  onEdit?: (rowId: string, key: string, value: unknown) => Promise<void>;
  onBulkEdit?: (rowIds: string[], key: string, value: unknown) => Promise<void>;
  onCreate?: (values: Record<string, unknown>) => Promise<GridRow>;
  createProject: (input: NewProjectInput) => Promise<ActionResult>;
  logTime: (input: LogTimeInput) => Promise<ActionResult>;
  setRate: (
    userId: string | null,
    costRate: number,
    billRate: number | null,
  ) => Promise<ActionResult>;
  openFromOpportunity: (id: string) => Promise<ActionResult>;
}

export interface ProjectsScreenProps {
  tab: ProjectsTab;
  today: string;
  tiles: Tile[];
  columns: GridColumn[];
  rows: GridRow[];
  presets: Array<{ id: string; label: string; view: Partial<GridView> }>;
  choices: ProjectChoice[];
  people: Option[];
  week: TimesheetView;
  rates: RateView[];
  won: WonOpportunityView[];
  canManage: boolean;
  handlers: ProjectsHandlers;
  tabHref?: (tab: ProjectsTab) => string;
}

export function ProjectsScreen(props: ProjectsScreenProps) {
  const [creating, setCreating] = useState(false);
  const [logging, setLogging] = useState(false);
  const href =
    props.tabHref ??
    ((t: ProjectsTab) => (t === 'proyectos' ? '/proyectos' : `/proyectos?tab=${t}`));
  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Proyectos y órdenes de servicio"
        subtitle="Cada trabajo para un cliente con sus tareas, horas, materiales y gastos: cuánto va contra lo presupuestado, cuánto deja y qué falta por facturar."
        icon={<FolderKanban className="h-5 w-5" aria-hidden />}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setLogging(true)}
              disabled={!props.choices.length}
            >
              <Timer className="h-4 w-4" aria-hidden />
              Registrar horas
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Nuevo proyecto
            </Button>
          </div>
        }
      />

      <Tiles tiles={props.tiles} />

      {props.won.length > 0 && (
        <WonBanner won={props.won} open={props.handlers.openFromOpportunity} />
      )}

      <nav
        className="mb-5 mt-7 flex gap-1 overflow-x-auto border-b border-border"
        aria-label="Secciones de proyectos"
      >
        {PROJECTS_TABS.map((t) => (
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
          </Link>
        ))}
      </nav>

      {props.tab === 'proyectos' && <ProjectsTabView {...props} onNew={() => setCreating(true)} />}
      {props.tab === 'horas' && <WeekTab week={props.week} onLog={() => setLogging(true)} />}
      {props.tab === 'tarifas' && (
        <RatesTab
          rates={props.rates}
          canManage={props.canManage}
          setRate={props.handlers.setRate}
        />
      )}

      {creating && (
        <NewProjectDialog
          people={props.people}
          today={props.today}
          onClose={() => setCreating(false)}
          create={props.handlers.createProject}
        />
      )}
      {logging && (
        <LogTimeDialog
          projects={props.choices}
          people={props.canManage ? props.people : undefined}
          today={props.today}
          onClose={() => setLogging(false)}
          logTime={props.handlers.logTime}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function WonBanner({
  won,
  open,
}: { won: WonOpportunityView[]; open: (id: string) => Promise<ActionResult> }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <section
      className="mt-6 rounded-card border border-emerald/25 bg-emerald-soft/40 px-5 py-4"
      aria-label="Ganadas sin proyecto"
    >
      <div className="flex items-center gap-2 text-sm font-bold text-ink">
        <Trophy className="h-4 w-4 text-emerald" aria-hidden />
        Ganadas en el embudo, sin proyecto todavía
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        {won.slice(0, 4).map((o) => (
          <li
            key={o.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-sm bg-surface px-3 py-2 text-sm"
          >
            <span className="min-w-0">
              <span className="font-semibold text-ink">{o.title}</span>
              <span className="text-ink-muted">
                {o.client ? ` · ${o.client}` : ''}
                {o.value ? ` · ${o.value}` : ''} · ganada el {o.wonAt}
              </span>
            </span>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                setBusy(o.id);
                void open(o.id).then((r) => {
                  setBusy(null);
                  setResult(r);
                  if (r.ok && r.href) router.push(r.href);
                });
              }}
            >
              {busy === o.id ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Plus className="h-4 w-4" aria-hidden />
              )}
              Abrir proyecto
            </Button>
          </li>
        ))}
      </ul>
      {result && !result.ok && (
        <div className="mt-2">
          <Feedback result={result} />
        </div>
      )}
    </section>
  );
}

function ProjectsTabView(props: ProjectsScreenProps & { onNew: () => void }) {
  const [preset, setPreset] = useState(props.presets[0]?.id ?? 'lista');
  const current = props.presets.find((p) => p.id === preset) ?? props.presets[0];
  if (props.rows.length === 0)
    return (
      <Empty
        title="Todavía no hay proyectos"
        body="Abre una orden de servicio con su cliente, presupuesto y tareas, o conviértela desde una cotización o un pedido de Ventas. El equipo registra sus horas y Cortex te dice cuánto deja cada trabajo."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={props.onNew}>
              <Plus className="h-4 w-4" aria-hidden />
              Nuevo proyecto
            </Button>
            <Link
              href={`/chat?prompt=${encodeURIComponent('Convierte la cotización COT- en una orden de servicio, con una tarea por línea')}`}
              className="inline-flex min-h-10 items-center gap-2 rounded-pill border border-border-strong bg-surface px-4 text-sm font-bold text-ink hover:bg-surface-2"
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              Desde una cotización
            </Link>
          </div>
        }
      />
    );
  return (
    <div className="space-y-4">
      <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
        <legend className="sr-only">Vistas</legend>
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
        noun={{ one: 'proyecto', many: 'proyectos', gender: 'm' }}
        exportName="proyectos"
        urlParam={false}
        askCortexContext="mis proyectos y órdenes de servicio"
        people={props.people.map((p) => p.label)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

export function TimesheetTable({ week, emptyText }: { week: TimesheetView; emptyText: string }) {
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-semibold text-ink-muted">
            <th className="px-4 py-2.5 font-semibold">{''}</th>
            {week.dayLabels.map((d, i) => (
              <th
                key={d}
                className={clsx(
                  'px-2 py-2.5 text-right font-semibold tabular',
                  week.days[i] === week.today && 'text-primary',
                )}
              >
                {d}
              </th>
            ))}
            <th className="px-4 py-2.5 text-right font-semibold">Total</th>
          </tr>
        </thead>
        <tbody>
          {week.rows.length === 0 && (
            <tr>
              <td colSpan={9} className="px-4 py-8 text-center text-sm text-ink-muted">
                {emptyText}
              </td>
            </tr>
          )}
          {week.rows.map((r) => (
            <tr key={r.key} className="border-b border-border/60 last:border-0">
              <td className="max-w-[260px] truncate px-4 py-2.5 font-semibold text-ink">
                {r.href ? (
                  <Link href={r.href} className="hover:underline">
                    {r.label}
                  </Link>
                ) : (
                  r.label
                )}
              </td>
              {r.days.map((h, i) => (
                <td key={week.days[i]} className="px-2 py-2.5 text-right tabular text-ink">
                  {h || <span className="text-ink-faint">·</span>}
                </td>
              ))}
              <td className="px-4 py-2.5 text-right font-bold tabular text-ink">{r.total}</td>
            </tr>
          ))}
        </tbody>
        {week.rows.length > 0 && (
          <tfoot>
            <tr className="border-t border-border bg-surface-2/60 text-xs font-bold text-ink">
              <td className="px-4 py-2.5">Total</td>
              {week.dayTotals.map((h, i) => (
                <td key={week.days[i]} className="px-2 py-2.5 text-right tabular">
                  {h}
                </td>
              ))}
              <td className="px-4 py-2.5 text-right tabular">{week.total}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function WeekTab({ week, onLog }: { week: TimesheetView; onLog: () => void }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link
            href={week.prevHref}
            className="grid h-9 w-9 place-items-center rounded-pill border border-border bg-surface hover:bg-surface-2"
            aria-label="Semana anterior"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Link>
          <span className="text-sm font-bold text-ink">Semana del {week.weekLabel}</span>
          {week.nextHref ? (
            <Link
              href={week.nextHref}
              className="grid h-9 w-9 place-items-center rounded-pill border border-border bg-surface hover:bg-surface-2"
              aria-label="Semana siguiente"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Link>
          ) : null}
        </div>
        <Button variant="outline" onClick={onLog}>
          <Timer className="h-4 w-4" aria-hidden />
          Registrar horas
        </Button>
      </div>
      <TimesheetTable week={week} emptyText="Nadie ha registrado horas esta semana." />
    </div>
  );
}

function RatesTab({
  rates,
  canManage,
  setRate,
}: {
  rates: RateView[];
  canManage: boolean;
  setRate: ProjectsHandlers['setRate'];
}) {
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">
        Lo que le cuesta a la empresa una hora de cada persona (salario, prestaciones y seguridad
        social divididos por las horas del mes) y, si se cobra por hora, a cuánto se le vende. Cada
        registro de horas guarda la tarifa de ese día: cambiarla no reescribe el pasado.
        {!canManage && ' Sólo quien administra la empresa puede cambiarlas.'}
      </p>
      <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
        <table className="w-full min-w-[620px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs font-semibold text-ink-muted">
              <th className="px-4 py-2.5">Persona</th>
              <th className="px-3 py-2.5 text-right">Costo por hora</th>
              <th className="px-3 py-2.5 text-right">Precio por hora</th>
              <th className="px-3 py-2.5 text-right">Horas del mes</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rates.map((r) => (
              <RateRow
                key={r.userId ?? 'empresa'}
                rate={r}
                canManage={canManage}
                setRate={setRate}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RateRow({
  rate,
  canManage,
  setRate,
}: { rate: RateView; canManage: boolean; setRate: ProjectsHandlers['setRate'] }) {
  const router = useRouter();
  const [cost, setCost] = useState(rate.costRate !== null ? String(rate.costRate) : '');
  const [bill, setBill] = useState(rate.billRate !== null ? String(rate.billRate) : '');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const dirty =
    cost !== (rate.costRate !== null ? String(rate.costRate) : '') ||
    bill !== (rate.billRate !== null ? String(rate.billRate) : '');
  return (
    <tr
      className={clsx(
        'border-b border-border/60 last:border-0',
        rate.userId === null && 'bg-surface-2/50',
      )}
    >
      <td className="px-4 py-2 font-semibold text-ink">
        {rate.name}
        {rate.source === 'nomina' && (
          <span className={clsx(chipClass('primary'), 'ml-2')}>De nómina</span>
        )}
        {result && !result.ok && (
          <p className="mt-1 text-xs font-normal text-rose">{result.error}</p>
        )}
      </td>
      <td className="px-3 py-2">
        <input
          className={clsx(NUMBER_FIELD, 'ml-auto max-w-[140px]')}
          inputMode="decimal"
          placeholder={rate.userId ? 'la de la empresa' : '0'}
          value={cost}
          disabled={!canManage}
          onChange={(e) => setCost(e.target.value)}
          aria-label={`Costo por hora de ${rate.name}`}
        />
      </td>
      <td className="px-3 py-2">
        <input
          className={clsx(NUMBER_FIELD, 'ml-auto max-w-[140px]')}
          inputMode="decimal"
          placeholder="—"
          value={bill}
          disabled={!canManage}
          onChange={(e) => setBill(e.target.value)}
          aria-label={`Precio por hora de ${rate.name}`}
        />
      </td>
      <td className="px-3 py-2 text-right tabular text-ink-muted">{rate.hoursThisMonth || '—'}</td>
      <td className="px-4 py-2 text-right">
        {canManage && dirty && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const c = readNumber(cost);
                const r = await setRate(rate.userId, c ?? 0, readNumber(bill));
                setResult(r);
                if (r.ok) router.refresh();
              })
            }
          >
            {pending ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Guardar
          </Button>
        )}
        {result?.ok && !dirty && <span className="text-xs text-emerald">Guardado</span>}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------

function NewProjectDialog({
  people,
  today,
  onClose,
  create,
}: {
  people: Option[];
  today: string;
  onClose: () => void;
  create: (input: NewProjectInput) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'orden_servicio' | 'proyecto'>('orden_servicio');
  const [client, setClient] = useState('');
  const [budget, setBudget] = useState('');
  const [hoursB, setHoursB] = useState('');
  const [contract, setContract] = useState('');
  const [startOn, setStartOn] = useState(today);
  const [dueOn, setDueOn] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [tasks, setTasks] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const r = await create({
        title,
        kind,
        client: client.trim() || null,
        budgetAmount: readNumber(budget),
        budgetHours: readNumber(hoursB),
        contractAmount: readNumber(contract),
        startOn: startOn || null,
        dueOn: dueOn || null,
        ownerId: ownerId || null,
        tasks: tasks
          .split('\n')
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setResult(r);
      if (r.ok && r.href) router.push(r.href);
    });
  return (
    <Modal
      title="Nuevo proyecto"
      subtitle="Con el presupuesto de costo y el valor del contrato, Cortex te dice cuánto deja y te avisa si se pasa."
      onClose={onClose}
      wide
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-ink-muted sm:col-span-2">
          Qué se va a hacer
          <input
            className={`${FIELD} mt-1.5`}
            value={title}
            maxLength={200}
            placeholder="Mantenimiento de 3 montacargas"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Tipo
          <select
            className={`${FIELD} mt-1.5`}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="orden_servicio">Orden de servicio</option>
            <option value="proyecto">Proyecto</option>
          </select>
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Cliente
          <input
            className={`${FIELD} mt-1.5`}
            value={client}
            placeholder="Como está en Clientes"
            onChange={(e) => setClient(e.target.value)}
          />
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Presupuesto de costo
          <input
            className={`${NUMBER_FIELD} mt-1.5`}
            inputMode="decimal"
            value={budget}
            placeholder="6.000.000"
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Horas presupuestadas
          <input
            className={`${NUMBER_FIELD} mt-1.5`}
            inputMode="decimal"
            value={hoursB}
            placeholder="40"
            onChange={(e) => setHoursB(e.target.value)}
          />
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Valor del contrato (antes de IVA)
          <input
            className={`${NUMBER_FIELD} mt-1.5`}
            inputMode="decimal"
            value={contract}
            placeholder="9.500.000"
            onChange={(e) => setContract(e.target.value)}
          />
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Responsable
          <select
            className={`${FIELD} mt-1.5`}
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
          >
            <option value="">Yo</option>
            {people.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Inicio
          <input
            className={`${FIELD} mt-1.5`}
            type="date"
            value={startOn}
            onChange={(e) => setStartOn(e.target.value)}
          />
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Entrega
          <input
            className={`${FIELD} mt-1.5`}
            type="date"
            value={dueOn}
            min={startOn || undefined}
            onChange={(e) => setDueOn(e.target.value)}
          />
        </label>
        <label className="block text-xs font-semibold text-ink-muted sm:col-span-2">
          Tareas (una por línea, opcional)
          <textarea
            className={`${FIELD} mt-1.5 min-h-24 py-2`}
            value={tasks}
            onChange={(e) => setTasks(e.target.value)}
            placeholder={'Diagnóstico\nCambio de repuestos\nPruebas y entrega'}
          />
        </label>
      </div>
      <div className="mt-4 space-y-3">
        <Feedback result={result} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={pending || !title.trim()}>
            {pending ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-4 w-4" aria-hidden />
            )}
            Abrir
          </Button>
        </div>
      </div>
    </Modal>
  );
}
