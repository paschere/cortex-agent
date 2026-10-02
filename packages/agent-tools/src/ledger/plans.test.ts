import { describe, expect, it, vi } from 'vitest';
import { getTool } from '../index';
import { createPaymentsWorld } from '../payments/__tests__/fake-db';
import type { ToolContext } from '../types';
import { readPlatformSource } from '../views/sources';
import './forecast-tools';
import './tools';
import { settlePayablesFromBank } from './payables';
import {
  buildForecastInput,
  decideDetectedRecurring,
  declareRecurring,
  deleteScenario,
  detectedRecurring,
  listRecurringDecisions,
  listScenarios,
  monthlyPnl,
  runForecast,
  saveScenario,
} from './plans';
import { PAYROLL_CONFIDENTIAL_KEY, PAYROLL_CONFIDENTIAL_LABEL } from './privacy';
import { type MovementDraft, refHash } from './shape';
import { ensureAccount, upsertMovements } from './store';

/**
 * Los planes sobre la caja contra el doble de PostgREST: escenarios que se
 * guardan y se reemplazan por nombre, recurrentes declarados e ignorados que
 * llegan a la proyección, facturas por pagar que el banco salda (y se
 * reabren), y la nómina que sólo ve con nombres quien administra.
 */

const ORG = 'org-planes';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const TODAY = '2026-10-02';

type Row = Record<string, unknown>;

function world(seed: Record<string, Row[]> = {}) {
  return createPaymentsWorld(
    {
      clients: [],
      payments: [],
      payment_reports: [],
      document_extractions: [],
      accounting_invoices: [],
      accounting_connections: [],
      ledger_movements: [],
      ledger_accounts: [],
      ledger_category_rules: [],
      ledger_sync_state: [],
      ledger_scenarios: [],
      ledger_recurring: [],
      audit_events: [],
      users: [
        { id: ADMIN, organization_id: ORG, role: 'org_admin', email: 'a@x.co' },
        { id: MEMBER, organization_id: ORG, role: 'member', email: 'm@x.co' },
      ],
      ...seed,
    },
    ORG,
  );
}

function ctxFor(w: ReturnType<typeof world>, userId = ADMIN): ToolContext {
  return {
    organizationId: ORG,
    userId,
    agentId: '22222222-2222-4222-8222-222222222222',
    db: w.db,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as ToolContext;
}

const draft = (over: Partial<MovementDraft> & { ref: string }): MovementDraft => {
  const { ref, ...rest } = over;
  return {
    direction: 'out',
    kind: 'expense',
    status: 'settled',
    amount: 1_000_000,
    currency: 'COP',
    date: '2026-09-01',
    settledAt: rest.date ?? '2026-09-01',
    description: 'Movimiento',
    source: { kind: 'manual', system: '', ref: `h:${refHash([ref])}` },
    ...rest,
  };
};

/** Arriendo el 5 de cada mes (abril–septiembre) y nómina de dos personas el 30. */
async function seedHistory(w: ReturnType<typeof world>) {
  const drafts: MovementDraft[] = [];
  for (const m of ['04', '05', '06', '07', '08', '09']) {
    drafts.push(
      draft({
        ref: `arr-${m}`,
        amount: 6_500_000,
        date: `2026-${m}-05`,
        settledAt: `2026-${m}-05`,
        counterpartyName: 'Inmobiliaria Los Andes',
        description: 'Arriendo bodega',
        category: 'arriendo',
        categorySource: 'person',
      }),
      draft({
        ref: `ana-${m}`,
        amount: 3_000_000,
        date: `2026-${m}-28`,
        settledAt: `2026-${m}-28`,
        counterpartyName: 'Ana Ruiz',
        description: 'Pago nómina Ana Ruiz',
        category: 'nomina',
        categorySource: 'person',
      }),
      draft({
        ref: `venta-${m}`,
        direction: 'in',
        kind: 'income',
        amount: 20_000_000,
        date: `2026-${m}-15`,
        settledAt: `2026-${m}-15`,
        counterpartyName: 'Nexa Logística',
        description: 'Abono Nexa',
        category: 'ventas',
        categorySource: 'person',
      }),
    );
  }
  await upsertMovements(w.db, drafts, { skipDedup: true });
  await ensureAccount(w.db, {
    name: 'Bancolombia corriente',
    currency: 'COP',
    source: { kind: 'manual', system: '', ref: 'bancolombia' },
    balance: { amount: 30_000_000, at: TODAY, source: 'manual' },
  });
}

describe('escenarios guardados', () => {
  it('guardar, reemplazar por nombre, listar y borrar', async () => {
    const w = world();
    const first = await saveScenario(w.db, {
      label: 'Nexa se atrasa',
      adjustments: [{ kind: 'delay_counterparty', counterpartyName: 'Nexa', days: 30 }],
      userId: ADMIN,
    });
    const again = await saveScenario(w.db, {
      label: '  nexa se  atrasa ',
      adjustments: [{ kind: 'delay_counterparty', counterpartyName: 'Nexa', days: 45 }],
      userId: ADMIN,
    });
    expect(again.id).toBe(first.id);
    const list = await listScenarios(w.db);
    expect(list).toHaveLength(1);
    expect(list[0]?.adjustments).toEqual([
      { kind: 'delay_counterparty', counterpartyName: 'Nexa', days: 45 },
    ]);
    await deleteScenario(w.db, first.id);
    expect(await listScenarios(w.db)).toEqual([]);
  });

  it('un ajuste sin forma, o ninguno, no se guarda', async () => {
    const w = world();
    await expect(
      saveScenario(w.db, {
        label: 'Mal',
        adjustments: [{ kind: 'scale_category', category: 'nomina', factor: -1 }],
        userId: ADMIN,
      }),
    ).rejects.toThrow('no tiene la forma esperada');
    await expect(
      saveScenario(w.db, { label: 'Vacío', adjustments: [], userId: ADMIN }),
    ).rejects.toThrow('al menos un ajuste');
  });
});

describe('lo que se repite, decidido por una persona', () => {
  it('declarar suma; ignorar un detectado lo saca de la proyección', async () => {
    const w = world();
    await seedHistory(w);
    const detected = await detectedRecurring(w.db, { today: TODAY });
    const rent = detected.find((f) => f.category === 'arriendo');
    expect(rent?.detectedKey).toBeTruthy();

    const credit = await declareRecurring(w.db, {
      label: 'Cuota crédito Bancolombia',
      direction: 'out',
      amount: 2_000_000,
      currency: 'COP',
      every: 'month',
      anchor: 28,
      userId: ADMIN,
    });
    await decideDetectedRecurring(w.db, {
      detectedKey: rent?.detectedKey as string,
      status: 'ignored',
      userId: ADMIN,
      today: TODAY,
    });
    const decisions = await listRecurringDecisions(w.db);
    expect(decisions.map((d) => [d.status, d.label]).sort()).toEqual([
      ['declared', 'Cuota crédito Bancolombia'],
      ['ignored', rent?.label],
    ]);

    const input = await buildForecastInput(w.db, { today: TODAY });
    expect(input.recurring?.map((f) => f.id)).toEqual([credit.id]);
    expect(input.ignoredRecurring).toEqual([rent?.detectedKey]);

    const { base } = await runForecast(w.db, { today: TODAY });
    const items = base.weeks.flatMap((wk) => wk.items);
    expect(items.some((i) => i.category === 'arriendo')).toBe(false);
    expect(items.some((i) => i.label === 'Cuota crédito Bancolombia')).toBe(true);

    // Cambiar de opinión: confirmar la misma llave actualiza la misma fila.
    await decideDetectedRecurring(w.db, {
      detectedKey: rent?.detectedKey as string,
      status: 'confirmed',
      userId: ADMIN,
      today: TODAY,
    });
    expect(w.tables.ledger_recurring).toHaveLength(2);
    const again = await runForecast(w.db, { today: TODAY });
    expect(again.base.weeks.flatMap((wk) => wk.items).some((i) => i.category === 'arriendo')).toBe(
      true,
    );
  });

  it('decidir sobre algo que ya no se detecta lo dice', async () => {
    const w = world();
    await expect(
      decideDetectedRecurring(w.db, {
        detectedKey: 'det-nada',
        status: 'ignored',
        userId: ADMIN,
        today: TODAY,
      }),
    ).rejects.toThrow('Ya no encuentro');
  });

  it('un escenario guardado se compara contra la base', async () => {
    const w = world();
    await seedHistory(w);
    const s = await saveScenario(w.db, {
      label: 'Dos personas más',
      adjustments: [
        {
          kind: 'add_recurring',
          label: 'Dos personas nuevas',
          direction: 'out',
          amount: 9_000_000,
          every: 'month',
          start: '2026-10-30',
        },
      ],
      userId: ADMIN,
    });
    const run = await runForecast(w.db, { today: TODAY, scenarioId: s.id });
    expect(run.scenario?.scenario?.label).toBe('Dos personas más');
    expect(run.comparison?.summary).toMatch(/^Si sale un gasto nuevo de \$ 9 M/);
    // Dos meses de nómina nueva (30 oct y 30 nov) al final del horizonte.
    expect(run.comparison?.weeks.at(-1)?.delta).toBe(-18_000_000);
    await expect(runForecast(w.db, { today: TODAY, scenarioId: 'no-existe' })).rejects.toThrow(
      'No encontré ese escenario',
    );
  });
});

describe('pérdidas y ganancias por mes', () => {
  it('ventas, gastos por categoría y margen; la nómina doblada sin permiso', async () => {
    const w = world();
    await seedHistory(w);
    const detail = await monthlyPnl(w.db, { months: 3, today: TODAY, includePayroll: true });
    expect(detail.map((m) => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(detail[1]).toEqual({
      month: '2026-09',
      sales: 20_000_000,
      otherIncome: 0,
      expenses: 9_500_000,
      byCategory: { arriendo: 6_500_000, nomina: 3_000_000 },
      margin: 10_500_000,
    });
    const folded = await monthlyPnl(w.db, { months: 3, today: TODAY, includePayroll: false });
    expect(folded[1]?.byCategory).toEqual({
      arriendo: 6_500_000,
      [PAYROLL_CONFIDENTIAL_KEY]: 3_000_000,
    });
    expect(folded[2]).toMatchObject({ sales: 0, expenses: 0, margin: 0 });
  });
});

describe('la factura del proveedor que el banco ya pagó', () => {
  const bill: MovementDraft = {
    direction: 'out',
    kind: 'payable',
    status: 'expected',
    amount: 4_000_000,
    outstanding: 4_000_000,
    currency: 'COP',
    date: '2026-09-01',
    dueDate: '2026-09-30',
    counterpartyName: 'Ferretería Central S.A.S.',
    counterpartyTaxId: '900555444',
    description: 'Factura FC-10',
    source: { kind: 'document', system: '', ref: 'extraction:fc-10' },
  };
  const debit: MovementDraft = {
    direction: 'out',
    kind: 'expense',
    status: 'settled',
    amount: 4_010_000,
    currency: 'COP',
    date: '2026-09-29',
    settledAt: '2026-09-29',
    description: 'PAGO PROVEEDOR FERRETERIA CENTRAL',
    source: { kind: 'bank', system: 'extracto · bancolombia', ref: 'd:fc' },
  };

  it('la salda, no la toca dos veces, la defiende de su fuente y la reabre si la salida deja de contar', async () => {
    const w = world();
    await upsertMovements(w.db, [bill, debit], { skipDedup: true });
    expect(await settlePayablesFromBank(w.db)).toEqual({ settled: 1, reopened: 0 });
    const payable = () =>
      w.tables.ledger_movements?.find((r) => r.source_ref === 'extraction:fc-10') as Row;
    const salida = w.tables.ledger_movements?.find((r) => r.source_ref === 'd:fc') as Row;
    expect(payable()).toMatchObject({
      status: 'settled',
      settled_at: '2026-09-29',
      outstanding: 0,
      settled_by: salida.id,
      settled_by_outstanding: 4_000_000,
    });
    expect(await settlePayablesFromBank(w.db)).toEqual({ settled: 0, reopened: 0 });

    // El documento vuelve a llegar abierto: manda el banco.
    await upsertMovements(w.db, [{ ...bill, description: 'Factura FC-10 (releída)' }], {
      skipDedup: true,
    });
    expect(payable()).toMatchObject({ status: 'settled', description: 'Factura FC-10 (releída)' });

    // La salida resulta ser un duplicado: la factura vuelve a estar abierta.
    salida.duplicate_of = 'otra-fila';
    expect(await settlePayablesFromBank(w.db)).toEqual({ settled: 0, reopened: 1 });
    expect(payable()).toMatchObject({
      status: 'expected',
      settled_at: null,
      outstanding: 4_000_000,
      settled_by: null,
    });
  });
});

describe('la nómina es confidencial', () => {
  it('ledger.query: con nombres para quien administra, como total para los demás', async () => {
    const w = world();
    await seedHistory(w);
    const query = getTool('ledger.query');
    const ask = async (userId: string, input: Record<string, unknown>) =>
      (await query?.handler(
        { currency: 'COP', months: 3, limit: 40, ...input },
        ctxFor(w, userId),
      )) as { rows: Array<Record<string, unknown>>; guidance: string };

    const adminPeople = await ask(ADMIN, { view: 'by_counterparty', direction: 'out' });
    expect(adminPeople.rows.map((r) => r.contraparte)).toContain('Ana Ruiz');

    const memberPeople = await ask(MEMBER, { view: 'by_counterparty', direction: 'out' });
    expect(memberPeople.rows.map((r) => r.contraparte)).toContain(PAYROLL_CONFIDENTIAL_LABEL);
    expect(JSON.stringify(memberPeople)).not.toContain('Ana');

    const memberRows = await ask(MEMBER, { view: 'movements' });
    expect(memberRows.rows.some((r) => r.categoria === 'Nómina')).toBe(false);
    expect(memberRows.guidance).toContain('no se muestra fila por fila');
    expect(JSON.stringify(memberRows)).not.toContain('Ana');

    const byName = await ask(MEMBER, { view: 'movements', counterparty: 'Ana' });
    expect(byName.rows).toEqual([]);

    const memberCats = await ask(MEMBER, { view: 'by_category' });
    expect(memberCats.rows.map((r) => r.categoria)).toContain(PAYROLL_CONFIDENTIAL_LABEL);
  });

  it('cortex.libro y cortex.pyg: lo mismo en las vistas', async () => {
    const w = world();
    await seedHistory(w);
    const asMember = await readPlatformSource(w.db, 'cortex.libro', 500, TODAY, {
      viewerId: MEMBER,
    });
    expect(JSON.stringify(asMember?.rows)).not.toContain('Ana');
    const payrollRows = asMember?.rows.filter(
      (r) => r.values.categoria === PAYROLL_CONFIDENTIAL_LABEL,
    );
    // Un total por mes (seis meses), con la misma suma.
    expect(payrollRows).toHaveLength(6);
    expect(payrollRows?.reduce((s, r) => s + Number(r.values.valor), 0)).toBe(18_000_000);

    const asAdmin = await readPlatformSource(w.db, 'cortex.libro', 500, TODAY, {
      viewerId: ADMIN,
    });
    expect(asAdmin?.rows.some((r) => r.values.contraparte === 'Ana Ruiz')).toBe(true);

    const pyg = await readPlatformSource(w.db, 'cortex.pyg', 500, TODAY, { viewerId: null });
    expect(pyg?.rows.some((r) => r.values.categoria === PAYROLL_CONFIDENTIAL_LABEL)).toBe(true);
    expect(pyg?.rows.some((r) => r.values.categoria === 'Nómina')).toBe(false);
  });

  it('cortex.flujo_caja: 13 semanas de la base, y nada sin libro', async () => {
    const empty = await readPlatformSource(world().db, 'cortex.flujo_caja', 100, TODAY, {
      viewerId: null,
    });
    expect(empty?.rows).toEqual([]);
    const w = world();
    await seedHistory(w);
    const read = await readPlatformSource(w.db, 'cortex.flujo_caja', 100, TODAY, {
      viewerId: null,
    });
    expect(read?.rows).toHaveLength(13);
    expect(read?.rows[0]?.values).toMatchObject({ semana: '2026-09-28', abre: 30_000_000 });
    expect(read?.rows.filter((r) => r.values.mas_apretada === 'Sí')).toHaveLength(1);
  });
});

describe('las herramientas de la caja', () => {
  it('ledger.forecast: semana más apretada, alertas, y la comparación con un escenario en el chat', async () => {
    const w = world();
    await seedHistory(w);
    const out = (await getTool('ledger.forecast')?.handler(
      {
        adjustments: [{ kind: 'delay_counterparty', counterpartyName: 'Nexa', days: 30 }],
        scenarioLabel: 'Nexa tarde',
      },
      ctxFor(w, MEMBER),
    )) as {
      weeks: unknown[];
      explanation: string[];
      recurring: Array<{ key: string | null; label: string }>;
      scenario: { comparison: string } | null;
    };
    expect(out.weeks).toHaveLength(13);
    expect(out.explanation[0]).toMatch(/^Caja hoy: \$ 30 M\. La semana más apretada/);
    expect(out.scenario?.comparison).toMatch(/^Si Nexa paga 30 días más tarde/);
    expect(out.recurring.some((r) => r.key?.startsWith('det-'))).toBe(true);
    expect(JSON.stringify(out)).not.toContain('Ana');
  });

  it('ledger.explain_week y ledger.save_scenario', async () => {
    const w = world();
    await seedHistory(w);
    const week = (await getTool('ledger.explain_week')?.handler(
      { week: '2026-10-28' },
      ctxFor(w),
    )) as { weekStart: string; summary: string };
    expect(week.weekStart).toBe('2026-10-26');
    expect(week.summary).toMatch(/^La semana del 26 oct abre con/);

    const saved = (await getTool('ledger.save_scenario')?.handler(
      {
        label: 'Nexa se atrasa',
        adjustments: [{ kind: 'delay_counterparty', counterpartyName: 'Nexa', days: 30 }],
      },
      ctxFor(w),
    )) as { scenarioId: string; guidance: string };
    expect(saved.guidance).toContain('Guardé el escenario «Nexa se atrasa».');
    expect(w.tables.ledger_scenarios).toHaveLength(1);
  });
});
