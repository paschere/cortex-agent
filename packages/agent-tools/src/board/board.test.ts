import { describe, expect, it } from 'vitest';
import { budgetVsActual } from '../budget/shape';
import type { PnlMonth } from '../ledger/plans';
import { mergeClasses } from '../statements/classify';
import { incomeStatement } from '../statements/income';
import { computeIndicators } from '../statements/indicators';
import { type BoardInput, composeBoard } from './compose';
import { renderBoardPdf } from './pdf';
import { type BoardContent, boardMarkdown, defaultPeriod, periodLabel } from './shape';
import { writeBoardSummary } from './writer';

const month = (m: string, sales: number, byCategory: Record<string, number>): PnlMonth => {
  const expenses = Object.values(byCategory).reduce((s, v) => s + v, 0);
  return { month: m, sales, otherIncome: 0, expenses, byCategory, margin: sales - expenses };
};

const history = [
  month('2025-09', 40_000_000, { proveedores: 20_000_000, nomina: 8_000_000 }),
  month('2026-08', 45_000_000, { proveedores: 22_000_000, nomina: 9_000_000 }),
  month('2026-09', 50_000_000, { proveedores: 24_000_000, nomina: 9_000_000 }),
];

function input(): BoardInput {
  const classes = mergeClasses(null);
  return {
    period: '2026-09',
    company: 'Demo SAS',
    today: '2026-10-05',
    income: incomeStatement(history, { year: 2026, throughMonth: 9, classes, today: '2026-10-05' }),
    budget: {
      name: 'Presupuesto 2026',
      approved: true,
      vs: budgetVsActual(
        [
          { category: 'ventas', kind: 'ingreso', month: 9, amount: 48_000_000 },
          { category: 'proveedores', kind: 'gasto', month: 9, amount: 20_000_000 },
        ],
        history,
        { year: 2026, today: '2026-09-30' },
      ),
    },
    cash: {
      total: 30_000_000,
      asOf: '2026-10-05',
      lowestWeek: '2026-11-02',
      lowestClosing: -2_000_000,
      endClosing: 10_000_000,
      weeks: 13,
      alerts: [{ severity: 'critical', message: 'La caja queda en rojo la semana del 2 nov.' }],
    },
    working: {
      receivables: { total: 20_000_000, count: 5, overdue: 8_000_000 },
      payables: { total: 12_000_000, count: 3, overdue: 0 },
    },
    indicators: computeIndicators({
      currency: 'COP',
      periodLabel: 'últimos 12 meses',
      months: 12,
      pnlSource: 'Libro',
      revenue: 95_000_000,
      costOfSales: 46_000_000,
      variableExpenses: 0,
      fixedExpenses: 18_000_000,
      operatingIncome: 31_000_000,
      netIncome: 31_000_000,
      invoiced: null,
      purchases: null,
      balance: null,
      receivables: null,
      inventory: null,
      payables: null,
    }),
    balanceBasis: 'aproximado',
    milestones: [{ title: 'Renegociar arriendo', evidence: 'contrato.pdf' }],
    decisions: [{ question: '¿Abrimos la sede de Cali?', resolved: null }],
    obligations: [
      { title: 'Declaración de IVA', dueOn: '2026-10-20', overdue: false, amount: null },
    ],
    gaps: [],
  };
}

describe('compose', () => {
  it('builds every section from the data, with traceable facts', () => {
    const c = composeBoard(input());
    expect(c.sections.map((s) => s.key)).toEqual([
      'resumen',
      'resultados',
      'caja',
      'cartera',
      'indicadores',
      'hitos',
      'riesgos',
      'proximos',
    ]);
    const facts = Object.fromEntries(c.facts.map((f) => [f.key, f]));
    expect(facts.ventas_mes?.display).toBe('$ 50 M');
    expect(facts.ventas_mes_cambio?.display).toBe('+25 %');
    expect(c.fallbackSummary).toHaveLength(5);
    expect(c.nextSteps.join(' ')).toMatch(/Cobrar la cartera vencida/);
    expect(c.nextSteps.join(' ')).toMatch(/Cali/);
    expect(c.sections.find((s) => s.key === 'riesgos')?.lines.join(' ')).toMatch(/IVA/);
    expect(c.sections.find((s) => s.key === 'resultados')?.table?.rows.length).toBeGreaterThan(0);
  });
});

describe('summary writer', () => {
  const c = composeBoard(input());
  const base = {
    company: 'Demo SAS',
    periodLabel: 'septiembre de 2026',
    facts: c.facts,
    sections: c.sections,
    fallback: c.fallbackSummary,
    now: new Date('2026-10-05T12:00:00Z'),
  };

  it('keeps a grounded draft', async () => {
    const lines = [
      'En septiembre las ventas fueron $ 50 M, +25 % frente al año anterior.',
      'El año va bien contra el presupuesto.',
      'La caja está en $ 30 M.',
      'Hay $ 20 M por cobrar.',
      'Hay que decidir la sede de Cali.',
    ];
    const out = await writeBoardSummary(base, async () => lines);
    expect(out.source).toBe('modelo');
    expect(out.lines).toEqual(lines);
  });

  it('falls back to the template when the model invents numbers twice', async () => {
    let calls = 0;
    const out = await writeBoardSummary(base, async () => {
      calls += 1;
      return ['Vendimos $ 77 M.', 'Ganamos 42 %.', 'Todo bien.'];
    });
    expect(calls).toBe(2);
    expect(out.source).toBe('plantilla');
    expect(out.lines).toEqual(c.fallbackSummary);
    expect(out.rejected.length).toBeGreaterThan(0);
  });
});

describe('render', () => {
  const c = composeBoard(input());
  const content: BoardContent = {
    version: 1,
    period: '2026-09',
    periodLabel: periodLabel('2026-09'),
    company: 'Demo SAS',
    generatedAt: '2026-10-05T12:00:00Z',
    summary: c.fallbackSummary,
    summarySource: 'plantilla',
    sections: c.sections,
    facts: c.facts,
    gaps: ['el inventario'],
  };

  it('writes markdown and a branded PDF', () => {
    const md = boardMarkdown(content);
    expect(md).toMatch(/# Informe para socios — septiembre de 2026/);
    expect(md).toMatch(/## Próximos pasos/);
    const pdf = renderBoardPdf(content, { name: 'Demo SAS', primary: '#0f766e', logo: null });
    expect(Buffer.from(pdf.slice(0, 8)).toString('latin1')).toMatch(/^%PDF-1\.4/);
    expect(pdf.length).toBeGreaterThan(2_000);
  });

  it('defaults to the previous month', () => {
    expect(defaultPeriod('2026-10-05')).toBe('2026-09');
    expect(defaultPeriod('2027-01-05')).toBe('2026-12');
  });
});
