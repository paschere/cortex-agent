import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { forgetAutomationWatch } from '../apps/automations/emit';
import type { ImportSystemPaymentsInput, ImportSystemPaymentsResult } from '../payments/import';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import type { MonthReading } from './derived';
import { alegraProvider } from './providers/alegra';
import type { NormalizedPurchase } from './providers/purchases';
import { quickbooksProvider } from './providers/quickbooks';
import { siigoProvider } from './providers/siigo';
import type { AccountingConnectionRow } from './store';
import {
  type ImportPurchases,
  auditCoverage,
  finishedCursor,
  noticeFor,
  planEntity,
  runAccountingSync,
} from './sync';
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
      coverage_version: 2,
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
      coverage_version: 2,
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

    const recent = {
      since: '2026-10-01T11:00:00.000Z',
      full_at: '2026-10-01T06:00:00.000Z',
      coverage_version: 2,
    };
    const inc = planEntity(siigoProvider, 'invoices', recent, NOW);
    expect(inc.mode).toBe('incremental');
    expect(inc.queries).toEqual([
      { created_start: '2026-10-01T10:50:00Z' },
      { updated_start: '2026-10-01T10:50:00Z' },
    ]);
    expect(finishedCursor(inc, recent)).toEqual({
      since: NOW.toISOString(),
      full_at: recent.full_at,
      coverage_version: 2,
    });

    const stale = {
      since: '2026-10-01T11:00:00.000Z',
      full_at: '2026-09-29T06:00:00.000Z',
      coverage_version: 2,
    };
    const sweep = planEntity(siigoProvider, 'invoices', stale, NOW);
    expect(sweep.mode).toBe('sweep');
    expect(sweep.queries[0]).toEqual({ date_start: '2026-04-01' });
    expect(sweep.queries).toHaveLength(3);
    // Los clientes no tienen repaso: sólo lo nuevo y lo cambiado.
    expect(planEntity(siigoProvider, 'customers', stale, NOW).mode).toBe('incremental');
    expect(planEntity(siigoProvider, 'customers', { since: stale.since }, NOW).mode).toBe(
      'initial',
    );
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

describe('el mismo motor para Alegra y QuickBooks', () => {
  function respond(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('Alegra: sus tablas, su cartera y sus pagos, con su nombre', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const data: Record<string, unknown[]> = {
        '/api/v1/invoices': [
          {
            id: '501',
            date: '2026-09-01',
            dueDate: '2026-09-15',
            status: 'open',
            total: 1_000_000,
            balance: 400_000,
            client: { id: '20', name: 'Nexa Logística', identification: '800555111-3' },
            numberTemplate: { prefix: 'FE', number: 77, fullNumber: 'FE77' },
            currency: { code: 'COP' },
          },
        ],
        '/api/v1/payments': [
          {
            id: '9',
            date: '2026-09-20',
            amount: 600_000,
            status: 'open',
            client: { id: '20', name: 'Nexa Logística' },
            invoices: [{ id: '501', number: 'FE77', amount: 600_000 }],
            currency: { code: 'COP' },
          },
        ],
      };
      return respond({ metadata: { total: 1 }, data: data[url.pathname] ?? [] });
    }) as unknown as typeof fetch;
    const session = alegraProvider.open(
      { email: 'a@b.co', token: 'tok-123' },
      { fetch: fetchImpl, sleep: async () => undefined, minIntervalMs: 0 },
    );
    const w = world();
    const pay = recorder();
    const out = await runAccountingSync(
      w.db,
      connection({ provider: 'alegra', entities: ['invoices', 'payments'] }),
      { session, now: NOW, importPayments: pay.importPayments },
    );
    expect(out.result.status).toBe('ok');
    expect(((w.tables.trackers ?? []) as Row[]).map((t) => [t.slug, t.name])).toEqual([
      ['alegra_facturas', 'Facturas (Alegra)'],
      ['alegra_pagos', 'Pagos recibidos (Alegra)'],
    ]);
    expect((w.tables.accounting_invoices ?? []) as Row[]).toEqual([
      expect.objectContaining({
        source_system: 'alegra',
        source_ref: '501',
        doc_number: 'FE77',
        client_nit: '800555111',
        counterparty_name: 'Nexa Logística',
        balance: 400_000,
      }),
    ]);
    expect(pay.calls[0]).toMatchObject({ system: 'alegra' });
    expect(pay.calls[0]?.rows).toEqual([
      expect.objectContaining({ sourceRef: '9:0', invoiceNumber: 'FE77', amount: 600_000 }),
    ]);
  });

  it('QuickBooks: «Clientes (QuickBooks)», «Facturas (QuickBooks)» y source_system quickbooks', async () => {
    const env = { ...process.env };
    process.env.QUICKBOOKS_CLIENT_ID = 'id';
    process.env.QUICKBOOKS_CLIENT_SECRET = 'secreto';
    try {
      const fetchImpl = (async (input: string | URL | Request) => {
        const q = new URL(String(input)).searchParams.get('query') ?? '';
        if (q.includes('FROM Customer'))
          return respond({
            QueryResponse: { Customer: [{ Id: '24', DisplayName: 'Red Rock Diner' }] },
          });
        if (q.includes('FROM Invoice'))
          return respond({
            QueryResponse: {
              Invoice: [
                {
                  Id: '130',
                  DocNumber: '1037',
                  TxnDate: '2026-09-20',
                  DueDate: '2026-10-20',
                  TotalAmt: 362.07,
                  Balance: 100,
                  CustomerRef: { value: '24' },
                  CurrencyRef: { value: 'USD' },
                },
              ],
            },
          });
        return respond({ QueryResponse: {} });
      }) as unknown as typeof fetch;
      const session = quickbooksProvider.open(
        { realm_id: '123', refresh_token: 'r1', company_name: 'Red Rock' },
        {
          fetch: fetchImpl,
          sleep: async () => undefined,
          minIntervalMs: 0,
          tokenStore: {
            load: async () => ({ token: 'a', expiresAt: Date.now() + 3_600_000 }),
            save: async () => undefined,
          },
        },
      );
      const w = world();
      const out = await runAccountingSync(
        w.db,
        connection({ provider: 'quickbooks', entities: ['customers', 'invoices'] }),
        { session, now: NOW, importPayments: recorder().importPayments },
      );
      expect(out.result.status).toBe('ok');
      expect(((w.tables.trackers ?? []) as Row[]).map((t) => t.name)).toEqual([
        'Clientes (QuickBooks)',
        'Facturas (QuickBooks)',
      ]);
      expect((w.tables.accounting_invoices ?? []) as Row[]).toEqual([
        expect.objectContaining({
          source_system: 'quickbooks',
          doc_number: '1037',
          currency: 'USD',
          balance: 100,
          // El nombre sale de la tabla de clientes, traída antes en la corrida.
          counterparty_name: 'Red Rock Diner',
        }),
      ]);
    } finally {
      process.env = env;
    }
  });
});

describe('auditCoverage: la tabla no se queda corta en silencio', () => {
  const base = { label: 'recibos de caja', skipped: 0 };
  it('el programa tiene más y no fue carga completa: pide recargar y avisa', () => {
    const r = auditCoverage({
      ...base,
      remote: 11,
      local: 4,
      cursor: { since: '2026-10-19T00:00:00Z', coverage_version: 2 },
      fullPass: false,
    });
    expect(r.reload).toBe(true);
    expect(r.cursor.since).toBeUndefined();
    expect(r.cursor.audit).toEqual({ remote: 11, local: 4 });
    expect(r.warning).toContain('faltan 7');
  });
  it('la misma diferencia después de una carga completa: sólo avisa, no repite sin fin', () => {
    const r = auditCoverage({
      ...base,
      remote: 11,
      local: 10,
      cursor: { since: 'x', audit: { remote: 11, local: 10 } },
      fullPass: false,
    });
    expect(r.reload).toBe(false);
    expect(r.warning).toContain('faltan 1');
  });
  it('al día: sin aviso y sin marca', () => {
    const r = auditCoverage({
      ...base,
      remote: 4,
      local: 4,
      cursor: { since: 'x', audit: { remote: 11, local: 4 } },
      fullPass: false,
    });
    expect(r.reload).toBe(false);
    expect(r.warning).toBeUndefined();
    expect(r.cursor.audit).toBeUndefined();
  });
});

describe('Siigo: los recibos de caja se piden también por fecha del documento', () => {
  it('incremental trae la ventana por fecha además de created/updated', () => {
    const q = siigoProvider.queries('payments', {
      mode: 'incremental',
      since: '2026-10-19T00:00:00Z',
      now: new Date('2026-10-19T12:00:00Z'),
    });
    expect(q).toContainEqual({ date_start: '2026-07-19' });
    expect(q).toHaveLength(3);
  });
  it('el repaso diario también cubre los recibos', () => {
    const plan = planEntity(
      siigoProvider,
      'payments',
      { since: '2026-10-19T00:00:00Z', coverage_version: 2, full_at: '2026-10-01T00:00:00Z' },
      new Date('2026-10-19T12:00:00Z'),
    );
    expect(plan.mode).toBe('sweep');
    expect(plan.queries[0]).toEqual({ date_start: '2025-10-19' });
  });
});

describe('Siigo → app: sucesos contables que salen de la sincronización (0232)', () => {
  const rule = (trackerId: string) => ({
    id: 'r-paid',
    organization_id: ORG,
    app_id: 'app-1',
    name: 'Factura pagada',
    enabled: true,
    trigger: { type: 'accounting_event', event: 'invoice_paid', provider: 'siigo' },
    conditions: [],
    actions: [{ type: 'notify_member', admins: true, title: 'Pagada' }],
    tracker_id: trackerId,
    trigger_kind: 'accounting_event',
  });
  const created = rule('x');

  it('la carga inicial no dispara nada; después, una factura que pasa a Pagada dispara UNA vez', async () => {
    const w = world({ custom_app_automations: [], custom_app_automation_runs: [] });
    const conn = connection({ entities: ['customers', 'invoices'] });
    // Primera corrida: ya existe una regla mirando la tabla de facturas (aún sin id): se crea tras la carga.
    const first = await runAccountingSync(w.db, conn, {
      session: fakeSession({ customers: [customers], invoices: [invoices] }).session,
      now: NOW,
      importPayments: recorder().importPayments,
    });
    if (first.result.status === 'error') throw new Error(first.result.error);
    const trackerId = first.result.trackers?.invoices as string;
    (w.tables.custom_app_automations as Row[]).push({ ...created, tracker_id: trackerId });
    forgetAutomationWatch();
    expect(w.tables.custom_app_automation_runs ?? []).toHaveLength(0);

    // Siigo registra el pago completo de FV-2-22.
    const paid = invoices.map((i) =>
      (i as { externalId: string }).externalId === 'i-1' ? { ...i, balance: 0, status: 'paid' } : i,
    ) as NormalizedRecord[];
    const next = { ...conn, cursors: first.result.cursors, trackers: first.result.trackers };
    const second = await runAccountingSync(w.db, next, {
      session: fakeSession({ customers: [customers], invoices: [paid] }).session,
      now: NOW,
      importPayments: recorder().importPayments,
    });
    if (second.result.status === 'error') throw new Error(second.result.error);
    const runs = (w.tables.custom_app_automation_runs ?? []) as Row[];
    expect(runs).toHaveLength(1);
    const event = runs[0]?.event as { before: { estado: string }; after: { estado: string; numero: string }; kind: string; backfill?: boolean };
    expect(event).toMatchObject({ kind: 'row_updated', before: { estado: 'Vencida' }, after: { estado: 'Pagada', numero: 'FV-2-22' } });
    expect(event.backfill).toBeFalsy();

    // Corre otra vez lo mismo: no cambió nada, no sale nada nuevo.
    await runAccountingSync(
      w.db,
      { ...next, cursors: second.result.cursors, trackers: second.result.trackers },
      { session: fakeSession({ customers: [customers], invoices: [paid] }).session, now: NOW, importPayments: recorder().importPayments },
    );
    expect(w.tables.custom_app_automation_runs ?? []).toHaveLength(1);
  });

  it('una regla que mira la carga inicial no recibe sucesos contables (backfill)', async () => {
    const w = world({ custom_app_automations: [], custom_app_automation_runs: [] });
    // La regla debe existir ANTES de la carga: se pre-crea la tabla corriendo una vez sin facturas.
    const conn = connection({ entities: ['invoices'] });
    const warm = await runAccountingSync(w.db, conn, {
      session: fakeSession({ invoices: [[]] }).session,
      now: NOW,
      importPayments: recorder().importPayments,
    });
    if (warm.result.status === 'error') throw new Error(warm.result.error);
    (w.tables.custom_app_automations as Row[]).push({ ...created, trigger: { ...created.trigger, event: 'invoice_created' }, tracker_id: warm.result.trackers?.invoices });
    forgetAutomationWatch();
    // Carga inicial (sin cursor): llegan facturas.
    const initial = await runAccountingSync(
      w.db,
      { ...conn, trackers: warm.result.trackers, cursors: {} },
      { session: fakeSession({ invoices: [invoices] }).session, now: NOW, importPayments: recorder().importPayments },
    );
    if (initial.result.status === 'error') throw new Error(initial.result.error);
    expect((w.tables.tracker_rows ?? []).length).toBe(2);
    expect(w.tables.custom_app_automation_runs ?? []).toHaveLength(0);
  });

  it('al llegar un recibo se vuelven a leer las facturas que abona (sin esperar al repaso diario)', async () => {
    const w = world();
    const conn = connection({ entities: ['invoices', 'payments'] });
    const first = await runAccountingSync(w.db, conn, {
      session: fakeSession({ invoices: [invoices] }).session,
      now: NOW,
      importPayments: recorder().importPayments,
    });
    if (first.result.status === 'error') throw new Error(first.result.error);
    const asked: string[][] = [];
    const base = fakeSession({ payments: [payments] });
    const session: ProviderSession = {
      ...base.session,
      refreshInvoices: async (numbers) => {
        asked.push(numbers);
        return [{ ...(invoices[0] as object), balance: 0, status: 'paid' }] as never;
      },
    };
    const second = await runAccountingSync(
      w.db,
      { ...conn, cursors: first.result.cursors, trackers: first.result.trackers },
      { session, now: NOW, importPayments: recorder().importPayments },
    );
    if (second.result.status === 'error') throw new Error(second.result.error);
    expect(asked).toEqual([['FV-2-22']]);
    const row = ((w.tables.tracker_rows ?? []) as Row[]).find((r) => r.external_key === 'i-1');
    expect(row?.values).toMatchObject({ saldo: 0, estado: 'Pagada' });
    expect(((w.tables.accounting_invoices ?? []) as Row[]).find((r) => r.source_ref === 'i-1')?.balance).toBe(0);
  });

  it('la carga inicial de recibos no dispara relecturas', async () => {
    const w = world();
    const asked: string[][] = [];
    const base = fakeSession({ payments: [payments] });
    const session: ProviderSession = { ...base.session, refreshInvoices: async (n) => { asked.push(n); return []; } };
    const out = await runAccountingSync(w.db, connection({ entities: ['invoices', 'payments'] }), {
      session, now: NOW, importPayments: recorder().importPayments,
    });
    if (out.result.status === 'error') throw new Error(out.result.error);
    expect(asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 0234: todo lo del programa como tablas
// ---------------------------------------------------------------------------

const purchaseRecords: NormalizedRecord[] = [
  {
    externalId: 'pu-1',
    number: 'FEPA451',
    documentNumber: 'FC-2-22',
    kind: 'Compra',
    date: '2026-09-28',
    dueDate: '2026-10-28',
    supplierExternalId: 'c-9',
    supplierTaxId: '900373115',
    total: 2_380_000,
    balance: 2_380_000,
    currency: 'COP',
    status: 'open',
  } as NormalizedPurchase,
  {
    externalId: 'pu-2',
    number: 'DS-1-4',
    documentNumber: 'DS-1-4',
    kind: 'Documento soporte',
    date: '2026-09-10',
    dueDate: '2026-09-20',
    supplierName: 'Persona natural',
    total: 100_000,
    balance: 100_000,
    currency: 'COP',
    status: 'open',
  } as NormalizedPurchase,
];

function purchasesImporter() {
  const calls: NormalizedPurchase[][] = [];
  const importPurchases: ImportPurchases = async (_db, list) => {
    calls.push([...list]);
    return { created: list.length, duplicates: 0, paid: 0, errors: [] };
  };
  return { calls, importPurchases };
}

describe('0234 · compras, egresos, existencias, movimientos, estados y catálogos', () => {
  const all = (over: Partial<AccountingConnectionRow> = {}) =>
    connection({
      entities: [
        'customers',
        'cost_centers',
        'products',
        'stock',
        'purchases',
        'supplier_payments',
        'quotations',
        'journal_lines',
        'statements',
        'payroll_costs',
      ],
      ...over,
    });

  it('las compras llenan su tabla (con estado y proveedor) y pasan a cuentas por pagar', async () => {
    const w = world();
    const imp = purchasesImporter();
    const { session } = fakeSession({
      customers: [[{ externalId: 'c-9', name: 'Papelería Andina', relationship: 'Proveedor', taxId: '900373115' }]],
      purchases: [purchaseRecords],
    });
    const out = await runAccountingSync(w.db, all({ entities: ['customers', 'purchases'] }), {
      session,
      now: NOW,
      importPayments: recorder().importPayments,
      importPurchases: imp.importPurchases,
    });
    if (out.result.status === 'error') throw new Error(out.result.error);
    const rows = (w.tables.tracker_rows ?? []) as Row[];
    expect(rows.find((r) => r.external_key === 'pu-1')?.values).toMatchObject({
      numero: 'FEPA451',
      documento: 'FC-2-22',
      tipo: 'Compra',
      proveedor: 'Papelería Andina',
      saldo: 2_380_000,
      estado: 'Por pagar',
    });
    expect(rows.find((r) => r.external_key === 'pu-2')?.values).toMatchObject({
      tipo: 'Documento soporte',
      estado: 'Vencida',
    });
    expect(imp.calls.flat().map((p) => p.externalId)).toEqual(['pu-1', 'pu-2']);
    expect(out.result.counts.payables_created).toBe(2);
    expect((w.tables.trackers as Row[]).map((t) => t.slug)).toContain('siigo_compras');
  });

  it('un egreso vuelve a leer las compras que paga y las marca pagadas en cuentas por pagar', async () => {
    const w = world();
    const imp = purchasesImporter();
    const conn = all({ entities: ['purchases', 'supplier_payments'] });
    const first = await runAccountingSync(w.db, conn, {
      session: fakeSession({ purchases: [purchaseRecords] }).session,
      now: NOW,
      importPayments: recorder().importPayments,
      importPurchases: imp.importPurchases,
    });
    if (first.result.status === 'error') throw new Error(first.result.error);
    const asked: string[][] = [];
    const base = fakeSession({
      supplier_payments: [
        [
          {
            externalId: 'e-1',
            number: 'RP-1-15',
            date: '2026-10-02',
            supplierName: 'Papelería Andina',
            supplierTaxId: '900373115',
            amount: 2_380_000,
            currency: 'COP',
            applications: [{ ref: 'e-1:0', purchaseNumber: 'FC-2-22', amount: 2_380_000 }],
          } as never,
        ],
      ],
    });
    const session: ProviderSession = {
      ...base.session,
      refreshPurchases: async (numbers) => {
        asked.push(numbers);
        return [{ ...(purchaseRecords[0] as NormalizedPurchase), balance: 0, status: 'paid' }];
      },
    };
    const second = await runAccountingSync(
      w.db,
      { ...conn, cursors: first.result.cursors, trackers: first.result.trackers },
      { session, now: NOW, importPayments: recorder().importPayments, importPurchases: imp.importPurchases },
    );
    if (second.result.status === 'error') throw new Error(second.result.error);
    expect(asked).toEqual([['FC-2-22']]);
    const rows = (w.tables.tracker_rows ?? []) as Row[];
    expect(rows.find((r) => r.external_key === 'pu-1')?.values).toMatchObject({ saldo: 0, estado: 'Pagada' });
    expect(rows.find((r) => r.external_key === 'e-1')?.values).toMatchObject({
      numero: 'RP-1-15',
      compras: 'FC-2-22',
      valor: 2_380_000,
      estado: 'Registrado',
    });
    // La compra pagada también viajó a cuentas por pagar (la marca como pagada).
    expect(imp.calls[imp.calls.length - 1]?.[0]).toMatchObject({ externalId: 'pu-1', status: 'paid' });
  });

  it('los productos llenan además las existencias por bodega, con su alerta', async () => {
    const w = world();
    const { session } = fakeSession({
      products: [
        [
          {
            externalId: 'p-1',
            name: 'Estiba',
            code: 'EST',
            stock: 3,
            minStock: 5,
            warehouses: [
              { externalId: '1', name: 'Principal', quantity: 3 },
              { externalId: '2', name: 'Bogotá', quantity: 40 },
            ],
          },
        ],
      ],
    });
    const out = await runAccountingSync(w.db, all({ entities: ['products', 'stock'] }), {
      session,
      now: NOW,
      importPayments: recorder().importPayments,
    });
    if (out.result.status === 'error') throw new Error(out.result.error);
    const stock = ((w.tables.tracker_rows ?? []) as Row[]).filter((r) => String(r.external_key).startsWith('p-1:'));
    expect(stock.map((r) => r.values)).toMatchObject([
      { producto: 'Estiba', bodega: 'Principal', existencias: 3, minimo: 5, alerta: 'Bajo mínimo' },
      { bodega: 'Bogotá', existencias: 40, alerta: 'Con existencias' },
    ]);
    expect(out.result.counts.stock).toMatchObject({ inserted: 2 });
    expect(Object.keys(out.result.trackers)).toContain('stock');
    // Las existencias no tienen cursor propio: cuentan con los productos.
    expect(out.result.cursors.stock).toBeUndefined();
  });

  it('los movimientos salen con centro de costo y tercero con nombre; los de nómina sin tercero', async () => {
    const w = world();
    const { session } = fakeSession({
      customers: [[{ externalId: 'c-1', name: 'Coltrans S.A.S.', taxId: '900123456', taxIdDisplay: '900123456-7' }]],
      cost_centers: [[{ externalId: '12', catalog: 'cost_centers', name: 'Operación', code: 'CC1' }]],
      journal_lines: [
        [
          {
            externalId: 'j-1:0',
            journalId: 'j-1',
            journalNumber: 'CC-1-33',
            date: '2026-09-30',
            account: '5135050101',
            movement: 'debit',
            value: 500_000,
            partyTaxId: '900123456',
            costCenter: '12',
            description: 'Flete',
          },
          {
            externalId: 'j-1:1',
            journalId: 'j-1',
            journalNumber: 'CC-1-33',
            date: '2026-09-30',
            account: '51050601',
            movement: 'debit',
            value: 3_000_000,
            partyTaxId: '1012345678',
            description: 'Sueldo de Ana',
            confidential: true,
          },
        ],
      ],
    });
    const out = await runAccountingSync(w.db, all({ entities: ['customers', 'cost_centers', 'journal_lines'] }), {
      session,
      now: NOW,
      importPayments: recorder().importPayments,
    });
    if (out.result.status === 'error') throw new Error(out.result.error);
    const rows = (w.tables.tracker_rows ?? []) as Row[];
    expect(rows.find((r) => r.external_key === 'j-1:0')?.values).toMatchObject({
      comprobante: 'CC-1-33',
      mes: '2026-09',
      cuenta: '5135050101',
      movimiento: 'Débito',
      debito: 500_000,
      nit_tercero: '900123456',
      tercero: 'Coltrans S.A.S.',
      centro_costo: 'Operación',
      descripcion: 'Flete',
    });
    const payroll = rows.find((r) => r.external_key === 'j-1:1')?.values as Row;
    expect(payroll).toMatchObject({ tercero: 'Nómina (confidencial)', debito: 3_000_000 });
    expect(payroll.nit_tercero).toBeUndefined();
    expect(payroll.descripcion).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('1012345678');
  });

  it('estados y costo de nómina salen de la lectura mensual y quedan como tablas', async () => {
    const w = world();
    const asked: string[] = [];
    const readMonth = async (_db: unknown, input: { month: string; want: { balance: boolean } }): Promise<MonthReading> => {
      asked.push(`${input.month}:${input.want.balance ? 'estados' : 'nomina'}`);
      return {
        pnl: {
          provider: 'siigo',
          from: `${input.month}-01`,
          to: `${input.month}-28`,
          currency: 'COP',
          revenue: 100,
          costOfSales: 40,
          operatingExpenses: 30,
          otherIncome: 0,
          otherExpenses: 0,
          incomeTax: null,
          netIncome: 30,
          lines: [{ section: 'ingreso', code: '41', name: 'Operacionales', amount: 100 }],
          personnel: [{ code: '51050601', name: 'SUELDOS', amount: 20 }],
          notes: [],
        },
        balance: null,
        fetched: 0,
        inProgress: false,
      };
    };
    const base = fakeSession({});
    const session: ProviderSession = { ...base.session, reports: {} as never };
    const out = await runAccountingSync(w.db, all({ entities: ['statements', 'payroll_costs'] }), {
      session,
      now: NOW,
      importPayments: recorder().importPayments,
      readMonth: readMonth as never,
    });
    if (out.result.status === 'error') throw new Error(out.result.error);
    // 24 meses cada una, de la lectura (no del listado del programa).
    expect(asked.filter((a) => a.endsWith('estados'))).toHaveLength(24);
    expect(asked.filter((a) => a.endsWith('nomina'))).toHaveLength(24);
    expect(base.asked).toEqual([]);
    const rows = (w.tables.tracker_rows ?? []) as Row[];
    expect(rows.find((r) => r.external_key === 'pnl|2026-10|ingresos|41')?.values).toMatchObject({
      periodo: '2026-10',
      estado: 'Estado de resultados',
      renglon: 'Operacionales',
      valor: 100,
      en_curso: 'No',
    });
    expect(rows.find((r) => r.external_key === 'payroll|2026-10|51050601')?.values).toMatchObject({
      area: 'Administración',
      concepto: 'Sueldos',
      valor: 20,
    });
  });

  it('un mes que el programa no entrega se avisa y no frena el resto', async () => {
    const w = world();
    let n = 0;
    const readMonth = async (): Promise<MonthReading> => {
      n += 1;
      if (n === 3) throw new Error('Siigo no entregó el balance de prueba');
      return { pnl: null, balance: null, fetched: 0, inProgress: false };
    };
    const session: ProviderSession = { ...fakeSession({}).session, reports: {} as never };
    const out = await runAccountingSync(w.db, all({ entities: ['statements'] }), {
      session,
      now: NOW,
      importPayments: recorder().importPayments,
      readMonth: readMonth as never,
    });
    if (out.result.status === 'error') throw new Error(out.result.error);
    expect(n).toBe(24);
    expect(out.result.counts.warnings?.[0]).toContain('No pude leer');
    expect(out.result.cursors.statements?.since).toBeDefined();
  });

  it('los catálogos y los estados se revisan una vez al día', () => {
    const provider = siigoProvider;
    const cursor = { since: '2026-10-21T10:00:00.000Z', coverage_version: 2 };
    const within = new Date('2026-10-21T20:00:00Z');
    const nextDay = new Date('2026-10-22T11:00:00Z');
    for (const e of ['cost_centers', 'taxes', 'warehouses', 'sellers', 'statements', 'payroll_costs'] as const) {
      expect(planEntity(provider, e, cursor, within).skip).toBe(true);
      expect(planEntity(provider, e, cursor, nextDay).skip).toBeUndefined();
    }
    // Lo demás sigue cada 15 minutos.
    expect(planEntity(provider, 'purchases', cursor, within).skip).toBeUndefined();
    // Compras y egresos se repasan una vez al día por lo que cambia sin modificar el documento.
    const sweep = planEntity(provider, 'purchases', { ...cursor, full_at: '2026-10-20T00:00:00Z' }, within);
    expect(sweep.mode).toBe('sweep');
    expect(planEntity(provider, 'supplier_payments', { ...cursor, full_at: '2026-10-20T00:00:00Z' }, within).mode).toBe('sweep');
  });

  it('la primera carga de estados son 24 meses y la de movimientos 12 ventanas', () => {
    const noCursor = undefined;
    expect(planEntity(siigoProvider, 'statements', noCursor, NOW).queries).toHaveLength(24);
    expect(planEntity(siigoProvider, 'journal_lines', noCursor, NOW).queries).toHaveLength(12);
    expect(planEntity(siigoProvider, 'cost_centers', noCursor, NOW).queries).toEqual([{}]);
  });

  it('las compras se comparan con el total de Siigo; si faltan, se repite la carga completa', async () => {
    const w = world();
    const base = fakeSession({ purchases: [purchaseRecords] });
    const session: ProviderSession = { ...base.session, remoteTotal: async () => 5 };
    const out = await runAccountingSync(w.db, all({ entities: ['purchases'] }), {
      session,
      now: NOW,
      importPayments: recorder().importPayments,
    });
    if (out.result.status === 'error') throw new Error(out.result.error);
    expect(out.result.counts.warnings?.[0]).toContain('El programa tiene 5 compras y la tabla 2');
  });

  it('cotizaciones: tabla con cliente y vigencia', async () => {
    const w = world();
    const { session } = fakeSession({
      quotations: [
        [
          {
            externalId: 'q-1',
            number: 'CO-1-5',
            date: '2026-10-10',
            validUntil: '2026-10-25',
            customerTaxId: '800555111',
            customerName: 'Nexa Logística',
            total: 1_190_000,
            currency: 'COP',
          },
        ],
      ],
    });
    const out = await runAccountingSync(w.db, all({ entities: ['quotations'] }), {
      session,
      now: NOW,
      importPayments: recorder().importPayments,
    });
    if (out.result.status === 'error') throw new Error(out.result.error);
    expect(((w.tables.tracker_rows ?? []) as Row[])[0]?.values).toMatchObject({
      numero: 'CO-1-5',
      cliente: 'Nexa Logística',
      vigencia: '2026-10-25',
      total: 1_190_000,
    });
  });

  it('Alegra y QuickBooks traen compras con la misma tabla', async () => {
    for (const provider of [alegraProvider, quickbooksProvider]) {
      expect(provider.entities).toContain('purchases');
      expect(provider.entities).toContain('statements');
    }
    expect(alegraProvider.entities).toContain('stock');
    expect(planEntity(alegraProvider, 'purchases', undefined, NOW).queries).toHaveLength(1);
    expect(planEntity(quickbooksProvider, 'purchases', undefined, NOW).queries).toHaveLength(1);
  });
});
