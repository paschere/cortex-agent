import {
  ACTIVE_STATUSES,
  type CostKind,
  FINISHED_STATUSES,
  type MilestoneStatus,
  type ProjectStatus,
  formatHours,
  formatMoney,
  round,
} from './shape';

/**
 * LA CUENTA DE UN PROYECTO (migración 0196) — motor puro.
 *
 * Avance, horas contra presupuesto, costos contra presupuesto, margen y las
 * alertas, a partir de los hechos ya leídos. Nada de base de datos ni de reloj:
 * `today` llega de afuera (día de Bogotá), así que cada número se puede
 * reproducir en una prueba y se explica con los mismos hechos que lo dieron.
 *
 * EL MARGEN. Ingreso − (mano de obra + materiales + gastos + subcontratos +
 * otros), todo antes de IVA:
 *
 *   ingreso      el mayor entre el valor del contrato (o del pedido/cotización
 *                atada) y lo ya facturado; sin ninguno de los dos, el valor
 *                de las horas cobrables (tiempo y materiales). Se dice cuál
 *                base se usó (`revenue.basis`), porque «margen proyectado» y
 *                «margen facturado» no son la misma frase.
 *   mano de obra horas × tarifa de costo congelada al registrar.
 *   materiales   salidas de inventario con el proyecto (−qty × costo
 *                unitario; una devolución resta) + materiales comprados aparte.
 */

export interface ProjectFacts {
  project: {
    status: ProjectStatus;
    budgetAmount: number | null;
    budgetHours: number | null;
    /** Lo que se le cobra, antes de IVA (columna o documento de ventas atado). */
    contractAmount: number | null;
    dueOn: string | null;
    currency: string;
  };
  tasks: ReadonlyArray<{ status: 'open' | 'done' | 'cancelled'; dueAt?: string | null }>;
  time: ReadonlyArray<{
    hours: number;
    billable: boolean;
    costRate: number;
    billRate: number | null;
  }>;
  costs: ReadonlyArray<{ kind: CostKind; amount: number }>;
  /** Movimientos de inventario con el proyecto: qty con signo y costo unitario. */
  materials: ReadonlyArray<{ qty: number; unitCost: number | null }>;
  /** Facturas de ventas del proyecto (antes de IVA), ya sin anuladas. */
  invoiced: number;
  milestones?: ReadonlyArray<{ amount: number; status: MilestoneStatus }>;
}

export type AlertKind =
  | 'sobre_presupuesto'
  | 'en_riesgo'
  | 'horas_excedidas'
  | 'tareas_tarde'
  | 'proyecto_tarde'
  | 'sin_facturar'
  | 'margen_negativo';

export const ALERT_LABEL: Record<AlertKind, string> = {
  sobre_presupuesto: 'Sobre el presupuesto',
  en_riesgo: 'En riesgo de pasarse',
  horas_excedidas: 'Horas excedidas',
  tareas_tarde: 'Tareas tarde',
  proyecto_tarde: 'Atrasado',
  sin_facturar: 'Terminado sin facturar',
  margen_negativo: 'Pierde plata',
};

export interface ProjectAlert {
  kind: AlertKind;
  severity: 'info' | 'warn' | 'critical';
  message: string;
}

export interface ProjectMetrics {
  progress: {
    tasksTotal: number;
    tasksDone: number;
    tasksOpen: number;
    lateTasks: number;
    /** 0–100 por tareas cerradas; nulo sin tareas. */
    pct: number | null;
  };
  hours: {
    used: number;
    billable: number;
    budget: number | null;
    /** 0–100+ de las horas presupuestadas. */
    pct: number | null;
    remaining: number | null;
  };
  costs: {
    labor: number;
    materials: number;
    expenses: number;
    subcontracts: number;
    other: number;
    total: number;
    budget: number | null;
    pct: number | null;
    remaining: number | null;
  };
  revenue: {
    contract: number | null;
    invoiced: number;
    /** Valor de las horas cobrables a su tarifa de venta. */
    billableValue: number;
    basis: 'contrato' | 'facturado' | 'horas' | 'ninguno';
    amount: number;
    /** Lo que falta facturar del ingreso (nunca negativo). */
    unbilled: number;
  };
  margin: { amount: number | null; pct: number | null };
  alerts: ProjectAlert[];
}

/** Riesgo: se gastó ≥ 85 % del presupuesto con menos del 70 % de avance. */
export const RISK_COST_PCT = 85;
export const RISK_PROGRESS_PCT = 70;

const pctOf = (part: number, whole: number | null): number | null =>
  whole && whole > 0 ? round((part / whole) * 100, 1) : null;

/** El día (YYYY-MM-DD) de un vencimiento que puede ser día o instante. */
function dayOf(v: string | null | undefined): string | null {
  if (!v) return null;
  return v.length >= 10 ? v.slice(0, 10) : null;
}

export function materialCost(materials: ProjectFacts['materials']): number {
  let total = 0;
  for (const m of materials) total += -m.qty * (m.unitCost ?? 0);
  return round(total, 2);
}

export function projectMetrics(f: ProjectFacts, today: string): ProjectMetrics {
  const p = f.project;

  // --- Avance ---------------------------------------------------------------
  const live = f.tasks.filter((t) => t.status !== 'cancelled');
  const done = live.filter((t) => t.status === 'done').length;
  const open = live.length - done;
  const lateTasks = live.filter((t) => {
    const d = dayOf(t.dueAt);
    return t.status === 'open' && d !== null && d < today;
  }).length;
  const progressPct = live.length ? round((done / live.length) * 100, 1) : null;

  // --- Horas ----------------------------------------------------------------
  let used = 0;
  let billable = 0;
  let labor = 0;
  let billableValue = 0;
  for (const t of f.time) {
    used += t.hours;
    labor += t.hours * t.costRate;
    if (t.billable) {
      billable += t.hours;
      billableValue += t.hours * (t.billRate ?? 0);
    }
  }
  used = round(used, 2);
  billable = round(billable, 2);

  // --- Costos ---------------------------------------------------------------
  const byKind: Record<CostKind, number> = { material: 0, gasto: 0, subcontrato: 0, otro: 0 };
  for (const c of f.costs) byKind[c.kind] += c.amount;
  const materials = round(materialCost(f.materials) + byKind.material, 2);
  labor = round(labor, 2);
  const total = round(labor + materials + byKind.gasto + byKind.subcontrato + byKind.otro, 2);

  // --- Ingreso --------------------------------------------------------------
  const contract = p.contractAmount && p.contractAmount > 0 ? p.contractAmount : null;
  const invoiced = round(f.invoiced, 2);
  billableValue = round(billableValue, 2);
  let basis: ProjectMetrics['revenue']['basis'] = 'ninguno';
  let amount = 0;
  if (contract !== null && contract >= invoiced) {
    basis = 'contrato';
    amount = contract;
  } else if (invoiced > 0) {
    basis = 'facturado';
    amount = invoiced;
  } else if (billableValue > 0) {
    basis = 'horas';
    amount = billableValue;
  }
  const unbilled = round(Math.max(0, amount - invoiced), 2);

  const marginAmount = amount > 0 ? round(amount - total, 2) : null;
  const marginPct =
    amount > 0 && marginAmount !== null ? round((marginAmount / amount) * 100, 1) : null;

  const metrics: ProjectMetrics = {
    progress: {
      tasksTotal: live.length,
      tasksDone: done,
      tasksOpen: open,
      lateTasks,
      pct: progressPct,
    },
    hours: {
      used,
      billable,
      budget: p.budgetHours,
      pct: pctOf(used, p.budgetHours),
      remaining: p.budgetHours !== null ? round(p.budgetHours - used, 2) : null,
    },
    costs: {
      labor,
      materials,
      expenses: round(byKind.gasto, 2),
      subcontracts: round(byKind.subcontrato, 2),
      other: round(byKind.otro, 2),
      total,
      budget: p.budgetAmount,
      pct: pctOf(total, p.budgetAmount),
      remaining: p.budgetAmount !== null ? round(p.budgetAmount - total, 2) : null,
    },
    revenue: { contract, invoiced, billableValue, basis, amount, unbilled },
    margin: { amount: marginAmount, pct: marginPct },
    alerts: [],
  };
  metrics.alerts = projectAlerts(metrics, p, today);
  return metrics;
}

/** Las alertas, en orden de gravedad. Cada frase lleva sus cifras. */
export function projectAlerts(
  m: Omit<ProjectMetrics, 'alerts'>,
  p: ProjectFacts['project'],
  today: string,
): ProjectAlert[] {
  const out: ProjectAlert[] = [];
  const money = (n: number) => formatMoney(n, p.currency);
  const active = ACTIVE_STATUSES.includes(p.status);
  const finished = FINISHED_STATUSES.includes(p.status);

  if (m.costs.budget !== null && m.costs.total > m.costs.budget) {
    out.push({
      kind: 'sobre_presupuesto',
      severity: 'critical',
      message: `Lleva ${money(m.costs.total)} de costo contra ${money(m.costs.budget)} presupuestados (${money(m.costs.total - m.costs.budget)} por encima).`,
    });
  } else if (
    active &&
    m.costs.pct !== null &&
    m.costs.pct >= RISK_COST_PCT &&
    (m.progress.pct ?? 0) < RISK_PROGRESS_PCT
  ) {
    out.push({
      kind: 'en_riesgo',
      severity: 'warn',
      message: `Ya se gastó el ${m.costs.pct} % del presupuesto con ${m.progress.pct ?? 0} % de avance.`,
    });
  }
  if (m.hours.budget !== null && m.hours.used > m.hours.budget) {
    out.push({
      kind: 'horas_excedidas',
      severity: 'warn',
      message: `${formatHours(m.hours.used)} trabajadas de ${formatHours(m.hours.budget)} presupuestadas.`,
    });
  }
  if (m.margin.amount !== null && m.margin.amount < 0) {
    out.push({
      kind: 'margen_negativo',
      severity: 'critical',
      message: `Con lo que va, pierde ${money(-m.margin.amount)}: cuesta ${money(m.costs.total)} y deja ${money(m.revenue.amount)}.`,
    });
  }
  if (active && p.dueOn && p.dueOn < today) {
    out.push({
      kind: 'proyecto_tarde',
      severity: 'warn',
      message: `Debía terminar el ${p.dueOn} y sigue abierto.`,
    });
  }
  if (!finished && m.progress.lateTasks > 0) {
    out.push({
      kind: 'tareas_tarde',
      severity: 'warn',
      message: `${m.progress.lateTasks} ${m.progress.lateTasks === 1 ? 'tarea vencida' : 'tareas vencidas'} sin cerrar.`,
    });
  }
  if (p.status === 'terminado' && m.revenue.unbilled > 0) {
    out.push({
      kind: 'sin_facturar',
      severity: 'warn',
      message: `Está terminado y faltan ${money(m.revenue.unbilled)} por facturar.`,
    });
  }
  const rank = { critical: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------------------------------------------------------------------------
// La semana de horas de una persona
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function addDaysIso(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** El lunes de la semana de un día (YYYY-MM-DD). */
export function weekStartOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return addDaysIso(day, dow === 0 ? -6 : 1 - dow);
}

export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysIso(start, i));
}

export interface TimesheetRow {
  projectId: string;
  /** Horas por día, lunes a domingo. */
  days: number[];
  total: number;
}

export interface Timesheet {
  start: string;
  days: string[];
  rows: TimesheetRow[];
  /** Total por día. */
  dayTotals: number[];
  total: number;
}

/** Las horas de una semana agrupadas por proyecto y día. */
export function weekTimesheet(
  entries: ReadonlyArray<{ projectId: string; workedOn: string; hours: number }>,
  start: string,
): Timesheet {
  const days = weekDays(start);
  const index = new Map(days.map((d, i) => [d, i]));
  const rows = new Map<string, TimesheetRow>();
  const dayTotals = Array(7).fill(0) as number[];
  for (const e of entries) {
    const i = index.get(e.workedOn.slice(0, 10));
    if (i === undefined) continue;
    const row = rows.get(e.projectId) ?? {
      projectId: e.projectId,
      days: Array(7).fill(0) as number[],
      total: 0,
    };
    row.days[i] = round((row.days[i] ?? 0) + e.hours, 2);
    row.total = round(row.total + e.hours, 2);
    dayTotals[i] = round((dayTotals[i] ?? 0) + e.hours, 2);
    rows.set(e.projectId, row);
  }
  const list = [...rows.values()].sort((a, b) => b.total - a.total);
  return {
    start,
    days,
    rows: list,
    dayTotals,
    total: round(
      list.reduce((s, r) => s + r.total, 0),
      2,
    ),
  };
}

// ---------------------------------------------------------------------------
// La tarifa que aplica
// ---------------------------------------------------------------------------

/** La de la persona, si tiene; si no, la de la empresa; si no, cero. */
export function resolveRate(
  rates: ReadonlyArray<{ userId: string | null; costRate: number; billRate: number | null }>,
  userId: string | null,
): { costRate: number; billRate: number | null; from: 'persona' | 'empresa' | 'ninguna' } {
  const own = userId ? rates.find((r) => r.userId === userId) : undefined;
  if (own) return { costRate: own.costRate, billRate: own.billRate, from: 'persona' };
  const base = rates.find((r) => r.userId === null);
  if (base) return { costRate: base.costRate, billRate: base.billRate, from: 'empresa' };
  return { costRate: 0, billRate: null, from: 'ninguna' };
}
