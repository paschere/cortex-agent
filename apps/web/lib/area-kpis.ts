import { deltaRatio, formatCompact } from '@/components/charts/scales';
import type { DuePanel, PnlPanel } from '@/lib/finance/dashboard-shape';

/**
 * LAS CIFRAS DE ARRIBA DE CADA ÁREA. Puro: arma, con lo que la página YA leyó,
 * las tarjetas de `AreaKpiStrip`. Si una cifra no está leída (la lectura falló,
 * el módulo no tiene datos), esa tarjeta no sale — nunca se inventa un cero.
 * El dinero va completo en pesos y sólo desde los miles de millones se abrevia
 * (`formatCompact`).
 */

export type KpiTone = 'primary' | 'emerald' | 'amber' | 'sky' | 'rose';

export interface AreaKpi {
  key: string;
  label: string;
  value: string;
  /** Una línea chica bajo la cifra. */
  hint?: string;
  /** A qué pestaña lleva pulsarla. */
  href: string;
  tone?: KpiTone;
  spark?: { values: number[]; labels?: string[]; format?: (n: number) => string };
  delta?: { ratio: number | null; good?: boolean | null; label?: string };
}

const money = (n: number, currency = 'COP') =>
  currency === 'COP' ? formatCompact(n, { money: true }) : `${formatCompact(n)} ${currency}`;

/** Subir es bueno: `DeltaPill` pinta el veredicto del cambio, no la dirección. */
function withVerdict(ratio: number | null, label: string) {
  return { ratio, good: ratio === null ? null : ratio >= 0, label };
}

const plural = (n: number, one: string, many: string) =>
  `${formatCompact(n)} ${n === 1 ? one : many}`;

// --- Plata -----------------------------------------------------------------

interface FinanceInput {
  cash?: { currency: string; total: number } | null;
  weeklyClosing?: Array<{ start: string; closing: number }> | null;
  due?: DuePanel | null;
  pnl?: PnlPanel | null;
  nextTax?: { title: string; dueLabel: string } | null;
}

export function financeKpis(input: FinanceInput): AreaKpi[] {
  const out: AreaKpi[] = [];
  const { cash, weeklyClosing: weeks, due, pnl, nextTax } = input;
  if (cash) {
    const last = weeks?.length ? weeks[weeks.length - 1] : undefined;
    out.push({
      key: 'caja',
      label: 'Caja hoy',
      value: money(cash.total, cash.currency),
      hint: last ? `en ${weeks?.length} semanas: ${money(last.closing, cash.currency)}` : undefined,
      href: '/finance',
      tone: cash.total < 0 ? 'rose' : 'primary',
      spark:
        weeks && weeks.length >= 2
          ? {
              values: weeks.map((w) => w.closing),
              labels: weeks.map((w) => w.start),
              format: (n) => money(n, cash.currency),
            }
          : undefined,
      delta: last ? withVerdict(deltaRatio(last.closing, cash.total), 'proyectado') : undefined,
    });
  }
  if (due) {
    out.push({
      key: 'cobrar',
      label: 'Por cobrar',
      value: money(due.receivable.total, due.currency),
      hint:
        due.receivable.overdue > 0
          ? `${money(due.receivable.overdue, due.currency)} vencido`
          : 'nada vencido',
      href: '/payments',
      tone: due.receivable.overdue > 0 ? 'rose' : 'emerald',
    });
    out.push({
      key: 'pagar',
      label: 'Por pagar',
      value: money(due.payable.total, due.currency),
      hint:
        due.payable.overdue > 0 ? `${money(due.payable.overdue, due.currency)} vencido` : 'al día',
      href: '/pagar',
      tone: due.payable.overdue > 0 ? 'amber' : 'sky',
    });
  }
  if (pnl?.months.length) {
    const focusAt = Math.max(
      0,
      pnl.months.findIndex((m) => m.month === pnl.focus),
    );
    const cur = pnl.months[focusAt];
    const prev = focusAt > 0 ? pnl.months[focusAt - 1] : undefined;
    if (cur) {
      const series = pnl.months.slice(0, focusAt + 1);
      out.push({
        key: 'margen',
        label: 'Margen del mes',
        value: money(cur.margin, pnl.currency),
        href: '/estados',
        tone: cur.margin < 0 ? 'rose' : 'emerald',
        spark:
          series.length >= 2
            ? {
                values: series.map((m) => m.margin),
                labels: series.map((m) => m.month),
                format: (n) => money(n, pnl.currency),
              }
            : undefined,
        delta: prev
          ? withVerdict(deltaRatio(cur.margin, prev.margin), 'vs. mes anterior')
          : undefined,
      });
    }
  }
  if (nextTax) {
    out.push({
      key: 'impuesto',
      label: 'Próximo impuesto',
      value: nextTax.dueLabel,
      hint: nextTax.title,
      href: '/impuestos',
      tone: 'amber',
    });
  }
  return out.slice(0, 5);
}

// --- Clientes --------------------------------------------------------------

interface ClientRowLike {
  invoiced12m: number | null;
  outstanding: number | null;
  overdue: number | null;
}

export function clientsKpis(input: {
  rows: readonly ClientRowLike[];
  pending: number;
  missing?: readonly string[];
}): AreaKpi[] {
  const { rows } = input;
  const sum = (pick: (r: ClientRowLike) => number | null) =>
    rows.reduce((s, r) => s + (pick(r) ?? 0), 0);
  const readable = (pick: (r: ClientRowLike) => number | null) =>
    rows.some((r) => pick(r) !== null);
  const out: AreaKpi[] = [
    {
      key: 'clientes',
      label: 'Clientes',
      value: formatCompact(rows.length),
      hint: input.pending
        ? `${plural(input.pending, 'por confirmar', 'por confirmar')}`
        : 'todos confirmados',
      href: '/clients',
      tone: 'primary',
    },
  ];
  if (readable((r) => r.invoiced12m))
    out.push({
      key: 'facturado',
      label: 'Facturado, 12 meses',
      value: money(sum((r) => r.invoiced12m)),
      href: '/ventas',
      tone: 'emerald',
    });
  if (readable((r) => r.outstanding))
    out.push({
      key: 'saldo',
      label: 'Saldo por cobrar',
      value: money(sum((r) => r.outstanding)),
      href: '/payments',
      tone: 'sky',
    });
  if (readable((r) => r.overdue)) {
    const overdue = sum((r) => r.overdue);
    const clients = rows.filter((r) => (r.overdue ?? 0) > 0).length;
    out.push({
      key: 'vencido',
      label: 'Vencido',
      value: money(overdue),
      hint: clients ? `en ${plural(clients, 'cliente', 'clientes')}` : 'nadie en mora',
      href: '/payments',
      tone: overdue > 0 ? 'rose' : 'emerald',
    });
  }
  return out;
}

// --- Operación ------------------------------------------------------------

export function operationsKpis(input: {
  processes: Array<{ state: 'ok' | 'error' | 'paused' | 'waiting' }>;
  blockedErrands?: number;
}): AreaKpi[] {
  const n = (s: string) => input.processes.filter((p) => p.state === s).length;
  const out: AreaKpi[] = [
    {
      key: 'andando',
      label: 'Procesos andando',
      value: formatCompact(n('ok')),
      hint: `de ${formatCompact(input.processes.length)}`,
      href: '/procesos',
      tone: 'emerald',
    },
    {
      key: 'fallo',
      label: 'Con fallo',
      value: formatCompact(n('error')),
      hint: n('error') ? 'míralos primero' : 'ninguno',
      href: '/procesos',
      tone: n('error') ? 'rose' : 'emerald',
    },
    {
      key: 'espera',
      label: 'Esperando o en pausa',
      value: formatCompact(n('waiting') + n('paused')),
      href: '/procesos',
      tone: 'amber',
    },
  ];
  if (input.blockedErrands !== undefined)
    out.push({
      key: 'encargos',
      label: 'Encargos frenados',
      value: formatCompact(input.blockedErrands),
      hint: input.blockedErrands ? 'esperan una respuesta tuya' : 'ninguno',
      href: '/errands',
      tone: input.blockedErrands ? 'amber' : 'emerald',
    });
  return out;
}

// --- Equipo ----------------------------------------------------------------

export function teamKpis(input: {
  people: number;
  attention: number;
  recognitions: number;
  unassigned: { count: number; overdue: number } | null;
}): AreaKpi[] {
  const out: AreaKpi[] = [
    {
      key: 'personas',
      label: 'Personas con trabajo',
      value: formatCompact(input.people),
      href: '/team',
      tone: 'primary',
    },
    {
      key: 'atencion',
      label: 'Piden atención',
      value: formatCompact(input.attention),
      hint: input.attention ? 'señales con evidencia' : 'sin alertas',
      href: '/team',
      tone: input.attention ? 'amber' : 'emerald',
    },
    {
      key: 'reconocer',
      label: 'Para reconocer',
      value: formatCompact(input.recognitions),
      href: '/team',
      tone: 'emerald',
    },
  ];
  if (input.unassigned)
    out.push({
      key: 'sinresp',
      label: 'Sin responsable',
      value: formatCompact(input.unassigned.count),
      hint: input.unassigned.overdue
        ? `${formatCompact(input.unassigned.overdue)} vencidos`
        : undefined,
      href: '/team',
      tone: input.unassigned.count ? 'rose' : 'emerald',
    });
  return out;
}

// --- Datos -----------------------------------------------------------------

export function dataKpis(input: {
  tables: Array<{ rowCount: number; updatedAt: string; syncs: number }>;
  today: string;
}): AreaKpi[] {
  const { tables } = input;
  const rows = tables.reduce((s, t) => s + t.rowCount, 0);
  const touchedToday = tables.filter((t) => t.updatedAt.slice(0, 10) === input.today).length;
  const synced = tables.filter((t) => t.syncs > 0).length;
  return [
    {
      key: 'tablas',
      label: 'Tablas',
      value: formatCompact(tables.length),
      href: '/trackers',
      tone: 'primary',
    },
    {
      key: 'filas',
      label: 'Filas en total',
      value: formatCompact(rows),
      href: '/trackers',
      tone: 'sky',
    },
    {
      key: 'hoy',
      label: 'Tocadas hoy',
      value: formatCompact(touchedToday),
      hint: touchedToday ? 'con cambios hoy' : 'sin cambios hoy',
      href: '/trackers',
      tone: 'emerald',
    },
    {
      key: 'sync',
      label: 'Se llenan solas',
      value: formatCompact(synced),
      hint: synced ? 'con sincronización' : 'ninguna conectada',
      href: '/integrations',
      tone: 'amber',
    },
  ];
}
