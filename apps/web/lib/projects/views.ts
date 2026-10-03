import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import {
  PROJECT_ALERT_LABEL,
  PROJECT_COST_KIND_LABEL,
  PROJECT_KIND_LABEL,
  PROJECT_MILESTONE_STATUS_LABEL,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TONE,
  type ProjectAlert,
  type ProjectDetail,
  type ProjectMetrics,
  type ProjectStatus,
  type ProjectSummary,
  type ProjectTimesheet,
  type WonOpportunity,
  canMoveProject,
  formatProjectHours,
  formatProjectMoney,
} from '@cortex/agent-tools';
import type {
  Bar,
  Option,
  ProjectDetailView,
  RateView,
  Tile,
  TimesheetView,
  Tone,
  WonOpportunityView,
} from './shape';

/**
 * DE LOS HECHOS A LO QUE SE DIBUJA EN /proyectos (migración 0196). Sólo
 * servidor: arma columnas, filas, cifras y textos con el motor del paquete.
 */

const money = (n: number, currency = 'COP') => formatProjectMoney(n, currency);
const hours = (n: number) => formatProjectHours(n);
const pctText = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('es-CO')} %`);

const DAY_NAMES = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function shortDay(day: string | null): string | null {
  if (!day) return null;
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return day;
  return `${d} ${MONTHS[m - 1]}${y !== new Date().getUTCFullYear() ? ` ${y}` : ''}`;
}

export const STATUS_OPTIONS: GridColumn['options'] = PROJECT_STATUSES.map((s) => ({
  value: s,
  label: PROJECT_STATUS_LABEL[s],
  tone: PROJECT_STATUS_TONE[s],
}));

const ALERT_TONE: Record<ProjectAlert['severity'], Tone> = {
  critical: 'rose',
  warn: 'amber',
  info: 'neutral',
};

const ALERT_OPTIONS: GridColumn['options'] = [
  ...Object.values(PROJECT_ALERT_LABEL).map((label) => ({
    value: label,
    tone:
      label === 'Sobre el presupuesto' || label === 'Pierde plata'
        ? ('rose' as const)
        : ('amber' as const),
  })),
  { value: 'Al día', tone: 'emerald' as const },
];

export function projectColumns(people: string[]): GridColumn[] {
  return [
    { key: 'codigo', label: 'Código', type: 'text', width: 124 },
    {
      key: 'proyecto',
      label: 'Proyecto',
      type: 'text',
      editable: true,
      required: true,
      pinned: true,
      primary: true,
      width: 260,
    },
    { key: 'cliente', label: 'Cliente', type: 'text', editable: true, width: 170 },
    {
      key: 'tipo',
      label: 'Tipo',
      type: 'select',
      editable: true,
      width: 150,
      options: [
        { value: 'orden_servicio', label: PROJECT_KIND_LABEL.orden_servicio },
        { value: 'proyecto', label: PROJECT_KIND_LABEL.proyecto },
      ],
    },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      editable: true,
      width: 130,
      options: STATUS_OPTIONS,
    },
    {
      key: 'alerta',
      label: 'Alerta',
      type: 'status',
      width: 190,
      options: ALERT_OPTIONS,
      description:
        'La más grave: sobre el presupuesto, pierde plata, en riesgo, horas excedidas, atrasado, tareas tarde o terminado sin facturar.',
    },
    {
      key: 'responsable',
      label: 'Responsable',
      type: 'person',
      width: 150,
      options: people.map((p) => ({ value: p })),
    },
    {
      key: 'avance',
      label: 'Avance',
      type: 'percent',
      width: 100,
      description: 'Tareas cerradas sobre el total (sin las canceladas).',
    },
    { key: 'horas', label: 'Horas', type: 'number', width: 90 },
    { key: 'horas_pres', label: 'Horas pres.', type: 'number', editable: true, width: 110 },
    {
      key: 'costo',
      label: 'Costo',
      type: 'money',
      width: 130,
      description: 'Mano de obra + materiales + gastos + subcontratos.',
    },
    {
      key: 'presupuesto',
      label: 'Presupuesto',
      type: 'money',
      editable: true,
      width: 140,
      description: 'Presupuesto de COSTO.',
    },
    {
      key: 'contrato',
      label: 'Contrato',
      type: 'money',
      editable: true,
      width: 140,
      description: 'Lo que se le cobra al cliente, antes de IVA.',
    },
    { key: 'margen', label: 'Margen', type: 'money', width: 130 },
    { key: 'margen_pct', label: 'Margen %', type: 'percent', width: 100 },
    { key: 'por_facturar', label: 'Por facturar', type: 'money', width: 130 },
    { key: 'inicio', label: 'Inicio', type: 'date', editable: true, width: 110 },
    { key: 'entrega', label: 'Entrega', type: 'date', editable: true, width: 110 },
  ];
}

export function projectRow(s: ProjectSummary): GridRow {
  const p = s.project;
  const m = s.metrics;
  return {
    id: p.id,
    href: `/proyectos/${p.id}`,
    values: {
      codigo: p.code,
      proyecto: p.title,
      cliente: p.client_name,
      tipo: p.kind,
      estado: p.status,
      alerta: m.alerts[0] ? PROJECT_ALERT_LABEL[m.alerts[0].kind] : 'Al día',
      responsable: s.ownerName,
      avance: m.progress.pct,
      horas: m.hours.used,
      horas_pres: m.hours.budget,
      costo: m.costs.total,
      presupuesto: m.costs.budget,
      contrato: m.revenue.contract,
      margen: m.margin.amount,
      margen_pct: m.margin.pct,
      por_facturar: m.revenue.unbilled || null,
      inicio: p.start_on,
      entrega: p.due_on,
    },
  };
}

const AGGREGATES: GridView['aggregates'] = {
  avance: 'avg',
  horas_pres: 'sum',
  margen_pct: 'avg',
};

export function projectPresets(): Array<{ id: string; label: string; view: Partial<GridView> }> {
  const active = {
    key: 'estado',
    op: 'in' as const,
    value: ['cotizado', 'abierto', 'en_curso', 'en_pausa', 'terminado'],
  };
  return [
    {
      id: 'lista',
      label: 'Lista',
      view: {
        layout: 'table',
        filters: [active],
        sort: [{ key: 'codigo', dir: 'desc' }],
        aggregates: AGGREGATES,
      },
    },
    {
      id: 'tablero',
      label: 'Tablero',
      view: {
        layout: 'board',
        layoutKey: 'estado',
        filters: [{ key: 'estado', op: 'not_in', value: ['cancelado'] }],
        sort: [{ key: 'entrega', dir: 'asc' }],
      },
    },
    {
      id: 'calendario',
      label: 'Calendario de entregas',
      view: { layout: 'calendar', layoutKey: 'entrega', filters: [active], sort: [] },
    },
    {
      id: 'alertas',
      label: 'Con alertas',
      view: {
        layout: 'table',
        filters: [{ key: 'alerta', op: 'neq', value: 'Al día' }],
        sort: [{ key: 'margen', dir: 'asc' }],
        aggregates: AGGREGATES,
      },
    },
    {
      id: 'todos',
      label: 'Todos',
      view: {
        layout: 'table',
        filters: [],
        sort: [{ key: 'codigo', dir: 'desc' }],
        aggregates: AGGREGATES,
      },
    },
  ];
}

export function projectTiles(list: ProjectSummary[], weekHours: number): Tile[] {
  const active = list.filter((s) => ['abierto', 'en_curso', 'en_pausa'].includes(s.project.status));
  const late = active.filter((s) =>
    s.metrics.alerts.some((a) => a.kind === 'proyecto_tarde' || a.kind === 'tareas_tarde'),
  );
  const over = list.filter((s) =>
    s.metrics.alerts.some((a) => a.kind === 'sobre_presupuesto' || a.kind === 'margen_negativo'),
  );
  const unbilled = list.filter(
    (s) => s.project.status === 'terminado' && s.metrics.revenue.unbilled > 0,
  );
  const unbilledAmount = unbilled.reduce((sum, s) => sum + s.metrics.revenue.unbilled, 0);
  const withRevenue = active.filter((s) => s.metrics.margin.amount !== null);
  const rev = withRevenue.reduce((sum, s) => sum + s.metrics.revenue.amount, 0);
  const margin = withRevenue.reduce((sum, s) => sum + (s.metrics.margin.amount ?? 0), 0);
  return [
    {
      label: 'En marcha',
      value: String(active.length),
      note: `${list.filter((s) => s.project.status === 'cotizado').length} cotizados · ${hours(weekHours)} esta semana`,
      tone: 'primary',
    },
    {
      label: 'Atrasados',
      value: String(late.length),
      note: late.length
        ? late
            .slice(0, 2)
            .map((s) => s.project.code)
            .join(', ')
        : 'Nada vencido',
      tone: late.length ? 'amber' : 'emerald',
    },
    {
      label: 'Sobre el presupuesto',
      value: String(over.length),
      note: over.length
        ? over
            .slice(0, 2)
            .map((s) => s.project.code)
            .join(', ')
        : 'Todo dentro de lo previsto',
      tone: over.length ? 'rose' : 'emerald',
    },
    {
      label: 'Terminado sin facturar',
      value: money(unbilledAmount),
      note: unbilled.length
        ? `${unbilled.length} ${unbilled.length === 1 ? 'proyecto' : 'proyectos'}`
        : 'Todo facturado',
      tone: unbilled.length ? 'amber' : 'neutral',
    },
    {
      label: 'Margen proyectado',
      value: rev > 0 ? `${Math.round((margin / rev) * 1000) / 10} %` : '—',
      note: rev > 0 ? `${money(margin)} sobre ${money(rev)} en marcha` : 'Sin contratos con valor',
      tone: rev > 0 ? (margin < 0 ? 'rose' : 'emerald') : 'neutral',
    },
  ];
}

export function wonOpportunityViews(list: WonOpportunity[]): WonOpportunityView[] {
  return list.map((o) => ({
    id: o.id,
    title: o.title,
    client: o.clientName,
    value: o.value !== null ? money(o.value, o.currency) : null,
    wonAt: shortDay(o.wonAt.slice(0, 10)) ?? o.wonAt,
  }));
}

// ---------------------------------------------------------------------------
// Semana de horas
// ---------------------------------------------------------------------------

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function timesheetView(
  sheet: ProjectTimesheet,
  rows: Array<{ key: string; label: string; href?: string | null; days: number[]; total: number }>,
  opts: { today: string; hrefFor: (start: string) => string },
): TimesheetView {
  const h = (n: number) => (n ? n.toLocaleString('es-CO', { maximumFractionDigits: 2 }) : '');
  const next = addDays(sheet.start, 7);
  const end = addDays(sheet.start, 6);
  return {
    start: sheet.start,
    days: sheet.days,
    today: opts.today,
    dayLabels: sheet.days.map((d, i) => `${DAY_NAMES[i]} ${Number(d.slice(8, 10))}`),
    rows: rows.map((r) => ({
      key: r.key,
      label: r.label,
      href: r.href ?? null,
      days: r.days.map(h),
      total: hours(r.total),
    })),
    dayTotals: sheet.dayTotals.map(h),
    total: hours(sheet.total),
    prevHref: opts.hrefFor(addDays(sheet.start, -7)),
    nextHref: next <= opts.today ? opts.hrefFor(next) : null,
    weekLabel: `${shortDay(sheet.start)} – ${shortDay(end)}`,
  };
}

export function rateViews(
  people: Array<{ id: string; name: string }>,
  rates: Array<{
    userId: string | null;
    costRate: number;
    billRate: number | null;
    source: 'manual' | 'nomina';
  }>,
  monthHours: Map<string, number>,
): RateView[] {
  const base = rates.find((r) => r.userId === null);
  return [
    {
      userId: null,
      name: 'Toda la empresa (por defecto)',
      costRate: base?.costRate ?? null,
      billRate: base?.billRate ?? null,
      source: base?.source ?? null,
      hoursThisMonth: '',
    },
    ...people.map((p) => {
      const r = rates.find((x) => x.userId === p.id);
      return {
        userId: p.id,
        name: p.name,
        costRate: r?.costRate ?? null,
        billRate: r?.billRate ?? null,
        source: r?.source ?? null,
        hoursThisMonth: monthHours.get(p.id) ? hours(monthHours.get(p.id) as number) : '',
      };
    }),
  ];
}

// ---------------------------------------------------------------------------
// El detalle
// ---------------------------------------------------------------------------

function bar(pct: number | null, label: string, note: string, invert = false): Bar {
  const tone: Tone =
    pct === null
      ? 'neutral'
      : pct > 100
        ? 'rose'
        : pct >= 85
          ? invert
            ? 'emerald'
            : 'amber'
          : invert
            ? 'primary'
            : 'emerald';
  return { pct, tone, label, note };
}

const BASIS_LABEL: Record<ProjectMetrics['revenue']['basis'], string> = {
  contrato: 'Proyectado sobre el valor del contrato',
  facturado: 'Sobre lo facturado',
  horas: 'Sobre las horas cobrables',
  ninguno: 'Sin contrato, facturas ni horas cobrables',
};

export function detailView(
  d: ProjectDetail,
  opts: {
    today: string;
    viewerId: string;
    canManage: boolean;
    salesEnabled: boolean;
    inventoryEnabled: boolean;
    ledgerExpenses: Array<{ id: string; date: string; description: string; amount: number }>;
    products: Option[];
  },
): ProjectDetailView {
  const p = d.project;
  const m = d.metrics;
  const cur = p.currency;
  const name = (id: string | null, label?: string | null) =>
    id ? (d.names[id] ?? 'Alguien') : (label ?? 'Sin nombre');

  const teamMap = new Map<string, { hours: number; cost: number }>();
  for (const t of d.time) {
    const key = name(t.userId, t.personLabel);
    const row = teamMap.get(key) ?? { hours: 0, cost: 0 };
    row.hours += t.hours;
    row.cost += t.hours * t.costRate;
    teamMap.set(key, row);
  }
  if (p.owner_id && !teamMap.has(name(p.owner_id)))
    teamMap.set(name(p.owner_id), { hours: 0, cost: 0 });

  const parts = [
    { key: 'labor', label: 'Mano de obra', raw: m.costs.labor },
    { key: 'materials', label: 'Materiales', raw: m.costs.materials },
    { key: 'expenses', label: 'Gastos', raw: m.costs.expenses },
    { key: 'subcontracts', label: 'Subcontratos', raw: m.costs.subcontracts },
    { key: 'other', label: 'Otros', raw: m.costs.other },
  ];
  const scale = Math.max(m.costs.total, m.revenue.amount, 1);

  const timeline: ProjectDetailView['timeline'] = [];
  timeline.push({ date: p.created_at.slice(0, 10), label: `Se abrió ${p.code}`, tone: 'neutral' });
  if (p.start_on) timeline.push({ date: p.start_on, label: 'Inicio', tone: 'primary' });
  for (const t of d.tasks)
    if (t.status === 'done' && t.doneAt)
      timeline.push({
        date: t.doneAt.slice(0, 10),
        label: `Tarea cerrada: ${t.title}`,
        tone: 'emerald',
      });
  for (const doc of d.salesDocs)
    timeline.push({
      date: doc.issueDate,
      label: `${doc.kind === 'invoice' ? 'Factura' : doc.kind === 'order' ? 'Pedido' : 'Cotización'} ${doc.label}`,
      tone: 'primary',
    });
  if (p.due_on)
    timeline.push({
      date: p.due_on,
      label: 'Entrega acordada',
      tone: p.due_on < opts.today && !p.finished_on ? 'rose' : 'amber',
    });
  if (p.finished_on) timeline.push({ date: p.finished_on, label: 'Terminado', tone: 'emerald' });
  timeline.sort((a, b) => a.date.localeCompare(b.date));

  const docKind: Record<string, string> = {
    quote: 'Cotización',
    order: 'Pedido',
    invoice: 'Factura',
  };
  return {
    header: {
      id: p.id,
      code: p.code,
      title: p.title,
      kindLabel: PROJECT_KIND_LABEL[p.kind],
      status: p.status,
      statusLabel: PROJECT_STATUS_LABEL[p.status],
      statusTone: PROJECT_STATUS_TONE[p.status],
      client: p.client_name,
      clientHref: p.client_id ? `/clients/${p.client_id}` : null,
      owner: p.owner_id ? (d.names[p.owner_id] ?? null) : null,
      start: shortDay(p.start_on),
      due: shortDay(p.due_on),
      finished: shortDay(p.finished_on),
      location: p.location,
      description: p.description,
      nextStatuses: PROJECT_STATUSES.filter(
        (s) => s !== p.status && canMoveProject(p.status, s as ProjectStatus),
      ).map((s) => ({
        value: s,
        label: PROJECT_STATUS_LABEL[s],
      })),
    },
    bars: {
      progress: bar(
        m.progress.pct,
        m.progress.pct === null ? 'Sin tareas' : `${m.progress.pct} %`,
        `${m.progress.tasksDone} de ${m.progress.tasksTotal} tareas${m.progress.lateTasks ? ` · ${m.progress.lateTasks} tarde` : ''}`,
        true,
      ),
      hours: bar(
        m.hours.pct,
        hours(m.hours.used),
        m.hours.budget !== null
          ? `de ${hours(m.hours.budget)} presupuestadas`
          : 'sin horas presupuestadas',
      ),
      cost: bar(
        m.costs.pct,
        money(m.costs.total, cur),
        m.costs.budget !== null
          ? `de ${money(m.costs.budget, cur)} presupuestados`
          : 'sin presupuesto de costo',
      ),
    },
    margin: {
      value: m.margin.amount === null ? '—' : money(m.margin.amount, cur),
      pct: m.margin.pct === null ? null : pctText(m.margin.pct),
      basis: BASIS_LABEL[m.revenue.basis],
      tone:
        m.margin.amount === null
          ? 'neutral'
          : m.margin.amount < 0
            ? 'rose'
            : (m.margin.pct ?? 0) < 15
              ? 'amber'
              : 'emerald',
    },
    revenue: {
      amount: money(m.revenue.amount, cur),
      invoiced: money(m.revenue.invoiced, cur),
      unbilled: money(m.revenue.unbilled, cur),
      unbilledRaw: m.revenue.unbilled,
    },
    breakdown: parts.map((x) => ({
      ...x,
      amount: money(x.raw, cur),
      pct: Math.round((x.raw / scale) * 1000) / 10,
    })),
    alerts: m.alerts.map((a) => ({
      label: PROJECT_ALERT_LABEL[a.kind],
      message: a.message,
      tone: ALERT_TONE[a.severity],
    })),
    tasks: d.tasks
      .map((t) => {
        const due = t.dueAt ? t.dueAt.slice(0, 10) : null;
        return {
          id: t.id,
          title: t.title,
          done: t.status === 'done',
          cancelled: t.status === 'cancelled',
          assignee: t.assigneeId ? (d.names[t.assigneeId] ?? null) : t.assigneeLabel,
          due: shortDay(due),
          late: t.status === 'open' && !!due && due < opts.today,
        };
      })
      .sort((a, b) => Number(a.done || a.cancelled) - Number(b.done || b.cancelled)),
    time: d.time.slice(0, 60).map((t) => ({
      id: t.id,
      person: name(t.userId, t.personLabel),
      date: shortDay(t.workedOn) ?? t.workedOn,
      hours: hours(t.hours),
      billable: t.billable,
      cost: money(t.hours * t.costRate, cur),
      note: t.note,
      canDelete: opts.canManage || t.userId === opts.viewerId,
    })),
    costs: d.costs.map((c) => ({
      id: c.id,
      kind: PROJECT_COST_KIND_LABEL[c.kind],
      description: c.description,
      amount: money(c.amount, cur),
      date: shortDay(c.incurredOn) ?? c.incurredOn,
      from: c.source === 'libro' ? 'Libro de plata' : c.source === 'chat' ? 'Chat' : 'A mano',
    })),
    materials: d.materials.map((x) => ({
      id: x.id,
      product: x.productName,
      qty: `${(-x.qty).toLocaleString('es-CO')} ${x.unit}`,
      cost: money(-x.qty * (x.unitCost ?? 0), cur),
      date: shortDay(x.occurredOn) ?? x.occurredOn,
    })),
    milestones: d.milestones.map((ms) => ({
      id: ms.id,
      title: ms.title,
      amount: money(ms.amount, cur),
      due: shortDay(ms.dueOn),
      status: PROJECT_MILESTONE_STATUS_LABEL[ms.status],
      statusTone:
        ms.status === 'facturado'
          ? 'emerald'
          : ms.status === 'cancelado'
            ? 'rose'
            : ms.status === 'listo'
              ? 'amber'
              : 'neutral',
      invoiceHref: ms.salesDocumentId ? `/ventas/${ms.salesDocumentId}` : null,
      canInvoice: opts.salesEnabled && (ms.status === 'pendiente' || ms.status === 'listo'),
    })),
    documents: d.salesDocs.map((doc) => ({
      id: doc.id,
      label: doc.label,
      kind: docKind[doc.kind] ?? doc.kind,
      status: doc.status,
      amount: money(doc.amount, cur),
      href: `/ventas/${doc.id}`,
    })),
    team: [...teamMap.entries()]
      .sort((a, b) => b[1].hours - a[1].hours)
      .map(([n, v]) => ({ name: n, hours: hours(v.hours), cost: money(v.cost, cur) })),
    timeline,
    people: Object.entries(d.names).map(([value, label]) => ({ value, label })),
    ledgerExpenses: opts.ledgerExpenses.map((e) => ({
      id: e.id,
      label: `${shortDay(e.date)} · ${e.description.slice(0, 60)} · ${money(e.amount, cur)}`,
    })),
    products: opts.products,
    canManage: opts.canManage,
    salesEnabled: opts.salesEnabled,
    inventoryEnabled: opts.inventoryEnabled,
  };
}
