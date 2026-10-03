import { BUDGET_STATUS_LABEL, LIGHT_LABEL } from '../budget/shape';
import { loadBudgetReport } from '../budget/store';
import type { TrackerField } from '../trackers/schema';
import type { ViewRow } from '../views/compute';
import type { PlatformSource } from '../views/sources';
import { INCOME_LINE_META } from './income';
import { loadStatements } from './store';

/**
 * LAS FUENTES DE VISTAS DE ESTADOS Y PRESUPUESTO (0191).
 *
 * `cortex.estados` y `cortex.presupuesto` dejan armar con estos números una
 * vista propia (el tablero del gerente, un resumen para la junta). Las dos son
 * `internal`: traen resultados, márgenes y la nómina en un total; una vista
 * que las usa no se comparte por enlace (para afuera está el informe para
 * socios, que tiene su propia puerta). La nómina va como la ve quien mira
 * (ledger/privacy.ts).
 */

const field = (
  key: string,
  label: string,
  type: TrackerField['type'],
  options?: string[],
): TrackerField => ({
  key,
  label,
  type,
  required: false,
  ...(options ? { options } : {}),
});

type Values = Record<string, string | number>;

function put(values: Values, key: string, value: string | number | null | undefined) {
  if (value === null || value === undefined) return;
  if (typeof value === 'number' && !Number.isFinite(value)) return;
  if (typeof value === 'string' && value.trim() === '') return;
  values[key] = typeof value === 'string' ? value.trim() : value;
}

function row(id: string, label: string, values: Values, day: string): ViewRow {
  const created = `${day}T00:00:00Z`;
  return { id, label, values, created_at: created, updated_at: created };
}

const SECTIONS = ['Resultados del mes', 'Resultados del año', 'Balance', 'Indicador'];

export const estadosSource: PlatformSource = {
  id: 'cortex.estados',
  name: 'Estados financieros',
  description:
    'Estado de resultados de caja por mes del año (ventas, costo, utilidad bruta, gastos variables y fijos, utilidad operacional, utilidad neta) con el acumulado y el año anterior; el balance (contable o aproximado) y los indicadores (márgenes, liquidez, endeudamiento, días de cartera, inventario y proveedores, punto de equilibrio).',
  sensitivity: 'internal',
  fields: [
    field('seccion', 'Sección', 'select', SECTIONS),
    field('mes', 'Mes', 'text'),
    field('fecha', 'Fecha', 'date'),
    field('renglon', 'Renglón', 'text'),
    field('valor', 'Valor (COP)', 'money'),
    field('anio_anterior', 'Año anterior (COP)', 'money'),
    field('indicador', 'Indicador', 'number'),
    field('como_se_lee', 'Cómo se lee', 'text'),
    field('fuente', 'De dónde sale', 'text'),
  ],
  async read(db, cap, today, ctx) {
    const s = await loadStatements(db, { today, viewerId: ctx.viewerId });
    const rows: ViewRow[] = [];
    for (const m of s.income.months) {
      if (!m.hasData) continue;
      for (const line of INCOME_LINE_META) {
        const v: Values = {};
        put(v, 'seccion', 'Resultados del mes');
        put(v, 'mes', m.month);
        put(v, 'fecha', `${m.month}-01`);
        put(v, 'renglon', line.label);
        put(v, 'valor', m.values[line.key]);
        put(v, 'fuente', line.source);
        rows.push(
          row(`estados:${m.month}:${line.key}`, `${line.label} · ${m.month}`, v, `${m.month}-01`),
        );
      }
    }
    for (const line of INCOME_LINE_META) {
      const v: Values = {};
      put(v, 'seccion', 'Resultados del año');
      put(v, 'mes', `${s.year}`);
      put(v, 'fecha', `${s.year}-01-01`);
      put(v, 'renglon', line.label);
      put(v, 'valor', s.income.ytd[line.key]);
      put(v, 'anio_anterior', s.income.ytdPrev?.[line.key]);
      put(v, 'fuente', line.source);
      rows.push(row(`estados:ytd:${line.key}`, `${line.label} · ${s.year}`, v, `${s.year}-01-01`));
    }
    for (const l of s.balance.lines) {
      const v: Values = {};
      put(v, 'seccion', 'Balance');
      put(v, 'fecha', s.balance.asOf);
      put(v, 'renglon', l.label);
      put(v, 'valor', l.amount);
      put(
        v,
        'como_se_lee',
        s.balance.basis === 'contable'
          ? 'Del programa contable'
          : 'Aproximado (sin programa contable)',
      );
      put(v, 'fuente', l.source);
      rows.push(row(`estados:balance:${l.key}`, l.label, v, s.balance.asOf));
    }
    for (const i of s.indicators) {
      if (i.value === null) continue;
      const v: Values = {};
      put(v, 'seccion', 'Indicador');
      put(v, 'fecha', today);
      put(v, 'renglon', i.label);
      if (i.unit === 'money') put(v, 'valor', i.value);
      else
        put(
          v,
          'indicador',
          i.unit === 'pct' ? Math.round(i.value * 1000) / 10 : Math.round(i.value * 100) / 100,
        );
      put(v, 'como_se_lee', i.display);
      put(v, 'fuente', i.formula);
      rows.push(row(`estados:indicador:${i.key}`, i.label, v, today));
    }
    return { rows: rows.slice(0, cap), truncated: rows.length > cap };
  },
};

export const presupuestoSource: PlatformSource = {
  id: 'cortex.presupuesto',
  name: 'Presupuesto contra lo real',
  description:
    'Por categoría y mes del año: lo presupuestado (el presupuesto aprobado, o el borrador si es lo único que hay), lo real (de caja), la variación y el semáforo.',
  sensitivity: 'internal',
  fields: [
    field('mes', 'Mes', 'text'),
    field('fecha', 'Primer día del mes', 'date'),
    field('categoria', 'Categoría', 'text'),
    field('tipo', 'Tipo', 'select', ['Ingreso', 'Gasto']),
    field('presupuesto', 'Presupuesto (COP)', 'money'),
    field('real', 'Real (COP)', 'money'),
    field('variacion', 'Variación (COP)', 'money'),
    field('semaforo', 'Semáforo', 'select', Object.values(LIGHT_LABEL)),
    field('estado', 'Estado del presupuesto', 'select', Object.values(BUDGET_STATUS_LABEL)),
  ],
  async read(db, cap, today, ctx) {
    const r = await loadBudgetReport(db, {
      year: Number(today.slice(0, 4)),
      today,
      viewerId: ctx.viewerId,
    });
    if (!r.budget || !r.vs) return { rows: [], truncated: false };
    const rows: ViewRow[] = [];
    for (const vr of r.vs.rows) {
      for (const cell of vr.months) {
        const mes = `${r.budget.year}-${String(cell.month).padStart(2, '0')}`;
        const v: Values = {};
        put(v, 'mes', mes);
        put(v, 'fecha', `${mes}-01`);
        put(v, 'categoria', vr.label);
        put(v, 'tipo', vr.kind === 'ingreso' ? 'Ingreso' : 'Gasto');
        put(v, 'presupuesto', cell.budgetToDate);
        put(v, 'real', cell.actual);
        put(v, 'variacion', cell.variance);
        put(v, 'semaforo', LIGHT_LABEL[cell.light]);
        put(v, 'estado', BUDGET_STATUS_LABEL[r.budget.status]);
        rows.push(
          row(`presupuesto:${vr.category}:${cell.month}`, `${vr.label} · ${mes}`, v, `${mes}-01`),
        );
      }
    }
    return { rows: rows.slice(0, cap), truncated: rows.length > cap };
  },
};
