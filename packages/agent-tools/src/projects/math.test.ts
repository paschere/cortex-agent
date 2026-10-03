import { describe, expect, it } from 'vitest';
import {
  type ProjectFacts,
  materialCost,
  projectMetrics,
  resolveRate,
  weekStartOf,
  weekTimesheet,
} from './math';
import { canMoveProject, parseProjectNumber, projectCode } from './shape';

const TODAY = '2026-10-03';

function facts(over: Partial<ProjectFacts> = {}, project: Partial<ProjectFacts['project']> = {}) {
  return {
    project: {
      status: 'en_curso',
      budgetAmount: 10_000_000,
      budgetHours: 100,
      contractAmount: 15_000_000,
      dueOn: '2026-10-30',
      currency: 'COP',
      ...project,
    },
    tasks: [],
    time: [],
    costs: [],
    materials: [],
    invoiced: 0,
    ...over,
  } as ProjectFacts;
}

describe('la rentabilidad de un proyecto', () => {
  it('margen = contrato − (horas × costo + materiales + gastos + subcontratos)', () => {
    const m = projectMetrics(
      facts({
        time: [
          { hours: 40, billable: true, costRate: 50_000, billRate: 90_000 },
          { hours: 10, billable: false, costRate: 50_000, billRate: 90_000 },
        ],
        costs: [
          { kind: 'gasto', amount: 500_000 },
          { kind: 'subcontrato', amount: 2_000_000 },
          { kind: 'material', amount: 300_000 },
        ],
        // Salieron 10 unidades a 120.000 y volvió 1.
        materials: [
          { qty: -10, unitCost: 120_000 },
          { qty: 1, unitCost: 120_000 },
        ],
      }),
      TODAY,
    );
    expect(m.costs.labor).toBe(2_500_000);
    expect(m.costs.materials).toBe(1_080_000 + 300_000);
    expect(m.costs.total).toBe(2_500_000 + 1_380_000 + 500_000 + 2_000_000);
    expect(m.revenue.basis).toBe('contrato');
    expect(m.margin.amount).toBe(15_000_000 - 6_380_000);
    expect(m.margin.pct).toBeCloseTo(57.5, 1);
    expect(m.revenue.billableValue).toBe(3_600_000);
  });

  it('si se facturó más que el contrato, el ingreso es lo facturado', () => {
    const m = projectMetrics(facts({ invoiced: 16_000_000 }), TODAY);
    expect(m.revenue.basis).toBe('facturado');
    expect(m.revenue.amount).toBe(16_000_000);
    expect(m.revenue.unbilled).toBe(0);
  });

  it('sin contrato ni factura, el ingreso son las horas cobrables (tiempo y materiales)', () => {
    const m = projectMetrics(
      facts(
        { time: [{ hours: 8, billable: true, costRate: 40_000, billRate: 100_000 }] },
        { contractAmount: null },
      ),
      TODAY,
    );
    expect(m.revenue.basis).toBe('horas');
    expect(m.revenue.amount).toBe(800_000);
    expect(m.margin.amount).toBe(480_000);
  });

  it('sin ninguna base de ingreso no inventa margen', () => {
    const m = projectMetrics(facts({}, { contractAmount: null }), TODAY);
    expect(m.revenue.basis).toBe('ninguno');
    expect(m.margin.amount).toBeNull();
    expect(m.margin.pct).toBeNull();
  });

  it('un margen negativo es una alerta crítica', () => {
    const m = projectMetrics(
      facts({ costs: [{ kind: 'subcontrato', amount: 16_000_000 }] }, { budgetAmount: null }),
      TODAY,
    );
    expect(m.alerts.map((a) => a.kind)).toContain('margen_negativo');
  });

  it('el costo de materiales del inventario resta las devoluciones', () => {
    expect(
      materialCost([
        { qty: -3, unitCost: 1000 },
        { qty: 1, unitCost: 1000 },
        { qty: -2, unitCost: null },
      ]),
    ).toBe(2000);
  });
});

describe('horas y costos contra el presupuesto', () => {
  it('cuenta horas usadas, cobrables, porcentaje y lo que queda', () => {
    const m = projectMetrics(
      facts({
        time: [
          { hours: 60, billable: true, costRate: 0, billRate: null },
          { hours: 15.5, billable: false, costRate: 0, billRate: null },
        ],
      }),
      TODAY,
    );
    expect(m.hours.used).toBe(75.5);
    expect(m.hours.billable).toBe(60);
    expect(m.hours.pct).toBe(75.5);
    expect(m.hours.remaining).toBe(24.5);
    expect(m.alerts.map((a) => a.kind)).not.toContain('horas_excedidas');
  });

  it('pasar las horas presupuestadas avisa', () => {
    const m = projectMetrics(
      facts({ time: [{ hours: 101, billable: true, costRate: 0, billRate: null }] }),
      TODAY,
    );
    expect(m.hours.remaining).toBe(-1);
    expect(m.alerts.find((a) => a.kind === 'horas_excedidas')?.message).toContain('101 h');
  });

  it('sobre el presupuesto de costo es crítico y dice por cuánto', () => {
    const m = projectMetrics(facts({ costs: [{ kind: 'gasto', amount: 11_000_000 }] }), TODAY);
    const a = m.alerts[0];
    expect(a?.kind).toBe('sobre_presupuesto');
    expect(a?.severity).toBe('critical');
    expect(a?.message).toContain('$ 1.000.000 por encima');
  });

  it('en riesgo: ≥ 85 % del presupuesto gastado con menos de 70 % de avance', () => {
    const m = projectMetrics(
      facts({
        costs: [{ kind: 'gasto', amount: 9_000_000 }],
        tasks: [{ status: 'done' }, { status: 'open' }, { status: 'open' }],
      }),
      TODAY,
    );
    expect(m.progress.pct).toBeCloseTo(33.3, 1);
    expect(m.alerts.map((a) => a.kind)).toContain('en_riesgo');
  });

  it('sin presupuesto no hay porcentaje ni alerta de presupuesto', () => {
    const m = projectMetrics(
      facts(
        { costs: [{ kind: 'gasto', amount: 9_000_000 }] },
        { budgetAmount: null, budgetHours: null },
      ),
      TODAY,
    );
    expect(m.costs.pct).toBeNull();
    expect(m.hours.pct).toBeNull();
    expect(
      m.alerts.filter((a) => a.kind === 'sobre_presupuesto' || a.kind === 'en_riesgo'),
    ).toEqual([]);
  });
});

describe('avance, atrasos y lo que falta facturar', () => {
  it('el avance cuenta tareas cerradas sin las canceladas y las vencidas abiertas', () => {
    const m = projectMetrics(
      facts({
        tasks: [
          { status: 'done', dueAt: '2026-09-01' },
          { status: 'open', dueAt: '2026-10-01' },
          { status: 'open', dueAt: '2026-10-03T20:00:00Z' },
          { status: 'cancelled', dueAt: '2026-09-01' },
        ],
      }),
      TODAY,
    );
    expect(m.progress).toMatchObject({ tasksTotal: 3, tasksDone: 1, tasksOpen: 2, lateTasks: 1 });
    expect(m.alerts.map((a) => a.kind)).toContain('tareas_tarde');
  });

  it('un proyecto activo con fecha pasada está atrasado; uno terminado no', () => {
    expect(
      projectMetrics(facts({}, { dueOn: '2026-09-30' }), TODAY).alerts.map((a) => a.kind),
    ).toContain('proyecto_tarde');
    expect(
      projectMetrics(facts({}, { dueOn: '2026-09-30', status: 'facturado' }), TODAY).alerts.map(
        (a) => a.kind,
      ),
    ).not.toContain('proyecto_tarde');
  });

  it('terminado con contrato sin facturar del todo avisa lo que falta', () => {
    const m = projectMetrics(facts({ invoiced: 5_000_000 }, { status: 'terminado' }), TODAY);
    expect(m.revenue.unbilled).toBe(10_000_000);
    expect(m.alerts.find((a) => a.kind === 'sin_facturar')?.message).toContain('$ 10.000.000');
  });
});

describe('la semana de horas', () => {
  it('la semana empieza el lunes', () => {
    expect(weekStartOf('2026-10-03')).toBe('2026-09-28'); // sábado
    expect(weekStartOf('2026-10-04')).toBe('2026-09-28'); // domingo
    expect(weekStartOf('2026-09-28')).toBe('2026-09-28'); // lunes
  });

  it('agrupa por proyecto y día y descarta lo de otras semanas', () => {
    const sheet = weekTimesheet(
      [
        { projectId: 'a', workedOn: '2026-09-28', hours: 4 },
        { projectId: 'a', workedOn: '2026-09-28', hours: 2.5 },
        { projectId: 'b', workedOn: '2026-10-02', hours: 8 },
        { projectId: 'b', workedOn: '2026-10-05', hours: 8 },
      ],
      '2026-09-28',
    );
    expect(sheet.rows.map((r) => [r.projectId, r.total])).toEqual([
      ['b', 8],
      ['a', 6.5],
    ]);
    expect(sheet.dayTotals[0]).toBe(6.5);
    expect(sheet.dayTotals[4]).toBe(8);
    expect(sheet.total).toBe(14.5);
  });
});

describe('tarifas, códigos y estados', () => {
  it('la tarifa de la persona gana a la de la empresa', () => {
    const rates = [
      { userId: null, costRate: 30_000, billRate: 60_000 },
      { userId: 'u1', costRate: 45_000, billRate: null },
    ];
    expect(resolveRate(rates, 'u1')).toEqual({ costRate: 45_000, billRate: null, from: 'persona' });
    expect(resolveRate(rates, 'u2').from).toBe('empresa');
    expect(resolveRate([], 'u2')).toEqual({ costRate: 0, billRate: null, from: 'ninguna' });
  });

  it('código y número', () => {
    expect(projectCode('orden_servicio', 7)).toBe('OS-0007');
    expect(projectCode('proyecto', 12)).toBe('PRY-0012');
    expect(parseProjectNumber('os-0007')).toBe(7);
    expect(parseProjectNumber('PRY 12')).toBe(12);
    expect(parseProjectNumber('Montaje Nexa')).toBeNull();
  });

  it('no se puede facturar algo cotizado', () => {
    expect(canMoveProject('cotizado', 'facturado')).toBe(false);
    expect(canMoveProject('terminado', 'facturado')).toBe(true);
  });
});
