import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { InvoicingCatalog, ProviderSession } from '../../../accounting/types';
import { getSalesDocumentRow } from '../../../sales/store';
import { createFakeSupabase } from '../../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../tenancy/scoped-client';
import { forgetAutomationWatch } from '../emit';
import { buildInvoiceDraft, evalAmount, evalArithmetic, invoiceDraftKey, parseLooseNumber, writeBackValues } from '../invoice-draft';
import { invoiceBodySchema } from '../invoice-draft-spec';
import { approveInvoiceDraft, discardInvoiceDraft, draftProblems, listInvoiceDrafts, updateInvoiceDraft } from '../invoice-drafts';
import { type AutomationDeps, executeRun } from '../run';
import { automationInputSchema, structuralProblems } from '../spec';

/** Prefactura a Siigo al cerrar: armado puro, idempotencia, bandeja y aprobación. */

const ORG = 'org-a';
const USER = '11111111-1111-4111-a111-111111111111';
const NOW = new Date('2026-10-19T15:00:00.000Z');

describe('números y fórmulas', () => {
  it('lee pesos y decimales colombianos y anglosajones', () => {
    expect(parseLooseNumber('1.234,5')).toBe(1234.5);
    expect(parseLooseNumber('1,234.5')).toBe(1234.5);
    expect(parseLooseNumber('0,80')).toBe(0.8);
    expect(parseLooseNumber('$ 1.200.000')).toBe(1200000);
    expect(parseLooseNumber('')).toBeNaN();
    expect(parseLooseNumber('abc')).toBeNaN();
    expect(parseLooseNumber(7)).toBe(7);
  });
  it('aritmética sin código', () => {
    expect(evalArithmetic('1 + 2 * 3')).toBe(7);
    expect(evalArithmetic('(1 + 2) * 3')).toBe(9);
    expect(evalArithmetic('-4 + 10 / 4')).toBe(-1.5);
    expect(evalArithmetic('250 * 0,80')).toBe(200);
    expect(evalArithmetic('1 / 0')).toBeNaN();
    expect(evalArithmetic('process.exit()')).toBeNaN();
    expect(evalArithmetic('2 +')).toBeNaN();
    expect(evalArithmetic('(2')).toBeNaN();
  });
  it('evalAmount: número, campo y fórmula', () => {
    const ctx = { after: { kilos: '1.250,5', trm: 4100, vacio: '' } };
    expect(evalAmount(3, ctx)).toBe(3);
    expect(evalAmount('{{kilos}}', ctx)).toBe(1250.5);
    expect(evalAmount('={{kilos}} * 0,80', ctx)).toBeCloseTo(1000.4, 5);
    expect(evalAmount('={{trm}} * 2', ctx)).toBe(8200);
    expect(evalAmount('={{vacio}} * 2', ctx)).toBeNaN();
    expect(evalAmount('={{noexiste}} * 2', ctx)).toBeNaN();
  });
});

describe('buildInvoiceDraft: kilos × USD 0,80 al cliente del vuelo', () => {
  const base = {
    customer: { taxId: '{{nit}}' },
    items: [
      invoiceBodySchema.items.element.parse({
        description: 'Atención {{vuelo}} · {{kilos}} kg',
        productCode: 'SERV-001',
        quantity: '{{kilos}}',
        unitPrice: 0.8,
      }),
    ],
    currency: 'USD',
    trm: '{{trm}}',
    observations: 'Vuelo {{vuelo}} del {{fecha}}',
    paymentForm: 'contado' as const,
    paymentDays: 0,
  };
  const ctx = { after: { vuelo: 'AV204', kilos: 1000, fecha: '2026-10-19' } };
  const customerCtx = { after: { nit: '900.123.456-7', trm: 4000 } };

  it('convierte con la TRM, arma líneas en pesos y observaciones con plantillas', () => {
    const r = buildInvoiceDraft({ ...base, ctx, customerCtx: { ...customerCtx, after: { ...customerCtx.after } } });
    // La TRM sale del contexto de la fila, no del cliente: se pone en ambos para el ejemplo.
    expect(r.ok).toBe(false);
    const ok = buildInvoiceDraft({ ...base, trm: 4000, ctx, customerCtx });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const d = ok.draft;
    expect(d.customerTaxId).toBe('900123456');
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatchObject({ description: 'Atención AV204 · 1000 kg', productCode: 'SERV-001', quantity: 1000, unitPrice: 3200, sourceUnitPrice: 0.8 });
    expect(d.total).toBe(3_808_000); // 3.200.000 + 19 %
    expect(d.observations).toContain('Vuelo AV204 del 2026-10-19');
    expect(d.observations).toContain('TRM 4.000');
    expect(d.trm).toBe(4000);
  });
  it('sin NIT no se arma, y lo dice', () => {
    const r = buildInvoiceDraft({ ...base, trm: 4000, ctx, customerCtx: { after: {} } });
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toMatch(/no tiene NIT/);
  });
  it('moneda extranjera sin TRM o con TRM ilegible no se arma', () => {
    expect(JSON.stringify(buildInvoiceDraft({ ...base, trm: undefined, ctx, customerCtx }))).toMatch(/falta la TRM/);
    expect(JSON.stringify(buildInvoiceDraft({ ...base, trm: 'xx', ctx, customerCtx }))).toMatch(/TRM/);
    expect(JSON.stringify(buildInvoiceDraft({ ...base, trm: 0, ctx, customerCtx }))).toMatch(/mayor que cero/);
  });
  it('cantidad cero deja el ítem fuera; si todos quedan fuera, no se arma', () => {
    const two = {
      ...base,
      currency: 'COP',
      items: [
        ...base.items,
        invoiceBodySchema.items.element.parse({ description: 'Extra', quantity: '{{extra}}', unitPrice: 100 }),
      ],
    };
    const r = buildInvoiceDraft({ ...two, ctx: { after: { ...ctx.after, extra: 0 } }, customerCtx });
    expect(r.ok && r.draft.lines).toHaveLength(1);
    expect(r.ok && r.draft.skipped[0]).toMatch(/Extra/);
    const none = buildInvoiceDraft({ ...two, ctx: { after: { ...ctx.after, kilos: 0, extra: 0 } }, customerCtx });
    expect(none.ok).toBe(false);
  });
  it('una cantidad que no es número no se inventa', () => {
    const r = buildInvoiceDraft({ ...base, currency: 'COP', ctx: { after: { vuelo: 'X', kilos: 'muchos' } }, customerCtx });
    expect(JSON.stringify(r)).toMatch(/no es un número/);
  });
  it('fórmulas de precio y cantidad, en pesos', () => {
    const item = invoiceBodySchema.items.element.parse({ description: 'Kilos', quantity: 1, unitPrice: '={{kilos}} * 0,80 + 10', taxRate: 'iva_0' });
    const r = buildInvoiceDraft({ ...base, currency: 'COP', items: [item], ctx, customerCtx });
    expect(r.ok && r.draft.lines[0]?.unitPrice).toBe(810);
    expect(r.ok && r.draft.total).toBe(810);
  });
  it('llaves de idempotencia estables y distintas por fila', () => {
    expect(invoiceDraftKey('a', 'r1')).toBe(invoiceDraftKey('a', 'r1'));
    expect(invoiceDraftKey('a', 'r1')).not.toBe(invoiceDraftKey('a', 'r2'));
    expect(invoiceDraftKey('a', 'r1')).not.toBe(invoiceDraftKey('b', 'r1'));
  });
  it('lo que se escribe de vuelta en la fila', () => {
    const wb = { invoiceNumber: 'factura', status: { field: 'estado_fact', pending: 'Por facturar', created: 'Facturada' } };
    expect(writeBackValues(wb, 'pending')).toEqual({ estado_fact: 'Por facturar' });
    expect(writeBackValues(wb, 'created', 'FV-1-22')).toEqual({ estado_fact: 'Facturada', factura: 'FV-1-22' });
    expect(writeBackValues(undefined, 'created', 'x')).toEqual({});
  });
});

describe('la regla', () => {
  const rule = {
    name: 'Prefactura al cerrar',
    trigger: { type: 'row_updated', tracker: 'atenciones', field: 'estado', to: 'Cerrada' },
    actions: [
      {
        type: 'accounting_draft_invoice',
        customer: { taxId: '{{nit}}', via: 'vuelo' },
        items: [{ description: 'Atención {{kilos}} kg', productCode: 'SERV-001', quantity: '{{kilos}}', unitPrice: 0.8 }],
        currency: 'USD',
        trm: 4000,
      },
    ],
  };
  it('es válida con una fila y no con un horario; USD pide TRM', () => {
    expect(structuralProblems(automationInputSchema.parse(rule))).toEqual([]);
    const sched = automationInputSchema.parse({ ...rule, trigger: { type: 'schedule', cadence: 'daily', hour: 7 } });
    expect(structuralProblems(sched).join(' ')).toMatch(/parte de una fila/);
    const noTrm = automationInputSchema.parse({ ...rule, actions: [{ ...rule.actions[0], trm: undefined }] });
    expect(structuralProblems(noTrm).join(' ')).toMatch(/falta la TRM/);
  });
});

// ---------------------------------------------------------------------------
// Contra la base de mentira
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
let seq = 0;

const catalog: InvoicingCatalog = {
  documentTypes: [{ id: '24446', name: 'FV electrónica', electronic: true }],
  sellers: [{ id: '629', name: 'Ana' }],
  paymentTypes: [{ id: '5636', name: 'Contado', credit: false }],
  taxes: [{ id: '13156', name: 'IVA 19%', kind: 'iva', percentage: 19 }],
};

function world() {
  const counters: Record<string, number> = {};
  const tables: Record<string, Row[]> = {
    trackers: [
      { id: 't-at', organization_id: ORG, slug: 'atenciones', name: 'Atenciones', description: '', fields: [
        { key: 'nombre', label: 'Atención', type: 'text' },
        { key: 'estado', label: 'Estado', type: 'text' },
        { key: 'kilos', label: 'Kilos', type: 'number' },
        { key: 'vuelo', label: 'Vuelo', type: 'relation', tracker: 'vuelos' },
        { key: 'factura', label: 'Factura', type: 'text' },
        { key: 'fact_estado', label: 'Estado facturación', type: 'text' },
        { key: 'fact_error', label: 'Motivo del error', type: 'text' },
      ], duplicates: null, created_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
      { id: 't-vu', organization_id: ORG, slug: 'vuelos', name: 'Vuelos', description: '', fields: [
        { key: 'nombre', label: 'Vuelo', type: 'text' },
        { key: 'nit', label: 'NIT cliente', type: 'text' },
      ], duplicates: null, created_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
    ],
    tracker_rows: [
      { id: '11111111-1111-4111-a111-aaaaaaaaaaaa', organization_id: ORG, tracker_id: 't-vu', label: 'AV204', values: { nombre: 'AV204', nit: '900123456' }, created_by: 'u1', created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z' },
      { id: 'a1', organization_id: ORG, tracker_id: 't-at', label: 'Atención 1', values: { nombre: 'Atención 1', estado: 'Cerrada', kilos: 1000, vuelo: JSON.stringify({ id: '11111111-1111-4111-a111-aaaaaaaaaaaa', label: 'AV204' }) }, created_by: 'u1', created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z' },
    ],
    custom_apps: [{ id: 'app-1', organization_id: ORG, slug: 'rampa', name: 'Rampa', icon: '', status: 'published', archived_at: null }],
    custom_app_screens: [],
    custom_app_roles: [],
    custom_app_automations: [],
    custom_app_automation_runs: [],
    custom_app_users: [],
    custom_app_members: [],
    users: [{ id: 'u1', organization_id: ORG, role: 'org_admin', email: 'a@a.co' }],
    custom_view_events: [],
    app_invoice_drafts: [],
    clients: [],
    client_contacts: [],
    accounting_connections: [{ id: 'conn-siigo', organization_id: ORG, provider: 'siigo', enabled: true, created_at: '2026-01-01T00:00:00Z', trackers: {}, cursors: {}, entities: ['invoices'] }],
    sales_documents: [],
    sales_document_lines: [],
    sales_document_events: [],
  };
  const fake = createFakeSupabase(tables, {
    sales_next_number: (args) => {
      const k = `${args.p_organization_id}:${args.p_kind}`;
      counters[k] = (counters[k] ?? 0) + 1;
      return counters[k];
    },
  });
  const from = fake.client.from.bind(fake.client);
  const raw = {
    ...fake.client,
    rpc: fake.client.rpc,
    from: (table: string) => {
      // biome-ignore lint/suspicious/noExplicitAny: envuelve el builder del doble
      const qb = from(table) as any;
      const insert = qb.insert.bind(qb);
      const upsert = qb.upsert.bind(qb);
      const fill = (values: Row | Row[]) =>
        (Array.isArray(values) ? values : [values]).map((r) => ({
          id: `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`,
          created_at: '2026-10-19T00:00:00Z',
          updated_at: '2026-10-19T00:00:00Z',
          ...(table === 'sales_documents' ? { share_views: 0, emission_uncertain: false, share_token: null } : {}),
          ...(table === 'app_invoice_drafts' ? { status: 'pending', sales_document_id: null, error: null, decided_by: null, decided_at: null, provider: null, provider_invoice_id: null, provider_number: null, sent_to_dian: null, currency: 'COP' } : {}),
          ...r,
        }));
      qb.insert = (values: Row | Row[]) => {
        const list = fill(values);
        return insert(Array.isArray(values) ? list : list[0]);
      };
      qb.upsert = (values: Row | Row[], opts: unknown) => {
        const list = fill(values);
        return upsert(Array.isArray(values) ? list : list[0], opts);
      };
      return qb;
    },
  } as unknown as SupabaseClient;
  forgetAutomationWatch();
  return { db: createOrgScopedClient(raw, ORG), tables };
}

const RULE_ACTION = {
  type: 'accounting_draft_invoice',
  customer: { taxId: '{{nit}}', via: 'vuelo' },
  items: [{ description: 'Atención {{nombre}} · {{kilos}} kg', productCode: 'SERV-001', quantity: '{{kilos}}', unitPrice: 0.8, taxRate: 'iva_19' }],
  currency: 'USD',
  trm: 4000,
  observations: 'Vuelo {{vuelo}}',
  writeBack: { invoiceNumber: 'factura', status: { field: 'fact_estado', pending: 'Por facturar', created: 'Facturada' } },
  notifyAdmins: true,
  notifyRoles: [],
  paymentForm: 'contado',
  paymentDays: 0,
};

function deps(notified: string[][] = []): AutomationDeps {
  return {
    now: () => NOW,
    baseUrl: 'https://cortex.test',
    signingSecret: 's',
    sendEmail: async () => ({ sent: true }),
    notifyMembers: async (_d, users) => {
      notified.push(users);
      return users.length;
    },
    pushAppUsers: async () => [],
    askCortex: async () => ({ summary: 'ok', staged: 0 }),
  };
}

let q = 0;
function queueRun(tables: Record<string, Row[]>, rowId = 'a1') {
  const run = {
    id: `run-${++q}`, organization_id: ORG, app_id: 'app-1', automation_id: 'r-fact', trigger_ref: 'x', status: 'queued', attempts: 0,
    next_attempt_at: NOW.toISOString(),
    event: { kind: 'row_updated', trackerId: 't-at', rowId, before: { estado: 'En curso' }, after: (tables.tracker_rows?.find((r) => r.id === rowId) as { values: Row }).values, label: 'Atención 1', version: `v${q}`, actor: { kind: 'member', id: 'u1' }, chain: [], depth: 0 },
    result: [], error: null as string | null, ask_cortex_calls: 0, idempotency_key: `r-fact:${q}`, created_at: NOW.toISOString(),
  };
  tables.custom_app_automation_runs?.push(run);
  return run;
}

const addRule = (tables: Record<string, Row[]>, action: Row = RULE_ACTION) =>
  tables.custom_app_automations?.push({
    id: 'r-fact', organization_id: ORG, app_id: 'app-1', name: 'Prefactura al cerrar', enabled: true,
    trigger: { type: 'row_updated', tracker: 'atenciones', field: 'estado', to: 'Cerrada' },
    conditions: [], actions: [action], tracker_id: 't-at', trigger_kind: 'row_updated', created_by: 'u1',
  });

describe('la corrida arma la prefactura y no toca Siigo', () => {
  it('cierra una atención: queda por revisar, con NIT del vuelo, TRM, estado en la fila y aviso', async () => {
    const { db, tables } = world();
    addRule(tables);
    const notified: string[][] = [];
    const run = queueRun(tables);
    const out = await executeRun(db, run.id, ORG, deps(notified));
    expect(out.status).toBe('succeeded');
    const drafts = await listInvoiceDrafts(db);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d).toMatchObject({ status: 'pending', customer_tax_id: '900123456', currency: 'USD', row_id: 'a1', automation_id: 'r-fact' });
    expect(d?.lines[0]).toMatchObject({ quantity: 1000, unitPrice: 3200, productCode: 'SERV-001' });
    expect(d?.total).toBe(3_808_000);
    expect(tables.sales_documents).toHaveLength(0); // nada en Ventas ni en Siigo
    expect((tables.tracker_rows?.find((r) => r.id === 'a1') as { values: Row }).values.fact_estado).toBe('Por facturar');
    expect(notified).toHaveLength(1);
    expect((run.result as Array<{ detail: string }>)[0]?.detail).toMatch(/Nada se envió a Siigo/);
  });

  it('idempotencia: la misma fila no genera dos prefacturas (ni aunque se descarte)', async () => {
    const { db, tables } = world();
    addRule(tables);
    await executeRun(db, queueRun(tables).id, ORG, deps());
    const second = queueRun(tables);
    await executeRun(db, second.id, ORG, deps());
    expect((second.result as Array<{ detail: string }>)[0]?.detail).toMatch(/Ya existía una prefactura/);
    expect(tables.app_invoice_drafts).toHaveLength(1);
    const [d] = await listInvoiceDrafts(db);
    await discardInvoiceDraft(db, d?.id as string, USER);
    const third = queueRun(tables);
    await executeRun(db, third.id, ORG, deps());
    expect(tables.app_invoice_drafts).toHaveLength(1);
    expect((await listInvoiceDrafts(db))[0]?.status).toBe('discarded');
  });

  it('sin NIT en el vuelo la corrida falla con la razón y no crea nada', async () => {
    const { db, tables } = world();
    addRule(tables);
    (tables.tracker_rows?.find((r) => r.id === '11111111-1111-4111-a111-aaaaaaaaaaaa') as { values: Row }).values.nit = '';
    const run = queueRun(tables);
    const out = await executeRun(db, run.id, ORG, deps());
    expect(out.status).toBe('failed');
    expect(run.error).toMatch(/no tiene NIT/);
    expect(tables.app_invoice_drafts).toHaveLength(0);
  });

  it('si la fila no apunta a ningún vuelo, lo dice', async () => {
    const { db, tables } = world();
    addRule(tables);
    (tables.tracker_rows?.find((r) => r.id === 'a1') as { values: Row }).values.vuelo = '';
    const run = queueRun(tables);
    await executeRun(db, run.id, ORG, deps());
    expect(run.error).toMatch(/no apunta a nada/);
  });
});

describe('la bandeja: editar, descartar y aprobar', () => {
  async function pending() {
    const w = world();
    addRule(w.tables);
    await executeRun(w.db, queueRun(w.tables).id, ORG, deps());
    const [d] = await listInvoiceDrafts(w.db);
    return { ...w, id: d?.id as string };
  }
  const siigo = (create: (p: Record<string, unknown>) => Promise<unknown>) => {
    const createInvoice = vi.fn(create as never);
    const session = {
      requests: 0,
      verify: async () => ({ token: null }),
      listPage: async () => ({ records: [], hasMore: false }),
      invoicing: {
        catalog: async () => catalog,
        findCustomer: async (nit: string) => (nit === '900123456' ? { id: 'c1', name: 'Nexa' } : null),
        createInvoice,
      },
    } as unknown as ProviderSession;
    return { createInvoice, openSession: async () => session };
  };
  const ctxOf = (db: SupabaseClient) => ({ db, organizationId: ORG, userId: USER });

  it('editar cambia líneas, NIT y total; un código faltante se ve como problema', async () => {
    const { db, id } = await pending();
    const e = await updateInvoiceDraft(db, id, {
      customerName: 'Nexa SAS',
      lines: [{ description: 'Atención', productCode: null, quantity: 10, unitPrice: 1000, taxRate: 'iva_19' }],
    });
    expect(e.total).toBe(11_900);
    expect(draftProblems(e).join(' ')).toMatch(/código de producto/);
    await expect(approveInvoiceDraft(ctxOf(db), id)).rejects.toThrow(/edita la prefactura/);
  });

  it('aprobar crea la factura en Siigo SIN enviar a la DIAN por defecto y escribe el número en la fila', async () => {
    const { db, tables, id } = await pending();
    const s = siigo(async () => ({ id: 'siigo-77', number: 'FV-1-77', cufe: null, einvoiceStatus: 'Sin enviar', url: null, total: 3_808_000 }));
    const out = await approveInvoiceDraft(ctxOf(db), id, { openSession: s.openSession, today: '2026-10-19' });
    expect(out.draft).toMatchObject({ status: 'created', provider_number: 'FV-1-77', sent_to_dian: false });
    expect(s.createInvoice).toHaveBeenCalledTimes(1);
    const payload = s.createInvoice.mock.calls[0]?.[0] as unknown as { stamp: { send: boolean }; mail: { send: boolean }; items: Array<{ code: string; price: number }> };
    expect(payload.stamp.send).toBe(false);
    expect(payload.mail.send).toBe(false);
    expect(payload.items[0]).toMatchObject({ code: 'SERV-001', price: 3200 });
    const row = tables.tracker_rows?.find((r) => r.id === 'a1') as { values: Row };
    expect(row.values.factura).toBe('FV-1-77');
    expect(row.values.fact_estado).toBe('Facturada');
    // vínculo fila ↔ prefactura ↔ factura
    expect(out.draft.sales_document_id).toBeTruthy();
    expect(out.markdown).toMatch(/SIN enviar a la DIAN/);
  });

  it('sendToDian=true la sella; aprobar dos veces no crea dos facturas', async () => {
    const { db, id } = await pending();
    const s = siigo(async () => ({ id: 'siigo-1', number: 'FV-1-1', cufe: 'abc', einvoiceStatus: 'Pendiente', url: null, total: 1 }));
    const ctx = ctxOf(db);
    const first = await approveInvoiceDraft(ctx, id, { sendToDian: true, openSession: s.openSession, today: '2026-10-19' });
    expect((s.createInvoice.mock.calls[0]?.[0] as unknown as { stamp: { send: boolean } }).stamp.send).toBe(true);
    expect(first.draft.sent_to_dian).toBe(true);
    const again = await approveInvoiceDraft(ctx, id, { openSession: s.openSession, today: '2026-10-19' });
    expect(again.already).toBe(true);
    expect(s.createInvoice).toHaveBeenCalledTimes(1);
  });

  it('un error de Siigo deja la prefactura «con error» y el reintento reutiliza el mismo pedido', async () => {
    const { db, tables, id } = await pending();
    let calls = 0;
    const s = siigo(async () => {
      calls += 1;
      if (calls === 1) throw new (await import('../../../accounting/types')).ProviderValidationError('Siigo rechazó el producto SERV-001.');
      return { id: 'siigo-9', number: 'FV-1-9', cufe: null, einvoiceStatus: null, url: null, total: 1 };
    });
    await expect(approveInvoiceDraft(ctxOf(db), id, { openSession: s.openSession, today: '2026-10-19' })).rejects.toThrow(/rechazó/);
    const [failed] = await listInvoiceDrafts(db);
    expect(failed).toMatchObject({ status: 'error' });
    expect(failed?.error).toMatch(/rechazó/);
    const orders = tables.sales_documents?.filter((r) => r.kind === 'order').length;
    expect(orders).toBe(1);
    await updateInvoiceDraft(db, id, { lines: failed?.lines.map((l) => ({ ...l, productCode: 'SERV-002' })) });
    const ok = await approveInvoiceDraft(ctxOf(db), id, { openSession: s.openSession, today: '2026-10-19' });
    expect(ok.draft.status).toBe('created');
    expect(tables.sales_documents?.filter((r) => r.kind === 'order').length).toBe(1);
    expect((await getSalesDocumentRow(db, ok.draft.sales_document_id as string))?.status).toBe('facturada');
  });

  it('cliente que no existe en Siigo: no se manda nada y se dice qué hacer', async () => {
    const { db, id } = await pending();
    await updateInvoiceDraft(db, id, { customerTaxId: '800555444' });
    const s = siigo(async () => ({ id: 'x' }));
    await expect(approveInvoiceDraft(ctxOf(db), id, { openSession: s.openSession, today: '2026-10-19' })).rejects.toThrow(/no está creado en Siigo/);
    expect(s.createInvoice).not.toHaveBeenCalled();
  });

  it('descartada o creada ya no se descarta ni se edita; descartada no se aprueba', async () => {
    const { db, id } = await pending();
    await discardInvoiceDraft(db, id, USER);
    await expect(approveInvoiceDraft(ctxOf(db), id)).rejects.toThrow(/descartada/);
    await expect(updateInvoiceDraft(db, id, { observations: 'x' })).rejects.toThrow(/ya no se edita/);
  });
});

describe('send: siigo_sin_dian (la aprobación de la fila es la aprobación humana)', () => {
  const SEND_ACTION = {
    ...RULE_ACTION,
    send: 'siigo_sin_dian',
    notifyActor: true,
    writeBack: {
      invoiceNumber: 'factura',
      status: { field: 'fact_estado', created: 'Enviado a Siigo', error: 'Error al enviar a Siigo' },
      errorReason: 'fact_error',
    },
  };
  const siigoDouble = (create: (p: Record<string, unknown>) => Promise<unknown>) => {
    const createInvoice = vi.fn(create as never);
    const session = {
      requests: 0,
      verify: async () => ({ token: null }),
      listPage: async () => ({ records: [], hasMore: false }),
      invoicing: {
        catalog: async () => catalog,
        findCustomer: async (nit: string) => (nit === '900123456' ? { id: 'c1', name: 'Nexa' } : null),
        createInvoice,
      },
    } as unknown as ProviderSession;
    return { createInvoice, emission: { openSession: async () => session, today: '2026-10-19' } };
  };
  const depsWith = (emission: AutomationDeps['emission'], notified: string[][] = []): AutomationDeps => ({ ...deps(notified), emission });
  const rowValues = (tables: Record<string, Row[]>) => (tables.tracker_rows?.find((r) => r.id === 'a1') as { values: Row }).values;

  it('crea la factura en Siigo SIN enviar a la DIAN, escribe número y estado, avisa a quien aprobó y deja rastro sin deshacer', async () => {
    const { db, tables } = world();
    addRule(tables, SEND_ACTION);
    const s = siigoDouble(async () => ({ id: 'siigo-5', number: 'FV-2-380', cufe: null, einvoiceStatus: 'Sin enviar', url: null, total: 3_808_000 }));
    const notified: string[][] = [];
    const run = queueRun(tables);
    const out = await executeRun(db, run.id, ORG, depsWith(s.emission, notified));
    expect(out.status).toBe('succeeded');
    expect(s.createInvoice).toHaveBeenCalledTimes(1);
    const payload = s.createInvoice.mock.calls[0]?.[0] as unknown as { stamp: { send: boolean }; mail: { send: boolean } };
    expect(payload.stamp.send).toBe(false);
    expect(payload.mail.send).toBe(false);
    const [d] = await listInvoiceDrafts(db);
    expect(d).toMatchObject({ status: 'created', provider_number: 'FV-2-380', sent_to_dian: false });
    expect(rowValues(tables)).toMatchObject({ factura: 'FV-2-380', fact_estado: 'Enviado a Siigo' });
    expect(rowValues(tables).fact_error ?? '').toBe('');
    expect(notified[0]).toContain('u1');
    expect((run.result as Array<{ detail: string }>)[0]?.detail).toMatch(/FV-2-380.*SIN enviar a la DIAN/);
    // Rastro externo: cambios sin «antes» (no se pueden deshacer).
    const events = tables.custom_view_events as Array<{ changes: Record<string, { from?: unknown; to?: unknown }>; reason: string }>;
    expect(events).toHaveLength(1);
    expect(Object.values(events[0]?.changes ?? {}).every((c) => c.from === undefined)).toBe(true);
    expect(events[0]?.reason).toMatch(/no se deshace desde Cortex/);
  });

  it('idempotente: volver a disparar la regla no crea otra factura', async () => {
    const { db, tables } = world();
    addRule(tables, SEND_ACTION);
    const s = siigoDouble(async () => ({ id: 'siigo-5', number: 'FV-2-380', cufe: null, einvoiceStatus: null, url: null, total: 1 }));
    await executeRun(db, queueRun(tables).id, ORG, depsWith(s.emission));
    const again = queueRun(tables);
    await executeRun(db, again.id, ORG, depsWith(s.emission));
    expect(s.createInvoice).toHaveBeenCalledTimes(1);
    expect((again.result as Array<{ detail: string }>)[0]?.detail).toMatch(/Ya existía la factura/);
    expect(tables.app_invoice_drafts).toHaveLength(1);
  });

  it('si Siigo rechaza: la fila queda «Error al enviar a Siigo» con el motivo, avisa, y al reintentar usa el mismo pedido sin duplicar', async () => {
    const { db, tables } = world();
    addRule(tables, SEND_ACTION);
    let calls = 0;
    const s = siigoDouble(async () => {
      calls += 1;
      if (calls === 1) throw new (await import('../../../accounting/types')).ProviderValidationError('Siigo rechazó el producto SERV-001.');
      return { id: 'siigo-9', number: 'FV-2-381', cufe: null, einvoiceStatus: null, url: null, total: 1 };
    });
    const notified: string[][] = [];
    const failed = queueRun(tables);
    const out = await executeRun(db, failed.id, ORG, depsWith(s.emission, notified));
    expect(out.status).toBe('failed');
    expect(failed.error).toMatch(/Siigo no aceptó la factura.*rechazó/);
    expect(rowValues(tables)).toMatchObject({ fact_estado: 'Error al enviar a Siigo' });
    expect(String(rowValues(tables).fact_error)).toMatch(/rechazó/);
    expect(notified.flat()).toContain('u1');
    expect((await listInvoiceDrafts(db))[0]).toMatchObject({ status: 'error' });
    // Reintentar = volver a disparar la regla (el botón «Reintentar» devuelve el estado a OK).
    const retry = queueRun(tables);
    const ok = await executeRun(db, retry.id, ORG, depsWith(s.emission));
    expect(ok.status).toBe('succeeded');
    expect(s.createInvoice).toHaveBeenCalledTimes(2);
    expect(tables.sales_documents?.filter((r) => r.kind === 'order')).toHaveLength(1);
    expect(tables.app_invoice_drafts).toHaveLength(1);
    expect(rowValues(tables)).toMatchObject({ factura: 'FV-2-381', fact_estado: 'Enviado a Siigo' });
    expect(rowValues(tables).fact_error ?? '').toBe('');
  });

  it('la regla exige dónde guardar el número de la factura', () => {
    const bad = automationInputSchema.parse({ ...rule2(), actions: [{ ...SEND_ACTION, writeBack: undefined }] });
    expect(structuralProblems(bad).join(' ')).toMatch(/writeBack\.invoiceNumber/);
    const good = automationInputSchema.parse({ ...rule2(), actions: [SEND_ACTION] });
    expect(structuralProblems(good)).toEqual([]);
  });
});

function rule2() {
  return {
    name: 'Factura al aprobar',
    trigger: { type: 'row_updated', tracker: 'atenciones', field: 'estado', to: 'Cerrada' },
    actions: [RULE_ACTION],
  };
}
