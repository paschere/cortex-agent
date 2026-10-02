import { describe, expect, it, vi } from 'vitest';
import { getTool } from '../index';
import { createPaymentsWorld } from '../payments/__tests__/fake-db';
import { importBankStatement } from '../payments/bank/store';
import { recordPaymentReport } from '../payments/store';
import type { ToolContext } from '../types';
import type { LedgerClassifier } from './categorize';
import './tools';
import { type MovementDraft, refHash } from './shape';
import {
  categorizePending,
  ensureAccount,
  listMovements,
  loadLedger,
  recategorize,
  upsertMovements,
} from './store';
import { syncLedger } from './sync';

/**
 * El libro de plata contra la base de datos (el doble de PostgREST que ya usan
 * Pagos y la tenencia): que re-ingerir no duplica, que el recibo de Siigo y el
 * abono del banco del mismo pago cuentan una vez, que la categoría de una
 * persona no la toca nadie, y que una corrección se vuelve regla.
 */

const ORG = 'org-libro';
const USER = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-10-02';

type Row = Record<string, unknown>;

function world(seed: Record<string, Row[]> = {}) {
  return createPaymentsWorld(
    {
      clients: [
        { id: 'cli-nexa', organization_id: ORG, name: 'Nexa Logística', tax_id: '900123456' },
      ],
      payments: [],
      payment_reports: [],
      document_extractions: [],
      accounting_invoices: [],
      accounting_connections: [],
      ledger_movements: [],
      ledger_accounts: [],
      ledger_category_rules: [],
      ledger_sync_state: [],
      audit_events: [],
      ...seed,
    },
    ORG,
  );
}

function expense(over: Partial<MovementDraft> = {}): MovementDraft {
  return {
    direction: 'out',
    kind: 'expense',
    status: 'settled',
    amount: 2_000_000,
    currency: 'COP',
    date: '2026-10-01',
    settledAt: '2026-10-01',
    description: 'Fletes de septiembre',
    counterpartyName: 'Transportes X',
    source: { kind: 'chat', system: '', ref: `h:${refHash(['fletes'])}` },
    ...over,
  };
}

function ctxFor(w: ReturnType<typeof world>): ToolContext {
  return {
    organizationId: ORG,
    userId: USER,
    agentId: '22222222-2222-4222-8222-222222222222',
    db: w.db,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as ToolContext;
}

const counted = (w: ReturnType<typeof world>) =>
  (w.tables.ledger_movements ?? []).filter(
    (r) => !r.duplicate_of && r.status !== 'cancelled' && !r.excluded_reason,
  );

describe('idempotente', () => {
  it('escribir lo mismo dos veces no duplica, y un cambio actualiza la misma fila', async () => {
    const w = world();
    const first = await upsertMovements(w.db, [expense()]);
    expect(first.inserted).toHaveLength(1);
    const again = await upsertMovements(w.db, [expense()]);
    expect(again).toMatchObject({ inserted: [], updated: [], unchanged: 1 });
    const changed = await upsertMovements(w.db, [expense({ description: 'Fletes de sept.' })]);
    expect(changed.updated).toEqual(first.inserted);
    expect(w.tables.ledger_movements).toHaveLength(1);
    expect(w.tables.ledger_movements?.[0]?.organization_id).toBe(ORG);
  });

  it('lo que no pasa la limpieza sale con su motivo y no tumba el resto', async () => {
    const w = world();
    const out = await upsertMovements(w.db, [
      expense(),
      expense({ currency: 'pesos', source: { kind: 'chat', ref: 'otra' } }),
    ]);
    expect(out.inserted).toHaveLength(1);
    expect(out.rejected[0]?.reason).toMatch(/tres letras/);
  });
});

describe('un movimiento real, contado una vez', () => {
  it('el recibo de Siigo y el abono del banco del mismo pago: manda el banco', async () => {
    const w = world();
    // Siigo reporta el pago; después el extracto trae el mismo abono y el
    // módulo de Pagos los enlaza al mismo pago (0098).
    const siigo = await recordPaymentReport(w.db, {
      source: { kind: 'system', system: 'siigo', readAt: '2026-09-11T00:00:00Z' },
      sourceRef: 'RC-77',
      amount: 4_200_000,
      currency: 'COP',
      paidOn: '2026-09-10',
      clientNit: '900123456',
      invoiceNumber: 'FE-88',
    } as never);
    const bank = await recordPaymentReport(w.db, {
      source: { kind: 'system', system: 'extracto · bancolombia', readAt: '2026-09-12T00:00:00Z' },
      sourceRef: 'h:abono-1',
      amount: 4_200_000,
      currency: 'COP',
      paidOn: '2026-09-10',
      clientNit: '900123456',
      note: 'PAGO PSE NEXA',
    } as never);
    expect(bank.payment?.id).toBe(siigo.payment?.id);

    const result = await syncLedger(w.db, ORG, { today: TODAY, classifier: null });
    expect(result.errors).toEqual([]);
    const rows = w.tables.ledger_movements ?? [];
    expect(rows).toHaveLength(2);
    const primary = rows.find((r) => !r.duplicate_of);
    const duplicate = rows.find((r) => r.duplicate_of);
    expect(primary?.source_kind).toBe('bank');
    expect(primary?.account_id).toBeTruthy();
    expect(duplicate?.source_kind).toBe('accounting');
    expect(duplicate?.duplicate_of).toBe(primary?.id);
    expect(counted(w)).toHaveLength(1);
    // La cuenta del extracto existe aunque se haya importado antes del libro.
    expect(w.tables.ledger_accounts?.[0]).toMatchObject({ name: 'bancolombia', currency: 'COP' });

    // Re-correr no mueve nada.
    await syncLedger(w.db, ORG, { today: TODAY, classifier: null });
    expect(w.tables.ledger_movements).toHaveLength(2);
    expect(counted(w)).toHaveLength(1);
  });

  it('lo dicho en el chat y la salida del extracto se enlazan; manda el banco y conserva la categoría de la persona', async () => {
    const w = world();
    await upsertMovements(w.db, [expense({ category: 'transporte', categorySource: 'person' })]);
    await upsertMovements(w.db, [
      expense({
        date: '2026-10-02',
        counterpartyName: null,
        description: 'PAGO PSE TRANSPORTES X SAS',
        source: { kind: 'bank', system: 'extracto · b', ref: 'd:h:1' },
      }),
    ]);
    const rows = w.tables.ledger_movements ?? [];
    const bank = rows.find((r) => r.source_kind === 'bank');
    const chat = rows.find((r) => r.source_kind === 'chat');
    expect(chat?.duplicate_of).toBe(bank?.id);
    expect(bank?.duplicate_of ?? null).toBeNull();
    expect(counted(w)).toHaveLength(1);
  });

  it('un pago en disputa no cuenta; descartado se anula', async () => {
    const w = world({
      payments: [
        {
          id: 'pay-d',
          organization_id: ORG,
          kind: 'payment',
          amount: 100,
          currency: 'COP',
          paid_on: '2026-09-01',
          state: 'disputed',
          disputed_at: '2026-09-02T00:00:00Z',
          updated_at: '2026-09-02T00:00:00Z',
        },
      ],
      payment_reports: [
        {
          id: 'rep-d',
          organization_id: ORG,
          payment_id: 'pay-d',
          kind: 'payment',
          amount: 100,
          currency: 'COP',
          paid_on: '2026-09-01',
          source_kind: 'manual',
          source_system: null,
          source_ref: null,
          created_at: '2026-09-01T10:00:00Z',
        },
      ],
    });
    await syncLedger(w.db, ORG, { today: TODAY, classifier: null });
    expect(w.tables.ledger_movements?.[0]?.excluded_reason).toBe('disputed');
    expect(counted(w)).toHaveLength(0);
    const { rows } = await listMovements(w.db);
    expect(rows).toHaveLength(0);
  });
});

describe('la sincronización trae cada fuente', () => {
  it('facturas del programa (con lo cobrado inferido) y documentos; lo rechazado se anula', async () => {
    const w = world({
      accounting_connections: [
        { id: 'c1', organization_id: ORG, provider: 'alegra', entities: ['invoices'] },
      ],
      accounting_invoices: [
        {
          id: 'ai-1',
          organization_id: ORG,
          source_system: 'alegra',
          source_ref: '501',
          doc_number: 'FE-501',
          client_nit: '900123456',
          client_id: null,
          counterparty_name: 'Nexa Logística',
          currency: 'COP',
          total: 1_000_000,
          balance: 250_000,
          issued_on: '2026-08-01',
          due_on: '2026-08-31',
          annulled: false,
          synced_at: '2026-10-01T05:00:00.000Z',
        },
      ],
      document_extractions: [
        {
          id: 'ext-p',
          organization_id: ORG,
          doc_type: 'invoice',
          review_state: 'confirmed',
          financial_role: 'payable',
          doc_number: 'C-9',
          counterparty_nit: '811000111',
          counterparty_name: 'Papelería Sur',
          total_amount: 300_000,
          currency: 'COP',
          issued_on: '2026-09-20',
          due_on: '2026-10-20',
          created_at: '2026-09-20T00:00:00Z',
          updated_at: '2026-09-20T00:00:00Z',
        },
      ],
    });
    const first = await syncLedger(w.db, ORG, { today: TODAY, classifier: null });
    expect(first.errors).toEqual([]);
    const rows = w.tables.ledger_movements ?? [];
    expect(rows.map((r) => `${r.kind}:${r.status}:${r.amount}`).sort()).toEqual([
      'income:settled:750000',
      'payable:expected:300000',
      'receivable:expected:1000000',
    ]);
    expect(rows.find((r) => r.kind === 'income')?.category).toBe('ventas');
    expect(rows.find((r) => r.kind === 'payable')?.category).toBe('proveedores');

    // Otra corrida: nada nuevo, nada duplicado.
    await syncLedger(w.db, ORG, { today: TODAY, classifier: null });
    expect(w.tables.ledger_movements).toHaveLength(3);

    // La factura de compra se rechaza: queda anulada en el libro.
    (w.tables.document_extractions?.[0] as Row).review_state = 'rejected';
    await syncLedger(w.db, ORG, { today: TODAY, classifier: null });
    expect(rows.find((r) => r.kind === 'payable')?.status).toBe('cancelled');
  });
});

describe('categorías', () => {
  it('persona > regla de la empresa > serie > memoria > modelo, y el modelo una vez por firma', async () => {
    const w = world();
    await upsertMovements(w.db, [
      expense({
        description: 'XJ servicio',
        counterpartyName: 'Proveedor Raro',
        source: { kind: 'chat', ref: 'a' },
      }),
      expense({
        description: 'XJ servicio',
        counterpartyName: 'Proveedor Raro',
        source: { kind: 'chat', ref: 'b' },
        date: '2026-09-01',
      }),
      expense({
        description: 'PAGO PILA',
        counterpartyName: null,
        source: { kind: 'chat', ref: 'c' },
      }),
      expense({
        description: 'Otra cosa',
        category: 'software',
        categorySource: 'person',
        source: { kind: 'chat', ref: 'd' },
      }),
    ]);
    const rows = w.tables.ledger_movements ?? [];
    const byRef = (ref: string) => rows.find((r) => r.source_ref === ref);
    expect(byRef('c')).toMatchObject({ category: 'nomina', category_source: 'rule' });
    expect(byRef('d')).toMatchObject({ category: 'software', category_source: 'person' });
    expect(byRef('a')?.category ?? null).toBeNull();

    const classifier = vi.fn<LedgerClassifier>(async (items) =>
      Object.fromEntries(items.map((i) => [i.id, 'proveedores'])),
    );
    const counts = await categorizePending(w.db, { classifier });
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(classifier.mock.calls[0]?.[0]).toHaveLength(1);
    expect(counts.byModel).toBe(2);
    expect(byRef('a')).toMatchObject({ category: 'proveedores', category_source: 'model' });
    expect(byRef('d')).toMatchObject({ category: 'software', category_source: 'person' });

    // Una fila nueva con la misma firma: la memoria, sin modelo.
    await upsertMovements(w.db, [
      expense({
        description: 'XJ servicio',
        counterpartyName: 'Proveedor Raro',
        source: { kind: 'chat', ref: 'e' },
        date: '2026-08-01',
      }),
    ]);
    classifier.mockClear();
    const again = await categorizePending(w.db, { classifier });
    expect(again.byMemory).toBe(1);
    expect(classifier).not.toHaveBeenCalled();
  });

  it('recategorizar cambia lo que coincide, respeta a la persona y guarda la regla para lo que llegue', async () => {
    const w = world();
    await upsertMovements(w.db, [
      expense({
        description: 'RAPPI PEDIDO',
        counterpartyName: 'Rappi',
        source: { kind: 'chat', ref: 'r1' },
      }),
      expense({
        description: 'RAPPI almuerzo equipo',
        counterpartyName: 'Rappi',
        category: 'otros_gastos',
        categorySource: 'person',
        source: { kind: 'chat', ref: 'r2' },
      }),
    ]);
    const result = await recategorize(w.db, {
      pattern: 'Rappi',
      category: 'mercadeo',
      createdBy: USER,
    });
    expect(result).toMatchObject({ updated: 1, keptPerson: 1 });
    expect(w.tables.ledger_category_rules).toHaveLength(1);
    expect(w.tables.ledger_category_rules?.[0]).toMatchObject({
      pattern: 'rappi',
      category: 'mercadeo',
      hits: 1,
    });
    const rows = w.tables.ledger_movements ?? [];
    expect(rows.find((r) => r.source_ref === 'r1')).toMatchObject({
      category: 'mercadeo',
      category_source: 'person',
    });
    expect(rows.find((r) => r.source_ref === 'r2')?.category).toBe('otros_gastos');
    // Lo que llega después ya entra con la regla.
    await upsertMovements(w.db, [
      expense({
        description: 'RAPPI ADS',
        counterpartyName: null,
        source: { kind: 'bank', system: 'extracto · b', ref: 'd:9' },
      }),
    ]);
    expect(rows.find((r) => r.source_ref === 'd:9')).toMatchObject({
      category: 'mercadeo',
      category_source: 'rule',
    });
  });
});

describe('caja', () => {
  it('un saldo dicho a mano y un extracto viejo que no lo pisa', async () => {
    const w = world();
    const tool = getTool('ledger.set_balance');
    const out = (await tool?.handler(
      {
        account: 'Bancolombia Corriente',
        balance: 48_300_000,
        currency: 'COP',
        asOf: '2026-10-01',
      },
      ctxFor(w),
    )) as { created: boolean; balance: number };
    expect(out).toMatchObject({ created: true, balance: 48_300_000 });
    const old = await ensureAccount(w.db, {
      name: 'bancolombia  corriente',
      currency: 'COP',
      source: { kind: 'bank', system: 'extracto · bancolombia corriente', ref: 'x' },
      balance: { amount: 10, at: '2026-09-15', source: 'bank' },
    });
    expect(old.balanceUpdated).toBe(false);
    const newer = await ensureAccount(w.db, {
      name: 'Bancolombia corriente',
      currency: 'COP',
      source: { kind: 'bank', system: 'extracto · bancolombia corriente', ref: 'x' },
      balance: { amount: 51_000_000, at: '2026-10-02', source: 'bank' },
    });
    expect(newer.balanceUpdated).toBe(true);
    expect(w.tables.ledger_accounts).toHaveLength(1);
    const ledger = await loadLedger(w.db, { today: TODAY });
    expect(ledger.accounts[0]).toMatchObject({ balance: 51_000_000, balanceAt: '2026-10-02' });
  });

  it('importar un extracto deja abonos, salidas y el saldo final en el libro, sin cambiar Pagos', async () => {
    const w = world();
    const csv = [
      'BANCOLOMBIA',
      'FECHA;DESCRIPCIÓN;SUCURSAL;DCTO.;VALOR;SALDO',
      '01/09/2026;PAGO PSE NEXA FE-88;VIRTUAL;;4.200.000,00;10.200.000,00',
      '02/09/2026;PAGO PILA APORTES EN LINEA;VIRTUAL;;-1.500.000,00;8.700.000,00',
      '03/09/2026;GMF 4X1000;VIRTUAL;;-6.000,00;8.694.000,00',
    ].join('\n');
    const input = {
      bytes: Buffer.from(csv, 'utf8'),
      fileName: 'extracto.csv',
      mime: 'text/csv',
      accountLabel: 'Bancolombia Corriente',
      currency: 'COP',
      createdBy: USER,
    };
    const result = await importBankStatement(w.db, input);
    if (result.status !== 'imported') throw new Error('no importó');
    expect(result.created).toBe(1);
    expect(w.tables.payment_reports).toHaveLength(1);
    expect(result.ledger).toMatchObject({ credits: 1, debits: 2, balanceUpdated: true });
    expect(result.sentence).toMatch(/libro de plata como gastos/);
    const rows = w.tables.ledger_movements ?? [];
    expect(rows.map((r) => `${r.direction}:${r.amount}:${r.category}`).sort()).toEqual([
      'in:4200000:null',
      'out:1500000:nomina',
      'out:6000:bancos_y_financieros',
    ]);
    expect(rows.find((r) => r.direction === 'in')?.link_key).toBe(
      `payment:${(w.tables.payments?.[0] as Row).id}`,
    );
    expect(w.tables.ledger_accounts?.[0]).toMatchObject({
      balance: 8_694_000,
      balance_at: '2026-09-03',
    });

    // Reimportar: nada nuevo en Pagos ni en el libro; la sincronización tampoco duplica el abono.
    await importBankStatement(w.db, input);
    await syncLedger(w.db, ORG, { today: TODAY, classifier: null });
    expect(w.tables.payment_reports).toHaveLength(1);
    expect(w.tables.ledger_movements).toHaveLength(3);
  });
});

describe('las herramientas', () => {
  it('ledger.record deriva su referencia: decir lo mismo dos veces no anota dos', async () => {
    const w = world();
    const tool = getTool('ledger.record');
    const input = {
      direction: 'out',
      amount: 2_000_000,
      currency: 'COP',
      date: '2026-10-01',
      counterpartyName: 'Transportes X',
      description: 'Fletes',
      category: 'transporte',
    };
    const first = (await tool?.handler(input, ctxFor(w))) as { outcome: string; category: string };
    expect(first).toMatchObject({ outcome: 'created', category: 'transporte' });
    const second = (await tool?.handler(
      { ...input, description: 'Fletes de septiembre' },
      ctxFor(w),
    )) as {
      outcome: string;
    };
    expect(second.outcome).toBe('updated');
    expect(w.tables.ledger_movements).toHaveLength(1);
    expect(w.tables.ledger_movements?.[0]).toMatchObject({
      kind: 'expense',
      status: 'settled',
      source_kind: 'chat',
      recorded_by: USER,
      category_source: 'person',
    });
  });

  it('«nos deben 5 M de la FE-88» es una cuenta por cobrar que se enlaza con la de Siigo', async () => {
    const w = world();
    await upsertMovements(w.db, [
      {
        direction: 'in',
        kind: 'receivable',
        status: 'expected',
        amount: 5_000_000,
        outstanding: 5_000_000,
        currency: 'COP',
        date: '2026-09-15',
        dueDate: '2026-10-15',
        description: 'Factura FE-88',
        docNumber: 'FE-88',
        linkKey: 'invoice:in:FE88',
        source: { kind: 'accounting', system: 'siigo', ref: 'invoice:88' },
      },
    ]);
    const out = (await getTool('ledger.record')?.handler(
      {
        direction: 'in',
        amount: 5_000_000,
        currency: 'COP',
        date: '2026-09-15',
        dueDate: '2026-10-15',
        docNumber: 'FE 88',
        description: 'Factura FE-88',
        origin: { kind: 'email', label: 'cartera@nexa.co', ref: 'msg-1' },
      },
      ctxFor(w),
    )) as { duplicateOf: string | null };
    expect(out.duplicateOf).toBe((w.tables.ledger_movements?.[0] as Row).id);
    const mine = w.tables.ledger_movements?.[1];
    expect(mine).toMatchObject({
      kind: 'receivable',
      source_kind: 'document',
      source_system: 'correo · cartera@nexa.co',
    });
  });

  it('ledger.record_batch y su vista previa: la previa no escribe; el lote no duplica', async () => {
    const w = world();
    const rows = [
      {
        direction: 'out',
        amount: 3_000_000,
        currency: 'COP',
        date: '2026-09-05',
        description: 'Arriendo septiembre',
        counterpartyName: 'Inmobiliaria Sur',
        ref: 'fila-2',
      },
      {
        direction: 'out',
        amount: 180_000,
        currency: 'COP',
        date: '2026-09-07',
        description: 'EPM',
        ref: 'fila-3',
      },
    ];
    const origin = { kind: 'sheet', label: 'Gastos 2026' };
    const preview = (await getTool('ledger.preview_batch')?.handler(
      { rows, origin },
      ctxFor(w),
    )) as {
      willCreate: number;
      sample: Array<{ category: string | null }>;
    };
    expect(preview.willCreate).toBe(2);
    expect(preview.sample.map((s) => s.category)).toEqual(['arriendo', 'servicios_publicos']);
    expect(w.tables.ledger_movements ?? []).toHaveLength(0);
    const written = (await getTool('ledger.record_batch')?.handler(
      { rows, origin },
      ctxFor(w),
    )) as { created: number };
    expect(written.created).toBe(2);
    const again = (await getTool('ledger.record_batch')?.handler({ rows, origin }, ctxFor(w))) as {
      created: number;
      unchanged: number;
    };
    expect(again).toMatchObject({ created: 0, unchanged: 2 });
    expect(w.tables.ledger_movements?.[0]?.source_system).toBe('hoja · Gastos 2026');
  });

  it('ledger.query: resumen, categorías, vencimientos y caja, una moneda a la vez', async () => {
    const w = world();
    await upsertMovements(w.db, [
      expense({
        amount: 1_000_000,
        date: '2026-09-10',
        description: 'Nómina septiembre',
        counterpartyName: null,
        source: { kind: 'manual', ref: 'n' },
      }),
      {
        ...expense({ source: { kind: 'manual', ref: 'v' } }),
        direction: 'in',
        kind: 'income',
        amount: 5_000_000,
        date: '2026-09-20',
        description: 'Pago cliente',
        category: 'ventas',
        categorySource: 'person',
      },
      expense({
        amount: 99,
        currency: 'USD',
        date: '2026-09-11',
        source: { kind: 'manual', ref: 'usd' },
      }),
      {
        ...expense({ source: { kind: 'manual', ref: 'p' } }),
        kind: 'payable',
        status: 'expected',
        amount: 700_000,
        outstanding: 700_000,
        date: '2026-09-25',
        dueDate: '2026-09-30',
        settledAt: null,
      },
    ]);
    const query = getTool('ledger.query');
    const summary = (await query?.handler(
      { view: 'summary', from: '2026-09-01', to: '2026-09-30' },
      ctxFor(w),
    )) as {
      totals: Record<string, number>;
      otherCurrencies: string[];
    };
    expect(summary.totals).toMatchObject({
      ingresos: 5_000_000,
      gastos: 1_000_000,
      margen: 4_000_000,
      compras: 700_000,
    });
    expect(summary.otherCurrencies).toEqual(['USD']);
    const cats = (await query?.handler(
      { view: 'by_category', from: '2026-09-01', to: '2026-09-30' },
      ctxFor(w),
    )) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(cats.rows[0]).toMatchObject({ clave: 'nomina', total: 1_000_000 });
    const due = (await query?.handler({ view: 'due' }, ctxFor(w))) as {
      totals: Record<string, number>;
    };
    expect(due.totals.por_pagar_vencido).toBe(700_000);
    const cash = (await query?.handler({ view: 'cash' }, ctxFor(w))) as { guidance: string };
    expect(cash.guidance).toMatch(/No conozco ninguna cuenta/);
  });

  it('ledger.recategorize con un patrón guarda la regla; sin patrón ni movimiento, pregunta', async () => {
    const w = world();
    await upsertMovements(w.db, [
      expense({
        description: 'RAPPI',
        counterpartyName: 'Rappi',
        source: { kind: 'chat', ref: 'x' },
      }),
    ]);
    const tool = getTool('ledger.recategorize');
    const out = (await tool?.handler({ category: 'Mercadeo', pattern: 'rappi' }, ctxFor(w))) as {
      updated: number;
      ruleId: string | null;
    };
    expect(out.updated).toBe(1);
    expect(out.ruleId).toBeTruthy();
    await expect(tool?.handler({ category: 'mercadeo' }, ctxFor(w))).rejects.toThrow(/qué palabra/);
  });
});
