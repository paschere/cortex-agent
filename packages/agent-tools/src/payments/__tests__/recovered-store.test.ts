import { describe, expect, it } from 'vitest';
import { moneyRecovered, recordBalanceDrops } from '../recovered-store';
import { claimReceivableNotice } from '../risk';
import { createPaymentsWorld } from './fake-db';

/**
 * Plata recuperada: la lectura contra un doble de PostgREST.
 *
 * Las reglas se prueban en recovered.test.ts. Aquí se cuida lo que esa prueba
 * no ve: que cada acción de Cortex se ata a la factura correcta (aviso por su
 * columna, cobro por su proceso de Gerencia), que sólo cuenta lo verificado,
 * que otro espacio no se cuela y que anotar una caída de saldo es idempotente.
 */

const ORG = 'org-andina';
const OTHER = 'org-globex';
const TODAY = '2026-10-01';

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: 'ext-1',
    organization_id: ORG,
    doc_type: 'invoice',
    financial_role: 'receivable',
    review_state: 'confirmed',
    doc_number: 'FV-100',
    counterparty_name: 'Coltrans S.A.S.',
    total_amount: 1_000_000,
    currency: 'COP',
    issued_on: '2026-07-01',
    due_on: '2026-08-01',
    ...over,
  };
}

function payment(over: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    organization_id: ORG,
    kind: 'payment',
    amount: 400_000,
    currency: 'COP',
    paid_on: '2026-09-15',
    extraction_id: 'ext-1',
    invoice_number: 'FV-100',
    state: 'confirmed',
    ...over,
  };
}

function siigo(over: Record<string, unknown> = {}) {
  return {
    id: 'acc-1',
    organization_id: ORG,
    source_system: 'siigo',
    source_ref: 'i-1',
    doc_number: 'FV-2-22',
    client_id: null,
    counterparty_name: 'Andina Ltda.',
    currency: 'COP',
    total: 2_000_000,
    balance: 1_200_000,
    issued_on: '2026-07-15',
    due_on: '2026-08-14',
    annulled: false,
    public_url: null,
    ...over,
  };
}

function world(seed: Record<string, Array<Record<string, unknown>>> = {}) {
  return createPaymentsWorld(
    {
      document_extractions: [],
      payments: [],
      payment_reports: [],
      accounting_invoices: [],
      accounting_connections: [],
      receivable_notices: [],
      receivable_balance_drops: [],
      management_workflows: [],
      management_cases: [],
      actions: [],
      ...seed,
    },
    ORG,
  );
}

describe('la lectura de plata recuperada', () => {
  it('ata un cobro enviado a su factura por el proceso de Gerencia', async () => {
    const w = world({
      document_extractions: [invoice()],
      payments: [payment()],
      management_workflows: [
        {
          id: 'wf-1',
          organization_id: ORG,
          case_id: 'case-1',
          invoice_id: 'ext-1',
          created_at: '2026-09-01T15:00:00Z',
        },
      ],
      actions: [
        {
          id: 'act-1',
          organization_id: ORG,
          kind: 'collect_payment',
          origin_kind: 'manual',
          origin_id: 'wf-1',
          execution_status: 'ok',
          executed_at: '2026-09-03T14:00:00Z',
        },
        // Una propuesta que no salió no es un cobro enviado.
        {
          id: 'act-2',
          organization_id: ORG,
          kind: 'collect_payment',
          origin_kind: 'manual',
          origin_id: 'wf-1',
          execution_status: null,
          executed_at: null,
        },
      ],
    });
    const r = await moneyRecovered(w.db, { today: TODAY });
    expect(r.cop.total).toBe(400_000);
    expect(r.cop.month).toBe(0);
    expect(r.items[0]).toMatchObject({
      invoiceId: 'ext-1',
      docNumber: 'FV-100',
      trigger: { kind: 'collection', id: 'act-1', on: '2026-09-03', caseId: 'case-1' },
    });
  });

  it('el día de la acción es el de Bogotá, no el de UTC', async () => {
    // 2 sep 03:00 UTC = 1 sep 22:00 en Bogotá: un pago del 2 sí cuenta.
    const w = world({
      document_extractions: [invoice()],
      payments: [payment({ paid_on: '2026-09-02' })],
      management_workflows: [
        {
          id: 'wf-1',
          organization_id: ORG,
          case_id: 'case-1',
          invoice_id: 'ext-1',
          created_at: '2026-09-02T03:00:00Z',
        },
      ],
    });
    const r = await moneyRecovered(w.db, { today: TODAY });
    expect(r.items[0]?.trigger).toMatchObject({ kind: 'case', on: '2026-09-01' });
    expect(r.cop.total).toBe(400_000);
  });

  it('un aviso de mora sobre una factura de Siigo cuenta los pagos que Siigo trajo', async () => {
    const w = world({
      accounting_invoices: [siigo()],
      accounting_connections: [
        {
          id: 'conn-1',
          organization_id: ORG,
          provider: 'siigo',
          entities: ['invoices', 'payments'],
        },
      ],
      payments: [payment({ extraction_id: null, invoice_number: 'FV-2-22', amount: 800_000 })],
    });
    expect(
      await claimReceivableNotice(w.db, {
        invoiceId: 'acc-1',
        stage: 30,
        sentOn: '2026-09-13',
        source: 'accounting',
        balance: 2_000_000,
        currency: 'COP',
      }),
    ).toBe(true);
    expect(w.tables.receivable_notices?.[0]).toMatchObject({ balance: 2_000_000, currency: 'COP' });
    const r = await moneyRecovered(w.db, { today: TODAY });
    expect(r.cop.total).toBe(800_000);
    expect(r.items[0]).toMatchObject({ source: 'accounting', system: 'siigo', amount: 800_000 });
  });

  it('lo manual cuenta sólo en un asunto cerrado con verificación', async () => {
    const recovered = { amountCop: 2_500_000, note: 'Multa evitada' };
    const w = world({
      management_cases: [
        {
          id: 'case-ok',
          organization_id: ORG,
          data: { title: 'Sanción DIAN', state: 'verified', recovered },
          updated_at: '2026-09-28T16:00:00Z',
        },
        {
          id: 'case-review',
          organization_id: ORG,
          data: { title: 'Por verificar', state: 'review', recovered },
          updated_at: '2026-09-28T16:00:00Z',
        },
      ],
    });
    const r = await moneyRecovered(w.db, { today: TODAY });
    expect(r.cop.manual).toBe(2_500_000);
    expect(r.manual).toEqual([
      expect.objectContaining({ caseId: 'case-ok', counted: 2_500_000, on: '2026-09-28' }),
    ]);
  });

  it('no ve lo de otro espacio', async () => {
    const w = world({
      document_extractions: [invoice({ organization_id: OTHER })],
      payments: [payment({ organization_id: OTHER })],
      receivable_notices: [
        {
          id: 'n-1',
          organization_id: OTHER,
          extraction_id: 'ext-1',
          accounting_invoice_id: null,
          stage: 1,
          sent_on: '2026-09-01',
          balance: null,
        },
      ],
    });
    expect((await moneyRecovered(w.db, { today: TODAY })).cop.total).toBe(0);
    expect((await moneyRecovered(w.scopedFor(OTHER), { today: TODAY })).cop.total).toBe(400_000);
  });
});

describe('anotar caídas de saldo', () => {
  function noticed(balanceNow: number, over: Record<string, unknown> = {}) {
    return world({
      accounting_invoices: [siigo({ balance: balanceNow, ...over })],
      receivable_notices: [
        {
          id: 'n-1',
          organization_id: ORG,
          extraction_id: null,
          accounting_invoice_id: 'acc-1',
          stage: 1,
          sent_on: '2026-09-20',
          balance: 1_200_000,
          currency: 'COP',
        },
      ],
    });
  }

  it('anota la caída una vez por día y la siguiente parte del último saldo visto', async () => {
    const w = noticed(500_000);
    expect(await recordBalanceDrops(w.db, { today: '2026-09-25' })).toEqual({ recorded: 1 });
    expect(await recordBalanceDrops(w.db, { today: '2026-09-25' })).toEqual({ recorded: 0 });
    expect(w.tables.receivable_balance_drops).toHaveLength(1);
    expect(w.tables.receivable_balance_drops?.[0]).toMatchObject({
      accounting_invoice_id: 'acc-1',
      notice_id: 'n-1',
      balance_before: 1_200_000,
      balance_after: 500_000,
      seen_before_on: '2026-09-20',
      observed_on: '2026-09-25',
    });

    const inv = w.tables.accounting_invoices?.[0];
    if (inv) inv.balance = 0;
    expect(await recordBalanceDrops(w.db, { today: '2026-09-27' })).toEqual({ recorded: 1 });
    expect(w.tables.receivable_balance_drops?.[1]).toMatchObject({
      balance_before: 500_000,
      balance_after: 0,
      seen_before_on: '2026-09-25',
    });

    // El doble no pone ids por defecto; la base sí.
    w.tables.receivable_balance_drops?.forEach((row, i) => {
      row.id ??= `drop-${i + 1}`;
    });
    // Sin pagos traídos por el programa, las caídas son la plata recuperada.
    const r = await moneyRecovered(w.db, { today: '2026-09-30' });
    expect(r.cop.total).toBe(1_200_000);
    expect(r.items[0]?.movements.map((m) => m.counted)).toEqual([700_000, 500_000]);
  });

  it('no anota nada si el saldo no bajó, si la factura se anuló o el mismo día del aviso', async () => {
    expect(await recordBalanceDrops(noticed(1_200_000).db, { today: '2026-09-25' })).toEqual({
      recorded: 0,
    });
    expect(
      await recordBalanceDrops(noticed(0, { annulled: true }).db, { today: '2026-09-25' }),
    ).toEqual({ recorded: 0 });
    expect(await recordBalanceDrops(noticed(0).db, { today: '2026-09-20' })).toEqual({
      recorded: 0,
    });
  });
});
