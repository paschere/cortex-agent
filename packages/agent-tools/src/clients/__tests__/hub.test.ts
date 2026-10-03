import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import {
  type AccountingInvoiceIn,
  type PaymentIn,
  assembleClientRows,
  clientHealth,
  invoicesByClient,
  moneyOf,
} from '../hub';
import { loadClient360, loadClientList } from '../hub-read';

/**
 * LA PLATA DE CADA CLIENTE: las reglas de la cartera repetidas para todos los
 * clientes a la vez, y la ficha 360 leída de una base de mentira.
 */

const TODAY = '2026-10-02';
const NEXA = 'cccc0000-0000-4000-8000-000000000001';
const COL = 'cccc0000-0000-4000-8000-000000000002';

const acc = (over: Partial<AccountingInvoiceIn>): AccountingInvoiceIn => ({
  id: 'a',
  client_id: NEXA,
  doc_number: 'FV-1',
  currency: 'COP',
  total: 100,
  balance: 0,
  issued_on: '2026-09-01',
  due_on: '2026-10-01',
  annulled: false,
  ...over,
});

describe('invoicesByClient + moneyOf', () => {
  it('suma facturado del año, saldo y vencido en pesos; la otra moneda no se suma', () => {
    const invoices = invoicesByClient(
      {
        accountingInvoices: [
          acc({
            id: 'a1',
            doc_number: 'FV-1',
            total: 1000,
            balance: 400,
            issued_on: '2026-08-01',
            due_on: '2026-08-31',
          }),
          acc({
            id: 'a2',
            doc_number: 'FV-2',
            total: 500,
            balance: 500,
            issued_on: '2026-09-25',
            due_on: '2026-10-20',
          }),
          acc({
            id: 'a3',
            doc_number: 'FV-0',
            total: 900,
            balance: 0,
            issued_on: '2025-06-01',
            due_on: '2025-07-01',
          }),
          acc({ id: 'a4', doc_number: 'FV-9', total: 900, balance: 900, annulled: true }),
          acc({ id: 'a5', doc_number: 'X-1', currency: 'USD', total: 50, balance: 50 }),
        ],
        documentInvoices: [],
        payments: [],
      },
      TODAY,
    ).get(NEXA) as NonNullable<
      ReturnType<typeof invoicesByClient> extends Map<string, infer V> ? V : never
    >;
    const m = moneyOf(invoices, [], [], TODAY);
    expect(m.invoiced12m).toBe(1500);
    expect(m.outstanding).toBe(900);
    expect(m.overdue).toBe(400);
    expect(m.maxDaysOverdue).toBe(32);
    expect(m.nextDue).toEqual({ on: '2026-10-20', amount: 500, docNumber: 'FV-2' });
    expect(m.otherCurrencies).toEqual(['USD']);
  });

  it('una factura que existe como documento y en el programa cuenta una vez, la del documento', () => {
    const payments: PaymentIn[] = [
      {
        id: 'p',
        client_id: NEXA,
        extraction_id: 'd1',
        invoice_number: null,
        amount: 300,
        currency: 'COP',
        paid_on: '2026-09-10',
      },
    ];
    const invoices =
      invoicesByClient(
        {
          accountingInvoices: [acc({ id: 'a1', doc_number: 'FV 10', total: 1000, balance: 1000 })],
          documentInvoices: [
            {
              id: 'd1',
              client_id: NEXA,
              doc_number: 'FV-10',
              currency: 'COP',
              total_amount: 1000,
              issued_on: '2026-09-01',
              due_on: '2026-10-30',
            },
          ],
          payments,
        },
        TODAY,
      ).get(NEXA) ?? [];
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.source).toBe('document');
    expect(invoices[0]?.balance).toBe(700);
  });

  it('días de pago: promedio entre la emisión y el último pago de las facturas pagadas', () => {
    const invoices =
      invoicesByClient(
        {
          accountingInvoices: [
            acc({ id: 'a1', doc_number: 'FV-1', total: 100, balance: 0, issued_on: '2026-07-01' }),
            acc({ id: 'a2', doc_number: 'FV-2', total: 100, balance: 0, issued_on: '2026-08-01' }),
            acc({
              id: 'a3',
              doc_number: 'FV-3',
              total: 100,
              balance: 100,
              issued_on: '2026-09-01',
            }),
          ],
          documentInvoices: [],
          payments: [],
        },
        TODAY,
      ).get(NEXA) ?? [];
    const payments: PaymentIn[] = [
      {
        id: 'p1',
        client_id: NEXA,
        extraction_id: null,
        invoice_number: 'FV-1',
        amount: 50,
        currency: 'COP',
        paid_on: '2026-07-21',
      },
      {
        id: 'p2',
        client_id: NEXA,
        extraction_id: null,
        invoice_number: 'FV-1',
        amount: 50,
        currency: 'COP',
        paid_on: '2026-07-31',
      },
    ];
    const ledger = [
      {
        id: 'l',
        client_id: NEXA,
        kind: 'income',
        direction: 'in',
        status: 'settled',
        amount: 100,
        currency: 'COP',
        date: '2026-08-11',
        due_date: null,
        settled_at: null,
        doc_number: 'FV2',
      },
    ];
    const m = moneyOf(invoices, payments, ledger, TODAY);
    // FV-1: 30 días (el último abono); FV-2: 10 días por el libro. Promedio 20.
    expect(m.paymentDays).toEqual({ average: 20, sample: 2 });
    expect(moneyOf([], [], [], TODAY).paymentDays).toBeNull();
  });
});

describe('clientHealth', () => {
  const money = (
    o: Partial<{
      overdue: number;
      maxDaysOverdue: number | null;
      outstanding: number;
      invoiced12m: number;
    }>,
  ) => ({
    overdue: 0,
    maxDaysOverdue: null,
    outstanding: 0,
    invoiced12m: 1000,
    ...o,
  });
  it('dice en palabras cómo está', () => {
    expect(
      clientHealth({
        status: 'active',
        money: money({ overdue: 10, maxDaysOverdue: 80, outstanding: 10 }),
        lastContactAt: null,
        today: TODAY,
      }).label,
    ).toBe('Cartera muy vencida');
    expect(
      clientHealth({
        status: 'active',
        money: money({ overdue: 10, maxDaysOverdue: 5, outstanding: 10 }),
        lastContactAt: null,
        today: TODAY,
      }).tone,
    ).toBe('amber');
    expect(
      clientHealth({
        status: 'active',
        money: money({ outstanding: 10 }),
        lastContactAt: '2026-06-01T00:00:00Z',
        today: TODAY,
      }).label,
    ).toBe('Debe y está callado');
    expect(
      clientHealth({
        status: 'active',
        money: money({ invoiced12m: 0 }),
        lastContactAt: null,
        today: TODAY,
      }).label,
    ).toBe('Sin movimiento');
    expect(
      clientHealth({
        status: 'active',
        money: money({}),
        lastContactAt: '2026-09-30T00:00:00Z',
        today: TODAY,
      }).label,
    ).toBe('Al día');
    expect(
      clientHealth({ status: 'blocked', money: null, lastContactAt: null, today: TODAY }).tone,
    ).toBe('rose');
  });
});

describe('assembleClientRows', () => {
  const clients = [
    {
      id: NEXA,
      name: 'Nexa',
      legal_name: null,
      tax_id: '900431212',
      status: 'active',
      owner_user_id: null,
      updated_at: TODAY,
    },
    {
      id: COL,
      name: 'Coltrans',
      legal_name: null,
      tax_id: null,
      status: 'active',
      owner_user_id: null,
      updated_at: TODAY,
    },
  ];
  it('una fila por cliente con plata, último contacto y próximo vencimiento', () => {
    const rows = assembleClientRows(
      clients,
      {
        accountingInvoices: [acc({ id: 'a1', total: 1000, balance: 1000, due_on: '2026-09-01' })],
        documentInvoices: [],
        payments: [],
        ledger: [],
        contacts: [{ client_id: COL, at: '2026-09-20T10:00:00Z', kind: 'email' }],
        commitments: [
          { client_id: COL, due_on: '2026-10-09', state: 'in_force', title: 'Propuesta' },
        ],
      },
      TODAY,
    );
    const nexa = rows.find((r) => r.id === NEXA);
    const col = rows.find((r) => r.id === COL);
    expect(nexa?.overdue).toBe(1000);
    expect(nexa?.health.label).toBe('Pagos atrasados');
    expect(col?.outstanding).toBe(0);
    expect(col?.quietDays).toBe(12);
    expect(col?.lastContactKind).toBe('email');
    expect(col?.nextDueOn).toBe('2026-10-09');
  });

  it('sin plata leída, las cifras quedan en null («sin dato»), no en cero', () => {
    const rows = assembleClientRows(clients, { contacts: [], commitments: [] }, TODAY);
    expect(rows[0]?.outstanding).toBeNull();
    expect(rows[0]?.invoiced12m).toBeNull();
    expect(rows[0]?.missing).toContain('facturas y pagos');
  });
});

describe('loadClient360 / loadClientList contra la base de mentira', () => {
  const ORG = 'org-acme';
  const OTHER = 'org-globex';
  const tables = () => ({
    users: [],
    clients: [
      {
        id: NEXA,
        organization_id: ORG,
        name: 'Nexa',
        legal_name: null,
        tax_id: '900431212',
        status: 'active',
        services: [],
        tags: ['Clave'],
        owner_user_id: null,
        created_at: TODAY,
        updated_at: TODAY,
      },
      {
        id: COL,
        organization_id: OTHER,
        name: 'Coltrans',
        legal_name: null,
        tax_id: null,
        status: 'active',
        services: [],
        owner_user_id: null,
        created_at: TODAY,
        updated_at: TODAY,
      },
    ],
    accounting_invoices: [
      {
        ...acc({
          id: 'a1',
          total: 1000,
          balance: 400,
          issued_on: '2026-08-01',
          due_on: '2026-08-31',
        }),
        organization_id: ORG,
      },
      // Otra empresa, mismo client_id inventado: no puede aparecer.
      { ...acc({ id: 'a2', total: 9999, balance: 9999 }), organization_id: OTHER },
    ],
    document_extractions: [],
    payments: [],
    ledger_movements: [],
    gmail_thread_ingests: [
      {
        id: 'g1',
        organization_id: ORG,
        client_id: NEXA,
        subject: 'Despachos',
        last_message_at: '2026-09-29T10:00:00Z',
        message_count: 3,
      },
    ],
    microsoft_mail_ingests: [],
    actions: [],
    client_links: [],
    client_notes: [
      {
        id: 'n1',
        organization_id: ORG,
        client_id: NEXA,
        body: 'Paga el viernes',
        created_by: null,
        created_at: '2026-09-30T10:00:00Z',
      },
    ],
    commitments: [],
    client_contacts: [],
    client_domains: [],
    client_aliases: [],
    work_items: [],
    management_cases: [],
    management_workflows: [],
  });

  it('arma la ficha con plata, salud y línea de tiempo, sólo con lo de la empresa', async () => {
    const fake = createFakeSupabase(tables());
    const db = createOrgScopedClient(fake.client, ORG);
    const hub = await loadClient360(db, NEXA, {
      today: TODAY,
      withForecast: false,
      withRecovered: false,
    });
    expect(hub?.money.ok && hub.money.data.outstanding).toBe(400);
    expect(hub?.money.ok && hub.money.data.overdue).toBe(400);
    expect(hub?.health.label).toBe('Pagos atrasados');
    expect(hub?.lastContactAt).toBe('2026-09-30T10:00:00Z');
    const kinds = hub?.timeline.ok ? hub.timeline.data.map((t) => t.kind) : [];
    expect(kinds).toEqual(['note', 'email', 'invoice']);
    expect(hub?.recovered.ok).toBe(false);
    expect(await loadClient360(db, COL, { today: TODAY })).toBeNull();
  });

  it('la lista no suma lo de otra empresa', async () => {
    const fake = createFakeSupabase(tables());
    const db = createOrgScopedClient(fake.client, ORG);
    const list = await loadClientList(db, { today: TODAY });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]?.outstanding).toBe(400);
    expect(list.rows[0]?.tags).toEqual(['Clave']);
  });
});
