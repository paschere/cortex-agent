'use client';

import {
  FIELD,
  Feedback,
  NUMBER_FIELD,
  TONE_BAR,
  TONE_TEXT,
  readNumber,
} from '@/components/inventory/parts';
import { Button } from '@/components/ui/button';
import type { ActionResult, Bar, ProjectDetailView } from '@/lib/projects/shape';
import { COST_KIND_OPTIONS } from '@/lib/projects/shape';
import { chipClass } from '@/lib/status-chip';
import type { ProjectPatch, ProjectStatus } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarRange,
  CircleDollarSign,
  ClipboardList,
  FileText,
  Flag,
  History,
  LoaderCircle,
  Package,
  Plus,
  Receipt,
  Timer,
  Trash2,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState, useTransition } from 'react';
import { LogTimeDialog, type LogTimeInput } from './LogTimeDialog';

/**
 * EL DETALLE DE UN PROYECTO (migración 0196). Todo llega armado del servidor
 * (lib/projects/views.ts → detailView); aquí sólo se dibuja y se llaman las
 * acciones, que vuelven con `ActionResult`.
 */

export interface ProjectDetailHandlers {
  update: (id: string, patch: ProjectPatch) => Promise<ActionResult>;
  addTask: (
    projectId: string,
    task: { title: string; assigneeId: string | null; dueOn: string | null },
  ) => Promise<ActionResult>;
  toggleTask: (projectId: string, taskId: string, done: boolean) => Promise<ActionResult>;
  logTime: (input: LogTimeInput) => Promise<ActionResult>;
  deleteTime: (projectId: string, entryId: string) => Promise<ActionResult>;
  addCost: (
    projectId: string,
    input: {
      kind: 'material' | 'gasto' | 'subcontrato' | 'otro';
      description: string;
      amount: number;
      date: string;
      counterparty: string | null;
    },
  ) => Promise<ActionResult>;
  linkLedger: (projectId: string, ledgerMovementId: string) => Promise<ActionResult>;
  consumeMaterial: (
    projectId: string,
    input: { product: string; qty: number },
  ) => Promise<ActionResult>;
  addMilestone: (
    projectId: string,
    input: { title: string; amount: number; dueOn: string | null },
  ) => Promise<ActionResult>;
  invoice: (projectId: string, milestoneId: string | null) => Promise<ActionResult>;
}

function useAction() {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) {
        after?.();
        router.refresh();
      }
    });
  return { result, pending, run, setResult };
}

function Section({
  icon,
  title,
  right,
  children,
}: { icon: ReactNode; title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="text-ink-faint">{icon}</span>
          {title}
        </h2>
        {right}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function Meter({ title, bar }: { title: string; bar: Bar }) {
  const width = bar.pct === null ? 0 : Math.min(100, Math.max(0, bar.pct));
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3.5 shadow-card">
      <div className="text-xs font-semibold text-ink-muted">{title}</div>
      <div
        className={clsx(
          'stat-num mt-2 text-lg leading-none',
          bar.pct !== null && bar.pct > 100 ? 'text-rose' : 'text-ink',
        )}
      >
        {bar.label}
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-pill bg-surface-2" aria-hidden>
        <div
          className={clsx('h-full rounded-pill', TONE_BAR[bar.tone])}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="mt-1.5 text-xs leading-snug text-ink-faint">
        {bar.pct !== null ? `${bar.pct.toLocaleString('es-CO')} % · ` : ''}
        {bar.note}
      </div>
    </div>
  );
}

export function ProjectDetail({
  view,
  today,
  handlers,
}: {
  view: ProjectDetailView;
  today: string;
  handlers: ProjectDetailHandlers;
}) {
  const h = view.header;
  const [logging, setLogging] = useState(false);
  const status = useAction();
  const invoice = useAction();
  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <Link
        href="/proyectos"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Proyectos
      </Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-sm bg-ink px-2 py-0.5 font-mono text-xs font-bold tracking-wide text-surface">
              {h.code}
            </span>
            <span className={chipClass('neutral')}>{h.kindLabel}</span>
            <span className={chipClass(h.statusTone)}>{h.statusLabel}</span>
          </div>
          <h1 className="mt-2 text-balance text-xl font-extrabold text-ink md:text-display">
            {h.title}
          </h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            {h.client ? (
              h.clientHref ? (
                <Link href={h.clientHref} className="font-semibold text-ink hover:underline">
                  {h.client}
                </Link>
              ) : (
                <span className="font-semibold text-ink">{h.client}</span>
              )
            ) : (
              'Sin cliente'
            )}
            {h.owner ? ` · responsable ${h.owner}` : ''}
            {h.start ? ` · desde el ${h.start}` : ''}
            {h.due ? ` · entrega ${h.due}` : ''}
            {h.finished ? ` · terminado el ${h.finished}` : ''}
          </p>
          {h.description && (
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-muted">{h.description}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {view.canManage && h.nextStatuses.length > 0 && (
            <label className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
              <span className="sr-only">Mover a</span>
              <select
                className={clsx(FIELD, 'w-auto')}
                value=""
                disabled={status.pending}
                onChange={(e) => {
                  const to = e.target.value;
                  if (to) status.run(() => handlers.update(h.id, { status: to as ProjectStatus }));
                }}
              >
                <option value="">Mover a…</option>
                {h.nextStatuses.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button variant="outline" onClick={() => setLogging(true)}>
            <Timer className="h-4 w-4" aria-hidden />
            Registrar horas
          </Button>
          {view.canManage && view.salesEnabled && view.revenue.unbilledRaw > 0 && (
            <Button
              disabled={invoice.pending}
              onClick={() => invoice.run(() => handlers.invoice(h.id, null))}
            >
              {invoice.pending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Receipt className="h-4 w-4" aria-hidden />
              )}
              Facturar {view.revenue.unbilled}
            </Button>
          )}
        </div>
      </header>
      <div className="mt-3 space-y-2">
        <Feedback result={status.result} />
        <Feedback result={invoice.result} />
      </div>

      {view.alerts.length > 0 && (
        <ul className="mt-5 flex flex-col gap-2" aria-label="Alertas">
          {view.alerts.map((a) => (
            <li
              key={a.label}
              className={clsx(
                'flex items-start gap-2.5 rounded-sm border px-3.5 py-2.5 text-sm',
                a.tone === 'rose' ? 'border-rose/25 bg-rose-soft' : 'border-amber/25 bg-amber-soft',
              )}
            >
              <AlertTriangle
                className={clsx('mt-0.5 h-4 w-4 shrink-0', TONE_TEXT[a.tone])}
                aria-hidden
              />
              <span>
                <span className={clsx('font-bold', TONE_TEXT[a.tone])}>{a.label}.</span>{' '}
                <span className="text-ink">{a.message}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Meter title="Avance" bar={view.bars.progress} />
        <Meter title="Horas" bar={view.bars.hours} />
        <Meter title="Costo" bar={view.bars.cost} />
        <div className="rounded-card border border-border bg-surface px-4 py-3.5 shadow-card">
          <div className="text-xs font-semibold text-ink-muted">Margen</div>
          <div className={clsx('stat-num mt-2 text-lg leading-none', TONE_TEXT[view.margin.tone])}>
            {view.margin.value}
            {view.margin.pct && <span className="ml-2 text-sm">{view.margin.pct}</span>}
          </div>
          <div className="mt-2.5 text-xs leading-snug text-ink-faint">{view.margin.basis}</div>
          <div className="mt-1 text-xs leading-snug text-ink-faint">
            Facturado {view.revenue.invoiced} · falta {view.revenue.unbilled}
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          <TasksSection view={view} handlers={handlers} />
          <TimeSection view={view} handlers={handlers} onLog={() => setLogging(true)} />
          <CostsSection view={view} handlers={handlers} today={today} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <Section icon={<CircleDollarSign className="h-4 w-4" />} title="Rentabilidad">
            <dl className="space-y-2.5 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="font-semibold text-ink">Ingreso</dt>
                <dd className="tabular font-bold text-ink">{view.revenue.amount}</dd>
              </div>
              {view.breakdown.map((b) => (
                <div key={b.key}>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">− {b.label}</dt>
                    <dd className="tabular text-ink">{b.amount}</dd>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-pill bg-surface-2" aria-hidden>
                    <div
                      className="h-full rounded-pill bg-ink-faint/50"
                      style={{ width: `${Math.min(100, b.pct)}%` }}
                    />
                  </div>
                </div>
              ))}
              <div className="flex justify-between gap-3 border-t border-border pt-2.5">
                <dt className="font-bold text-ink">Margen</dt>
                <dd className={clsx('tabular font-bold', TONE_TEXT[view.margin.tone])}>
                  {view.margin.value}
                  {view.margin.pct ? ` · ${view.margin.pct}` : ''}
                </dd>
              </div>
            </dl>
          </Section>
          <MilestonesSection view={view} handlers={handlers} />
          {view.documents.length > 0 && (
            <Section icon={<FileText className="h-4 w-4" />} title="Documentos de ventas">
              <ul className="space-y-2 text-sm">
                {view.documents.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3">
                    <Link href={d.href} className="font-semibold text-ink hover:underline">
                      {d.kind} {d.label}
                    </Link>
                    <span className="tabular text-ink-muted">{d.amount}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section icon={<Users className="h-4 w-4" />} title="Equipo">
            {view.team.length === 0 ? (
              <p className="text-sm text-ink-muted">Nadie ha registrado horas todavía.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {view.team.map((p) => (
                  <li key={p.name} className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-ink">{p.name}</span>
                    <span className="tabular text-ink-muted">
                      {p.hours} · {p.cost}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section icon={<History className="h-4 w-4" />} title="Línea de tiempo">
            <ol className="relative ml-1.5 space-y-3 border-l border-border pl-4 text-sm">
              {view.timeline.map((t, i) => (
                <li key={`${t.date}-${i}`} className="relative">
                  <span
                    className={clsx(
                      'absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface',
                      TONE_BAR[t.tone],
                    )}
                    aria-hidden
                  />
                  <span className="block text-xs font-semibold tabular text-ink-faint">
                    {t.date}
                  </span>
                  <span className="text-ink">{t.label}</span>
                </li>
              ))}
            </ol>
          </Section>
        </div>
      </div>

      {logging && (
        <LogTimeDialog
          projects={[{ id: h.id, label: `${h.code} · ${h.title}` }]}
          fixedProjectId={h.id}
          people={view.canManage ? view.people : undefined}
          today={today}
          onClose={() => setLogging(false)}
          logTime={handlers.logTime}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TasksSection({
  view,
  handlers,
}: { view: ProjectDetailView; handlers: ProjectDetailHandlers }) {
  const act = useAction();
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const open = view.tasks.filter((t) => !t.done && !t.cancelled).length;
  return (
    <Section
      icon={<ClipboardList className="h-4 w-4" />}
      title={`Tareas${view.tasks.length ? ` · ${open} abiertas` : ''}`}
      right={
        <span className="text-xs text-ink-faint">Van al registro de trabajo («Mi semana»)</span>
      }
    >
      {view.tasks.length > 0 && (
        <ul className="mb-4 divide-y divide-border/60">
          {view.tasks.map((t) => (
            <li key={t.id} className="flex items-start gap-3 py-2">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-primary"
                checked={t.done}
                disabled={t.cancelled || act.pending}
                onChange={(e) =>
                  act.run(() => handlers.toggleTask(view.header.id, t.id, e.target.checked))
                }
                aria-label={`Marcar «${t.title}»`}
              />
              <div className="min-w-0 flex-1">
                <p
                  className={clsx(
                    'text-sm',
                    t.done || t.cancelled ? 'text-ink-faint line-through' : 'text-ink',
                  )}
                >
                  {t.title}
                </p>
                <p className="text-xs text-ink-faint">
                  {t.assignee ?? 'Sin responsable'}
                  {t.due && (
                    <span className={clsx(t.late && 'font-semibold text-rose')}>
                      {' '}
                      · {t.late ? 'venció' : 'vence'} el {t.due}
                    </span>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px_150px_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          act.run(
            () =>
              handlers.addTask(view.header.id, {
                title,
                assigneeId: assignee || null,
                dueOn: due || null,
              }),
            () => {
              setTitle('');
              setDue('');
            },
          );
        }}
      >
        <input
          className={FIELD}
          placeholder="Nueva tarea"
          value={title}
          maxLength={300}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Nueva tarea"
        />
        <select
          className={FIELD}
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          aria-label="Responsable"
        >
          <option value="">Sin responsable</option>
          {view.people.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <input
          className={FIELD}
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          aria-label="Vence"
        />
        <Button type="submit" variant="outline" disabled={act.pending || !title.trim()}>
          <Plus className="h-4 w-4" aria-hidden />
          Agregar
        </Button>
      </form>
      {act.result && !act.result.ok && (
        <div className="mt-2">
          <Feedback result={act.result} />
        </div>
      )}
    </Section>
  );
}

function TimeSection({
  view,
  handlers,
  onLog,
}: { view: ProjectDetailView; handlers: ProjectDetailHandlers; onLog: () => void }) {
  const act = useAction();
  return (
    <Section
      icon={<Timer className="h-4 w-4" />}
      title="Horas"
      right={
        <Button variant="ghost" onClick={onLog}>
          <Plus className="h-4 w-4" aria-hidden />
          Registrar
        </Button>
      }
    >
      {view.time.length === 0 ? (
        <p className="text-sm text-ink-muted">
          Todavía no hay horas. Cada quien registra las suyas aquí, en «Mi semana» o diciéndoselo a
          Cortex.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-ink-muted">
                <th className="pb-2">Persona</th>
                <th className="pb-2">Día</th>
                <th className="pb-2 text-right">Horas</th>
                <th className="pb-2 text-right">Costo</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {view.time.map((t) => (
                <tr key={t.id} className="border-t border-border/60">
                  <td className="py-2">
                    <span className="font-semibold text-ink">{t.person}</span>
                    {t.note && <span className="block text-xs text-ink-faint">{t.note}</span>}
                  </td>
                  <td className="py-2 text-ink-muted">{t.date}</td>
                  <td className="py-2 text-right tabular text-ink">
                    {t.hours}
                    {!t.billable && (
                      <span className={clsx(chipClass('neutral'), 'ml-1.5')}>no cobrable</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular text-ink-muted">{t.cost}</td>
                  <td className="py-2 text-right">
                    {t.canDelete && (
                      <button
                        type="button"
                        className="rounded-pill p-1.5 text-ink-faint hover:bg-surface-2 hover:text-rose"
                        disabled={act.pending}
                        onClick={() => act.run(() => handlers.deleteTime(view.header.id, t.id))}
                        aria-label="Borrar registro"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {act.result && !act.result.ok && <Feedback result={act.result} />}
    </Section>
  );
}

function CostsSection({
  view,
  handlers,
  today,
}: { view: ProjectDetailView; handlers: ProjectDetailHandlers; today: string }) {
  const act = useAction();
  const [kind, setKind] = useState<'material' | 'gasto' | 'subcontrato' | 'otro'>('gasto');
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [ledger, setLedger] = useState('');
  const [product, setProduct] = useState('');
  const [qty, setQty] = useState('');
  return (
    <Section icon={<Package className="h-4 w-4" />} title="Materiales y gastos">
      {view.materials.length + view.costs.length === 0 ? (
        <p className="mb-4 text-sm text-ink-muted">Sin materiales ni gastos cargados.</p>
      ) : (
        <ul className="mb-4 divide-y divide-border/60 text-sm">
          {view.materials.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="font-semibold text-ink">{m.product}</span>
                <span className="block text-xs text-ink-faint">
                  Inventario · {m.qty} · {m.date}
                </span>
              </span>
              <span className="tabular text-ink">{m.cost}</span>
            </li>
          ))}
          {view.costs.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="font-semibold text-ink">{c.description}</span>
                <span className="block text-xs text-ink-faint">
                  {c.kind} · {c.from} · {c.date}
                </span>
              </span>
              <span className="tabular text-ink">{c.amount}</span>
            </li>
          ))}
        </ul>
      )}
      {view.canManage && (
        <div className="space-y-3">
          <form
            className="grid gap-2 sm:grid-cols-[140px_minmax(0,1fr)_150px_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              const n = readNumber(amount);
              if (!desc.trim() || n === null)
                return act.setResult({ ok: false, error: 'Describe el costo y su valor.' });
              act.run(
                () =>
                  handlers.addCost(view.header.id, {
                    kind,
                    description: desc,
                    amount: n,
                    date: today,
                    counterparty: null,
                  }),
                () => {
                  setDesc('');
                  setAmount('');
                },
              );
            }}
          >
            <select
              className={FIELD}
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
              aria-label="Tipo de costo"
            >
              {COST_KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              className={FIELD}
              placeholder="Qué fue"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              aria-label="Descripción"
            />
            <input
              className={NUMBER_FIELD}
              placeholder="Valor"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Valor"
            />
            <Button type="submit" variant="outline" disabled={act.pending}>
              <Plus className="h-4 w-4" aria-hidden />
              Cargar
            </Button>
          </form>
          {view.ledgerExpenses.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <select
                className={clsx(FIELD, 'min-w-0 flex-1')}
                value={ledger}
                onChange={(e) => setLedger(e.target.value)}
                aria-label="Gasto del libro de plata"
              >
                <option value="">Atar un gasto del libro de plata…</option>
                {view.ledgerExpenses.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                disabled={!ledger || act.pending}
                onClick={() =>
                  act.run(
                    () => handlers.linkLedger(view.header.id, ledger),
                    () => setLedger(''),
                  )
                }
              >
                Atar
              </Button>
            </div>
          )}
        </div>
      )}
      {view.inventoryEnabled && view.products.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <select
            className={clsx(FIELD, 'min-w-0 flex-1')}
            value={product}
            onChange={(e) => setProduct(e.target.value)}
            aria-label="Material del inventario"
          >
            <option value="">Sacar material del inventario…</option>
            {view.products.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            className={clsx(NUMBER_FIELD, 'w-24')}
            placeholder="Cant."
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            aria-label="Cantidad"
          />
          <Button
            variant="outline"
            disabled={!product || act.pending}
            onClick={() => {
              const n = readNumber(qty);
              if (n === null || n <= 0)
                return act.setResult({ ok: false, error: 'Escribe la cantidad.' });
              act.run(
                () => handlers.consumeMaterial(view.header.id, { product, qty: n }),
                () => {
                  setProduct('');
                  setQty('');
                },
              );
            }}
          >
            Sacar
          </Button>
        </div>
      )}
      <div className="mt-3">
        <Feedback result={act.result} />
      </div>
    </Section>
  );
}

function MilestonesSection({
  view,
  handlers,
}: { view: ProjectDetailView; handlers: ProjectDetailHandlers }) {
  const act = useAction();
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [due, setDue] = useState('');
  return (
    <Section icon={<Flag className="h-4 w-4" />} title="Hitos de facturación">
      {view.milestones.length === 0 ? (
        <p className="text-sm text-ink-muted">
          Sin hitos: se factura todo al terminar
          {view.salesEnabled ? '' : ' (prende Ventas para facturar desde aquí)'}.
        </p>
      ) : (
        <ul className="space-y-2.5 text-sm">
          {view.milestones.map((m) => (
            <li key={m.id} className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="font-semibold text-ink">{m.title}</span>
                <span className="block text-xs text-ink-faint">
                  {m.amount}
                  {m.due ? ` · ${m.due}` : ''}
                </span>
              </span>
              {m.invoiceHref ? (
                <Link
                  href={m.invoiceHref}
                  className={clsx(chipClass(m.statusTone), 'hover:underline')}
                >
                  {m.status}
                </Link>
              ) : m.canInvoice && view.canManage ? (
                <Button
                  variant="outline"
                  disabled={act.pending}
                  onClick={() => act.run(() => handlers.invoice(view.header.id, m.id))}
                >
                  Facturar
                </Button>
              ) : (
                <span className={chipClass(m.statusTone)}>{m.status}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {view.canManage && (
        <form
          className="mt-4 grid grid-cols-[minmax(0,1fr)_120px] gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = readNumber(amount);
            if (!title.trim() || n === null)
              return act.setResult({ ok: false, error: 'Nombre y valor del hito.' });
            act.run(
              () => handlers.addMilestone(view.header.id, { title, amount: n, dueOn: due || null }),
              () => {
                setTitle('');
                setAmount('');
                setDue('');
              },
            );
          }}
        >
          <input
            className={FIELD}
            placeholder="Anticipo 50 %"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Hito"
          />
          <input
            className={NUMBER_FIELD}
            placeholder="Valor"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Valor del hito"
          />
          <input
            className={FIELD}
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            aria-label="Fecha del hito"
          />
          <Button type="submit" variant="outline" disabled={act.pending}>
            <CalendarRange className="h-4 w-4" aria-hidden />
            Agregar hito
          </Button>
        </form>
      )}
      <div className="mt-2">
        <Feedback result={act.result} />
      </div>
    </Section>
  );
}
