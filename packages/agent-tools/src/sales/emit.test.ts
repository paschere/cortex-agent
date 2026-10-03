import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  type InvoicingCatalog,
  type ProviderSession,
  ProviderUncertainError,
  ProviderValidationError,
} from '../accounting/types';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { emitInvoice, invoiceIdempotencyKey, previewInvoice } from './emit';
import {
  acceptQuote,
  convertQuoteToOrder,
  createSalesDocument,
  getSalesDocument,
  getSalesDocumentRow,
} from './store';

/**
 * La emisión de la factura contra una base de mentira (el doble de PostgREST
 * que ejecuta los filtros de verdad) y un programa de mentira: lo que importa
 * es lo que queda escrito y cuántas veces se le habló al programa.
 */

const ORG = 'org-andina';
const USER = '11111111-1111-4111-a111-111111111111';
const TODAY = '2026-10-03';
type Row = Record<string, unknown>;

let seq = 0;
function world(connections: Row[] = []) {
  const counters: Record<string, number> = {};
  const fake = createFakeSupabase(
    {
      clients: [],
      client_contacts: [],
      accounting_connections: connections,
      sales_documents: [],
      sales_document_lines: [],
      sales_document_events: [],
      tracker_rows: [],
    },
    {
      sales_next_number: (args) => {
        const k = `${args.p_organization_id}:${args.p_kind}`;
        counters[k] = (counters[k] ?? 0) + 1;
        return counters[k];
      },
    },
  );
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
          id: `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`,
          created_at: `2026-10-03T00:00:${String(seq % 60).padStart(2, '0')}Z`,
          updated_at: '2026-10-03T00:00:00Z',
          ...(table === 'sales_documents'
            ? { share_views: 0, emission_uncertain: false, share_token: null }
            : {}),
          ...r,
        }));
        return insert(Array.isArray(values) ? list : list[0]);
      };
      return qb;
    },
  } as unknown as SupabaseClient;
  return { db: createOrgScopedClient(raw, ORG), tables: fake.tables };
}

const SIIGO_CONN = {
  id: 'conn-siigo',
  organization_id: ORG,
  provider: 'siigo',
  enabled: true,
  created_at: '2026-01-01T00:00:00Z',
  trackers: {},
  cursors: {},
  entities: ['invoices'],
};

const catalog: InvoicingCatalog = {
  documentTypes: [{ id: '24446', name: 'FV electrónica', electronic: true }],
  sellers: [{ id: '629', name: 'Ana' }],
  paymentTypes: [{ id: '5636', name: 'Crédito', credit: true }],
  taxes: [{ id: '13156', name: 'IVA 19%', kind: 'iva', percentage: 19 }],
};

type CreateInvoice = NonNullable<ProviderSession['invoicing']>['createInvoice'];

function provider(create: CreateInvoice) {
  const createInvoice = vi.fn(create);
  const session = {
    requests: 0,
    verify: async () => ({ token: null }),
    listPage: async () => ({ records: [], hasMore: false }),
    invoicing: {
      catalog: async () => catalog,
      findCustomer: async (taxId: string) =>
        taxId === '900123456' ? { id: 'c1', name: 'Nexa' } : null,
      createInvoice,
    },
  } as ProviderSession;
  return { createInvoice, openSession: async () => session };
}

async function acceptedQuote(
  db: SupabaseClient,
  opts: { code?: string | null; taxId?: string } = {},
) {
  const quote = await createSalesDocument(
    db,
    'quote',
    {
      clientName: 'Nexa Logística',
      clientTaxId: opts.taxId ?? '900123456',
      lines: [
        {
          description: 'Flete Bogotá–Cali',
          quantity: 10,
          unitPrice: 1_200_000,
          productCode: opts.code === undefined ? 'FLT-BC' : opts.code,
          productRef: opts.code === null ? null : '501',
        },
      ],
    },
    { userId: USER, today: TODAY },
  );
  return acceptQuote(db, quote, { name: 'Carlos Peña', today: TODAY });
}

const ctxOf = (db: SupabaseClient) => ({
  db,
  organizationId: ORG,
  userId: USER,
  enqueueJob: vi.fn(async () => true),
});

describe('sin programa contable', () => {
  it('prepara la factura pero nunca dice que está emitida', async () => {
    const { db, tables } = world([]);
    const quote = await acceptedQuote(db);
    await expect(emitInvoice(ctxOf(db), quote.id, { today: TODAY })).rejects.toThrow(
      /NO está emitida.*Conecta Siigo o Alegra/s,
    );
    const invoices = (tables.sales_documents as Row[]).filter((d) => d.kind === 'invoice');
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.status).toBe('borrador');
    expect(invoices[0]?.provider_invoice_id).toBeUndefined();
    const preview = await previewInvoice(db, quote.id);
    expect(preview.draft).toBeNull();
    expect(preview.guidance).toMatch(/Conecta Siigo o Alegra/);
  });
});

describe('con Siigo', () => {
  it('emite una vez, guarda el CUFE y marca el negocio como facturado', async () => {
    const { db, tables } = world([SIIGO_CONN]);
    const quote = await acceptedQuote(db);
    const order = await convertQuoteToOrder(db, quote.id, USER);
    const { createInvoice, openSession } = provider(async () => ({
      id: 'siigo-inv-1',
      number: 'FV-2-22',
      cufe: 'cufe-abc',
      einvoiceStatus: 'Aceptada',
      url: 'https://documentview.siigo.com/x',
      total: 14_280_000,
    }));
    const ctx = ctxOf(db);
    const first = await emitInvoice(ctx, order.id, { openSession, today: TODAY });
    expect(first.status).toBe('emitted');
    expect(first.invoice).toMatchObject({
      status: 'emitida',
      provider: 'siigo',
      provider_invoice_id: 'siigo-inv-1',
      provider_number: 'FV-2-22',
      cufe: 'cufe-abc',
    });
    expect(first.markdown).toMatch(/FV-2-22/);
    expect(createInvoice).toHaveBeenCalledTimes(1);
    const [payload, opts] = createInvoice.mock.calls[0] as [Row, { idempotencyKey: string }];
    expect(opts.idempotencyKey).toBe(invoiceIdempotencyKey(ORG, first.invoice.id));
    expect((payload.payments as Row[])[0]?.value).toBe(14_280_000);
    expect((await getSalesDocumentRow(db, order.id))?.status).toBe('facturada');
    expect((await getSalesDocumentRow(db, quote.id))?.status).toBe('facturada');
    expect(ctx.enqueueJob).toHaveBeenCalledWith('accounting/run', {
      organizationId: ORG,
      connectionId: 'conn-siigo',
    });

    // Otra vez, desde el pedido o desde la factura: la misma, sin hablarle a Siigo.
    const again = await emitInvoice(ctx, order.id, { openSession, today: TODAY });
    expect(again.status).toBe('already_emitted');
    const third = await emitInvoice(ctx, first.invoice.id, { openSession, today: TODAY });
    expect(third.status).toBe('already_emitted');
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect((tables.sales_documents as Row[]).filter((d) => d.kind === 'invoice')).toHaveLength(1);

    const detail = await getSalesDocument(db, first.invoice.id);
    expect(detail?.events.map((e) => e.kind)).toEqual(['invoice_prepared', 'invoice_emitted']);
  });

  it('con algo que arreglar no le manda nada a Siigo', async () => {
    const { db } = world([SIIGO_CONN]);
    const quote = await acceptedQuote(db, { code: null });
    const { createInvoice, openSession } = provider(async () => {
      throw new Error('no debería llamarse');
    });
    await expect(emitInvoice(ctxOf(db), quote.id, { openSession, today: TODAY })).rejects.toThrow(
      /no tiene un producto de Siigo/,
    );
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('un rechazo de Siigo queda en español y se puede corregir y repetir', async () => {
    const { db } = world([SIIGO_CONN]);
    const quote = await acceptedQuote(db);
    let calls = 0;
    const { openSession } = provider(async () => {
      calls += 1;
      if (calls === 1)
        throw new ProviderValidationError(
          'Siigo no aceptó la factura: falta el vendedor o no existe en Siigo.',
        );
      return {
        id: 'ok-2',
        number: 'FV-2-23',
        cufe: null,
        einvoiceStatus: null,
        url: null,
        total: null,
      };
    });
    await expect(emitInvoice(ctxOf(db), quote.id, { openSession, today: TODAY })).rejects.toThrow(
      /falta el vendedor/,
    );
    const failed = (await getSalesDocument(db, quote.id))?.related.find(
      (r) => r.kind === 'invoice',
    );
    expect(failed?.status).toBe('error');
    expect(failed?.provider_error).toMatch(/vendedor/);
    const retry = await emitInvoice(ctxOf(db), quote.id, { openSession, today: TODAY });
    expect(retry.invoice.provider_number).toBe('FV-2-23');
  });

  it('una cotización sin aceptar no se factura', async () => {
    const { db } = world([SIIGO_CONN]);
    const quote = await createSalesDocument(
      db,
      'quote',
      { clientName: 'Nexa', lines: [{ description: 'x', quantity: 1, unitPrice: 1 }] },
      { userId: USER, today: TODAY },
    );
    await expect(emitInvoice(ctxOf(db), quote.id, { today: TODAY })).rejects.toThrow(/aceptada/);
  });
});

describe('con Alegra, si la red se corta', () => {
  it('no reintenta solo hasta que alguien revisó', async () => {
    const { db } = world([{ ...SIIGO_CONN, id: 'conn-alegra', provider: 'alegra' }]);
    const quote = await acceptedQuote(db);
    let calls = 0;
    const { openSession } = provider(async () => {
      calls += 1;
      if (calls === 1) throw new ProviderUncertainError('La conexión con Alegra se cortó…');
      return {
        id: '77',
        number: 'FE-77',
        cufe: 'c',
        einvoiceStatus: 'Pendiente',
        url: null,
        total: null,
      };
    });
    await expect(emitInvoice(ctxOf(db), quote.id, { openSession, today: TODAY })).rejects.toThrow(
      /se cortó/,
    );
    await expect(emitInvoice(ctxOf(db), quote.id, { openSession, today: TODAY })).rejects.toThrow(
      /Búscala en Alegra/,
    );
    expect(calls).toBe(1);
    const ok = await emitInvoice(ctxOf(db), quote.id, {
      openSession,
      today: TODAY,
      retryUncertain: true,
    });
    expect(ok.invoice.provider_number).toBe('FE-77');
    expect(ok.invoice.emission_uncertain).toBe(false);
  });
});
