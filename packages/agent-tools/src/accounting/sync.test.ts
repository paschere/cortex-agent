import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { ImportSystemPaymentsInput, ImportSystemPaymentsResult } from '../payments/import';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { siigoProvider } from './providers/siigo';
import type { AccountingConnectionRow } from './store';
import { finishedCursor, noticeFor, planEntity, runAccountingSync } from './sync';
import type {
  AccountingEntity,
  NormalizedRecord,
  ProviderPage,
  ProviderQuery,
  ProviderSession,
} from './types';

/**
 * Una corrida contra una base de mentira y un Siigo de mentira que ya habla la
 * forma común. Lo que se mira: qué tablas y filas quedan, qué entra a la
 * cartera y a Pagos, qué cursor queda, y que correr dos veces no cambia nada.
 * Lo que NO se prueba aquí: Siigo de verdad (ver providers/siigo.test.ts) ni
 * Postgres de verdad (ver accounting.sql-test.mjs).
 */

const ORG = 'org-andina';
const ADMIN = '11111111-1111-4111-a111-111111111111';
type Row = Record<string, unknown>;

let seq = 0;
/** La base: ids y fechas por defecto, y el índice único de la clave externa. */
function world(seed: Record<string, Row[]> = {}) {
  const fake = createFakeSupabase({ clients: [], ...seed });
  const from = fake.client.from.bind(fake.client);
  const raw = {
    ...fake.client,
    rpc: fake.client.rpc,
    from: (table: string) => {
      // biome-ignore lint/suspicious/noExplicitAny: envuelve el builder del doble
      const qb = from(table) as any;
      const insert = qb.insert.bind(qb);
      qb.insert = (values: Row | Row[]) => {
        const list: Row[] = (Array.isArray(values) ? values : [values]).map((r) => ({
          id: `${table}-${++seq}`,
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-01T00:00:00Z',
          ...r,
        }));
        if (table === 'tracker_rows') {
          const rows = (fake.tables.tracker_rows ?? []) as Row[];
          const clash = list.some((r) =>
            rows.some((e) => e.tracker_id === r.tracker_id && e.external_key === r.external_key),
          );
          if (clash) {
            const result = { data: null, error: { code: '23505', message: 'duplicate' } };
            return {
              select: () => ({ single: async () => result }),
              // biome-ignore lint/suspicious/noThenProperty: imita el builder de supabase-js
              then: (resolve: (v: unknown) => void) => resolve(result),
            };
          }
        }
        return insert(Array.isArray(values) ? list : list[0]);
      };
      return qb;
    },
  } as unknown as SupabaseClient;
  return { db: createOrgScopedClient(raw, ORG), tables: fake.tables };
}

/** Un programa de mentira: páginas fijas por cosa, y registro de lo que se pidió. */
function fakeSession(pages: Partial<Record<AccountingEntity, NormalizedRecord[][]>>) {
  const asked: Array<{ entity: AccountingEntity; query: ProviderQuery; page: number }> = [];
  let requests = 0;
  const session: ProviderSession = {
    get requests() {
      return requests;
    },
    verify: async () => ({ token: null }),
    listPage: async (entity, query, page): Promise<ProviderPage> => {
      requests += 1;
      asked.push({ entity, query, page });
      const list = pages[entity] ?? [];
      return { records: list[page - 1] ?? [], hasMore: page < list.length };
    },
  };
  return { session, asked };
}

function recorder() {
  const calls: ImportSystemPaymentsInput[] = [];
  const importPayments = async (
    _db: SupabaseClient,
    input: ImportSystemPaymentsInput,
  ): Promise<ImportSystemPaymentsResult> => {
    calls.push(input);
    return {
      system: input.system,
      readAt: input.readAt ?? '',
      created: input.rows.length,
      agreed: 0,
      disputed: 0,
      duplicates: 0,
      rejected: [],
      sentence: '',
    };
  };
  return { calls, importPayments };
}

function connection(over: Partial<AccountingConnectionRow> = {}): AccountingConnectionRow {
  return {
    id: 'conn-1',
    provider: 'siigo',
    created_by: ADMIN,
    account_label: 'contabilidad@andina.co',
    entities: ['customers', 'products', 'invoices', 'payments'],
    trackers: {},
    cursors: {},
    interval_minutes: 60,
    notify: true,
    enabled: true,
    next_run_at: '2026-10-01T12:00:00Z',
    last_run_at: null,
    last_status: null,
    last_error: null,
    last_counts: {},
    created_at: '2026-10-01T11:00:00Z',
    updated_at: '2026-10-01T11:00:00Z',
    ...over,
  };
}

const NOW = new Date('2026-10-01T12:00:00Z');

const customers: NormalizedRecord[] = [
  { externalId: 'c-1', name: 'Coltrans S.A.S.', taxId: '900123456', active: true },
  { externalId: 'c-2', name: 'Nexa Logística', taxId: '800555111', active: true },
];
const invoices: NormalizedRecord[] = [
  {
    externalId: 'i-1',
    number: 'FV-2-22',
    date: '2026-07-15',
    dueDate: '2026-08-14',
    customerExternalId: 'c-1',
    customerTaxId: '900123456',
    total: 2_000_000,
    balance: 1_200_000,
    currency: 'COP',
    status: 'open',
  },
  {
    externalId: 'i-2',
    number: 'FV-2-23',
    date: '2026-09-20',
    dueDate: '2026-10-20',
    customerExternalId: 'c-2',
    total: 500_000,
    balance: 0,
    currency: 'COP',
    status: 'paid',
  },
];
const payments: NormalizedRecord[] = [
  {
    externalId: 'rc-1',
    number: 'RC-1-9',
    date: '2026-08-01',
    customerExternalId: 'c-1',
    customerTaxId: '900123456',
    amount: 800_000,
    currency: 'COP',
    kind: 'Abono a factura',
    applications: [{ ref: 'rc-1:0', invoiceNumber: 'FV-2-22', amount: 800_000 }],
  },
];

describe('una corrida contra un programa contable', () => {
  it('la primera vez crea las tablas, llena filas, escribe la cartera y los pagos', async () => {
    const w = world({
      clients: [{ id: 'cli-coltrans', organization_id: ORG, tax_id: '900123456' }],
    });
    const { session } = fakeSession({
      customers: [customers],
      products: [[{ externalId: 'p-1', name: 'Flete Bogotá', price: 120_000 }]],
      invoices: [invoices],
      payments: [payments],
    });
    const pay = recorder();
    const out = await runAccountingSync(w.db, connection(), {
      session,
      now: NOW,
      importPayments: pay.importPayments,
    });

    expect(out.result.status).toBe('ok');
    expect(out.completedInitial).toBe(true);
    const trackers = (w.tables.trackers ?? []) as Row[];
    expect(trackers.map((t) => [t.slug, t.name])).toEqual([
      ['siigo_clientes', 'Clientes (Siigo)'],
      ['siigo_productos', 'Productos (Siigo)'],
      ['siigo_facturas', 'Facturas (Siigo)'],
      ['siigo_pagos', 'Recibos de caja (Siigo)'],
    ]);

    const rows = (w.tables.tracker_rows ?? []) as Row[];
    const fv22 = rows.find((r) => r.external_key === 'i-1');
    expect(fv22?.label).toBe('FV-2-22');
    expect(fv22?.values).toMatchObject({
      numero: 'FV-2-22',
      cliente: 'Coltrans S.A.S.',
      saldo: 1_200_000,
      estado: 'Vencida',
    });
    expect(rows.find((r) => r.external_key === 'i-2')?.values).toMatchObject({ estado: 'Pagada' });
    expect(rows.every((r) => r.organization_id === ORG)).toBe(true);

    const receivable = ((w.tables.accounting_invoices ?? []) as Row[]).find(
      (r) => r.source_ref === 'i-1',
    );
    expect(receivable).toMatchObject({
      organization_id: ORG,
      source_system: 'siigo',
      doc_number: 'FV-2-22',
      client_id: 'cli-coltrans',
      counterparty_name: 'Coltrans S.A.S.',
      balance: 1_200_000,
      due_on: '2026-08-14',
    });

    expect(pay.calls).toHaveLength(1);
    expect(pay.calls[0]).toMatchObject({ system: 'siigo', createdBy: ADMIN });
    expect(pay.calls[0]?.rows).toEqual([
      expect.objectContaining({
        sourceRef: 'rc-1:0',
        amount: 800_000,
        invoiceNumber: 'FV-2-22',
        clientNit: '900123456',
      }),
    ]);

    if (out.result.status === 'error') throw new Error('no debía fallar');
    expect(out.result.counts.invoices).toMatchObject({ fetched: 2, inserted: 2 });
    expect(out.result.cursors.invoices).toEqual({
      since: NOW.toISOString(),
      full_at: NOW.toISOString(),
    });
    expect(Object.keys(out.result.trackers).sort()).toEqual([
      'customers',
      'invoices',
      'payments',
      'products',
    ]);
  });

  it('correr dos veces lo mismo no duplica ni cambia nada, y respeta lo que el equipo escribió', async () => {
    const w = world();
    const pages = { customers: [customers], invoices: [invoices] };
    const conn = connection({ entities: ['customers', 'invoices'] });
    const first = await runAccountingSync(w.db, conn, {
      session: fakeSession(pages).session,
      now: NOW,
      importPayments: recorder().importPayments,
    });
    if (first.result.status === 'error') throw new Error(first.result.error);

    // El equipo le agrega un campo a la tabla y lo llena a mano.
    const facturas = ((w.tables.trackers ?? []) as Row[]).find((t) => t.slug === 'siigo_facturas');
    (facturas?.fields as Row[]).push({
      key: 'gestor',
      label: 'Gestor',
      type: 'text',
      required: false,
    });
    const row = ((w.tables.tracker_rows ?? []) as Row[]).find((r) => r.external_key === 'i-1');
    (row?.values as Row).gestor = 'Ana';

    const second = await runAccountingSync(
      w.db,
      { ...conn, cursors: first.result.cursors, trackers: first.result.trackers },
      { session: fakeSession(pages).session, now: NOW, importPayments: recorder().importPayments },
    );
    if (second.result.status === 'error') throw new Error(second.result.error);
    // Incremental: lo nuevo y lo cambiado son dos listados; el programa de
    // mentira contesta lo mismo a los dos, y las cuatro lecturas quedan igual.
    expect(second.result.counts.invoices).toMatchObject({ inserted: 0, updated: 0, unchanged: 4 });
    expect((w.tables.tracker_rows ?? []).length).toBe(4);
    expect((w.tables.accounting_invoices ?? []).length).toBe(2);

    // Siigo registra un abono: cambia el saldo y nada más.
    const paid = invoices.map((i) =>
      (i as { externalId: string }).externalId === 'i-1' ? { ...i, balance: 0, status: 'paid' } : i,
    ) as NormalizedRecord[];
    const third = await runAccountingSync(
      w.db,
      { ...conn, cursors: second.result.cursors, trackers: second.result.trackers },
      {
        session: fakeSession({ customers: [customers], invoices: [paid] }).session,
        now: NOW,
        importPayments: recorder().importPayments,
      },
    );
    if (third.result.status === 'error') throw new Error(third.result.error);
    expect(third.result.counts.invoices).toMatchObject({ inserted: 0, updated: 1, unchanged: 3 });
    expect(row?.values).toMatchObject({ saldo: 0, estado: 'Pagada', gestor: 'Ana' });
    expect(
      ((w.tables.accounting_invoices ?? []) as Row[]).find((r) => r.source_ref === 'i-1')?.balance,
    ).toBe(0);
  });

  it('si se acaba el tiempo anota dónde iba, y la siguiente corrida sigue de ahí', async () => {
    const w = world();
    const big = [[invoices[0] as NormalizedRecord], [invoices[1] as NormalizedRecord]];
    let t = 0;
    const clock = () => t;
    const one = fakeSession({ invoices: big });
    // El reloj se acaba después de la primera página.
    const session: ProviderSession = {
      get requests() {
        return one.session.requests;
      },
      verify: one.session.verify,
      listPage: async (entity, query, page) => {
        const result = await one.session.listPage(entity, query, page);
        t = 1_000;
        return result;
      },
    };
    const conn = connection({ entities: ['invoices'] });
    const first = await runAccountingSync(w.db, conn, {
      session,
      now: NOW,
      clock,
      deadline: 500,
      importPayments: recorder().importPayments,
    });
    expect(first.result.status).toBe('partial');
    expect(first.completedInitial).toBe(false);
    if (first.result.status === 'error') throw new Error('no debía fallar');
    expect(first.result.cursors.invoices?.resume).toMatchObject({
      index: 0,
      page: 2,
      mode: 'initial',
    });
    expect(first.result.cursors.invoices?.since).toBeUndefined();

    const rest = fakeSession({ invoices: big });
    const second = await runAccountingSync(
      w.db,
      {
        ...conn,
        cursors: first.result.cursors,
        trackers: first.result.trackers,
        last_status: 'partial',
      },
      { session: rest.session, now: NOW, importPayments: recorder().importPayments },
    );
    expect(second.result.status).toBe('ok');
    expect(second.completedInitial).toBe(true);
    expect(rest.asked.map((a) => a.page)).toEqual([2]);
    expect((w.tables.tracker_rows ?? []).length).toBe(2);
    if (second.result.status === 'error') throw new Error('no debía fallar');
    expect(second.result.cursors.invoices).toEqual({
      since: NOW.toISOString(),
      full_at: NOW.toISOString(),
    });
  });

  it('una falla del programa no lanza: queda el error y lo que alcanzó a avanzar', async () => {
    const w = world();
    const session: ProviderSession = {
      requests: 1,
      verify: async () => ({ token: null }),
      listPage: async (entity) => {
        if (entity === 'invoices') throw new Error('Siigo no está respondiendo en este momento.');
        return { records: customers, hasMore: false };
      },
    };
    const out = await runAccountingSync(w.db, connection({ entities: ['customers', 'invoices'] }), {
      session,
      now: NOW,
      importPayments: recorder().importPayments,
    });
    expect(out.result).toMatchObject({
      status: 'error',
      error: 'Siigo no está respondiendo en este momento.',
    });
    if (out.result.status !== 'error') throw new Error('debía fallar');
    expect(out.result.cursors?.customers?.since).toBe(NOW.toISOString());
    expect(out.result.cursors?.invoices).toBeUndefined();
  });
});

describe('qué pedir en cada corrida', () => {
  it('primera vez, incremental con margen, y el repaso diario de facturas', () => {
    expect(planEntity(siigoProvider, 'customers', undefined, NOW).mode).toBe('initial');

    const recent = { since: '2026-10-01T11:00:00.000Z', full_at: '2026-10-01T06:00:00.000Z' };
    const inc = planEntity(siigoProvider, 'invoices', recent, NOW);
    expect(inc.mode).toBe('incremental');
    expect(inc.queries).toEqual([
      { created_start: '2026-10-01T10:50:00Z' },
      { updated_start: '2026-10-01T10:50:00Z' },
    ]);
    expect(finishedCursor(inc, recent)).toEqual({
      since: NOW.toISOString(),
      full_at: recent.full_at,
    });

    const stale = { since: '2026-10-01T11:00:00.000Z', full_at: '2026-09-29T06:00:00.000Z' };
    const sweep = planEntity(siigoProvider, 'invoices', stale, NOW);
    expect(sweep.mode).toBe('sweep');
    expect(sweep.queries[0]).toEqual({ date_start: '2026-04-01' });
    expect(sweep.queries).toHaveLength(3);
    // Los clientes no tienen repaso: sólo lo nuevo y lo cambiado.
    expect(planEntity(siigoProvider, 'customers', stale, NOW).mode).toBe('incremental');
  });
});

describe('la campana', () => {
  const base = {
    newLabels: { invoices: ['FV-2-24', 'FV-2-25'] },
    completedInitial: false,
  };
  const counts = (inserted: number) => ({
    status: 'ok' as const,
    counts: { invoices: { fetched: 2, inserted, updated: 0, unchanged: 0, skipped: 0 } },
    cursors: {},
    trackers: {},
  });

  it('avisa la primera carga y las facturas nuevas; calla cuando no hay nada', () => {
    expect(
      noticeFor('Siigo', { ...base, completedInitial: true, result: counts(2) }, 60, [
        'Facturas (Siigo)',
      ])?.title,
    ).toBe('Siigo ya está conectado');
    expect(noticeFor('Siigo', { ...base, result: counts(2) }, 60, [])).toEqual({
      title: 'Siigo: 2 facturas nuevas',
      body: '2 facturas nuevas: FV-2-24, FV-2-25.',
    });
    expect(noticeFor('Siigo', { ...base, result: counts(0) }, 60, [])).toBeNull();
  });
});
