import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { ProviderUncertainError, type ProviderSession } from '../../../accounting/types';
import { createFakeSupabase } from '../../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../tenancy/scoped-client';
import { forgetAutomationWatch, emitSyncEvents } from '../emit';
import { type AutomationEvent, matchesTrigger } from '../match';
import { applyPayloadEdit, approveOutboxItem, updateOutboxPayload } from '../outbox-approve';
import { buildCreditNoteDraft, buildCustomerDraft, buildReceiptDraft, describeOutbox, splitInvoiceList } from '../outbox-build';
import { discardInvoiceDraft, getInvoiceDraft, listInvoiceDrafts, outboxDraftProblems } from '../invoice-drafts';
import { type AutomationDeps, executeRun } from '../run';
import { automationInputSchema, structuralProblems, triggerTracker } from '../spec';

/** Conexión en dos vías con Siigo: sucesos contables, recibo, nota crédito y cliente. */

const ORG = 'org-a';
const USER = '11111111-1111-4111-a111-111111111111';
const NOW = new Date('2026-10-20T15:00:00.000Z');
const ev = (over: Partial<AutomationEvent>): AutomationEvent => ({
  kind: 'row_updated',
  trackerSlug: 'siigo_facturas',
  version: 'v',
  actor: { kind: 'system' },
  chain: [],
  depth: 0,
  ...over,
});

describe('el disparador «pasa algo en el programa contable»', () => {
  const trigger = (event: string, provider = 'siigo') =>
    automationInputSchema.parse({ name: 'x', trigger: { type: 'accounting_event', event, provider }, actions: [{ type: 'notify_member', admins: true, title: 't' }] }).trigger;
  it('el proveedor por defecto es Siigo y la tabla se deduce', () => {
    const t = automationInputSchema.parse({ name: 'x', trigger: { type: 'accounting_event', event: 'invoice_paid' }, actions: [{ type: 'notify_member', admins: true, title: 't' }] }).trigger;
    expect(t).toMatchObject({ provider: 'siigo' });
    expect(triggerTracker(t)).toBe('siigo_facturas');
    expect(triggerTracker(trigger('receipt_created', 'alegra'))).toBe('alegra_pagos');
  });
  it('un suceso desconocido se rechaza', () => {
    expect(() => trigger('invoice_exploded')).toThrow();
  });
  it('factura que queda pagada: dispara con antes/después, no sin antes ni dos veces', () => {
    const t = trigger('invoice_paid');
    expect(matchesTrigger(t, ev({ before: { estado: 'Por cobrar' }, after: { estado: 'Pagada' } }), 'siigo_facturas')).toBe(true);
    expect(matchesTrigger(t, ev({ before: { estado: 'Pagada' }, after: { estado: 'Pagada' } }), 'siigo_facturas')).toBe(false);
    expect(matchesTrigger(t, ev({ before: null, after: { estado: 'Pagada' } }), 'siigo_facturas')).toBe(false);
  });
  it('la carga inicial no dispara sucesos contables', () => {
    const t = trigger('invoice_created');
    expect(matchesTrigger(t, ev({ kind: 'row_created', after: { estado: 'Por cobrar' }, backfill: true }), 'siigo_facturas')).toBe(false);
    expect(matchesTrigger(t, ev({ kind: 'row_created', after: { estado: 'Por cobrar' } }), 'siigo_facturas')).toBe(true);
  });
  it('no mezcla programas ni tablas', () => {
    const t = trigger('invoice_created', 'alegra');
    expect(matchesTrigger(t, ev({ kind: 'row_created', trackerSlug: 'siigo_facturas', after: {} }), 'siigo_facturas')).toBe(false);
    expect(matchesTrigger(trigger('invoice_created'), ev({ kind: 'row_created', trackerSlug: 'mis_facturas', after: {} }), 'mis_facturas')).toBe(false);
    expect(matchesTrigger(trigger('customer_created'), ev({ kind: 'row_created', trackerSlug: 'siigo_clientes', after: {} }), 'siigo_clientes')).toBe(true);
  });
  it('otros tipos de suceso (botón, borrado) no cuentan', () => {
    expect(matchesTrigger(trigger('invoice_created'), ev({ kind: 'row_deleted' }), 'siigo_facturas')).toBe(false);
  });
});

describe('las acciones nuevas son válidas y exigen una fila', () => {
  const base = { name: 'x', trigger: { type: 'row_created', tracker: 'pagos_clientes' } };
  const receipt = { type: 'accounting_draft_receipt', customer: { taxId: '{{nit}}' }, amount: '{{valor}}' };
  it('recibo, nota y cliente con sus valores por defecto', () => {
    const r = automationInputSchema.parse({ ...base, actions: [receipt] });
    expect(r.actions[0]).toMatchObject({ notifyAdmins: true, notifyRoles: [] });
    const n = automationInputSchema.parse({ ...base, actions: [{ type: 'accounting_draft_credit_note', invoice: '{{factura}}' }] });
    expect(n.actions[0]).toMatchObject({ mode: 'total', reason: 2 });
    const c = automationInputSchema.parse({ ...base, actions: [{ type: 'accounting_upsert_customer', taxId: '{{nit}}', name: '{{cliente}}' }] });
    expect(c.actions[0]).toMatchObject({ personType: 'auto', regime: 'no_responsable' });
    for (const x of [r, n, c]) expect(structuralProblems(x)).toEqual([]);
  });
  it('con un horario no hay fila de dónde armarlos', () => {
    const sched = automationInputSchema.parse({ name: 'x', trigger: { type: 'schedule', cadence: 'daily', hour: 7 }, actions: [receipt] });
    expect(structuralProblems(sched).join(' ')).toMatch(/parte de una fila/);
  });
  it('motivo DIAN inválido y modo ítems sin ítems', () => {
    expect(() => automationInputSchema.parse({ ...base, actions: [{ type: 'accounting_draft_credit_note', invoice: 'FV-1-1', reason: 5 }] })).toThrow();
    const items = automationInputSchema.parse({ ...base, actions: [{ type: 'accounting_draft_credit_note', invoice: 'FV-1-1', mode: 'items' }] });
    expect(structuralProblems(items).join(' ')).toMatch(/necesita sus líneas/);
    const both = automationInputSchema.parse({
      ...base,
      actions: [{ type: 'accounting_draft_credit_note', invoice: 'FV-1-1', mode: 'total', items: [{ description: 'x', quantity: 1, unitPrice: 1 }] }],
    });
    expect(structuralProblems(both).join(' ')).toMatch(/quita `items`/);
  });
});

// ---------------------------------------------------------------------------
// Armado puro
// ---------------------------------------------------------------------------

const open = [
  { number: 'FV-1-70', externalId: 'i70', balance: 1_000_000, dueOn: '2026-10-30', issuedOn: '2026-10-01' },
  { number: 'FV-1-68', externalId: 'i68', balance: 700_000, dueOn: '2026-10-01', issuedOn: '2026-09-15' },
];
const receiptAction = (over: Record<string, unknown> = {}) =>
  automationInputSchema.parse({
    name: 'x',
    trigger: { type: 'row_created', tracker: 'pagos_clientes' },
    actions: [{ type: 'accounting_draft_receipt', customer: { taxId: '{{nit}}', name: '{{cliente}}' }, amount: '{{valor}}', ...over }],
  }).actions[0] as Parameters<typeof buildReceiptDraft>[0]['action'];
const ctx = { after: { nit: '900.123.456', cliente: 'Avianca', valor: '1.200.000', fecha: '2026-10-19', factura: 'fv-1-68', ref: 'BAN-9' } };

describe('armar el recibo', () => {
  it('cruza contra todas las facturas con saldo, la que vence primero', () => {
    const r = buildReceiptDraft({ action: receiptAction(), ctx, today: '2026-10-20', open, requested: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toMatchObject({ customerTaxId: '900123456', customerName: 'Avianca', amount: 1_200_000, date: '2026-10-20' });
    expect(r.payload.applications.map((a) => [a.invoiceNumber, a.amount])).toEqual([['FV-1-68', 700_000], ['FV-1-70', 500_000]]);
    expect(r.problems).toEqual([]);
  });
  it('fecha, referencia y banco con plantillas', () => {
    const r = buildReceiptDraft({ action: receiptAction({ date: '{{fecha}}', reference: '{{ref}}', bankAccount: 'Bancolombia' }), ctx, today: '2026-10-20', open, requested: [] });
    expect(r.ok && r.payload).toMatchObject({ date: '2026-10-19', reference: 'BAN-9', bankAccount: 'Bancolombia' });
  });
  it('un pago mayor que lo que debe el cliente deja un aviso de anticipo', () => {
    const r = buildReceiptDraft({ action: receiptAction({ amount: 5_000_000 }), ctx, today: '2026-10-20', open, requested: [] });
    expect(r.ok && r.unapplied).toBe(3_300_000);
    expect(r.ok && r.problems.join(' ')).toMatch(/Sobran.*anticipo/);
    expect(r.ok && r.payload.amount).toBe(1_700_000);
  });
  it('facturas pedidas que no están con saldo se señalan', () => {
    const r = buildReceiptDraft({ action: receiptAction({ invoices: 'FV-1-68, FV-1-99' }), ctx, today: '2026-10-20', open: [open[1] as (typeof open)[number]], requested: splitInvoiceList('fv-1-68, FV-1-99') });
    expect(r.ok && r.problems.join(' ')).toMatch(/FV-1-99/);
  });
  it('sin facturas con saldo queda armado pero no aprobable', () => {
    const r = buildReceiptDraft({ action: receiptAction(), ctx, today: '2026-10-20', open: [], requested: [] });
    expect(r.ok && r.problems.join(' ')).toMatch(/No hay facturas/);
  });
  it('un valor ilegible o un NIT vacío detienen el armado', () => {
    expect(buildReceiptDraft({ action: receiptAction(), ctx: { after: { ...ctx.after, valor: 'mucho' } }, today: 'x', open, requested: [] }).ok).toBe(false);
    expect(buildReceiptDraft({ action: receiptAction(), ctx: { after: { ...ctx.after, nit: '' } }, today: 'x', open, requested: [] }).ok).toBe(false);
    expect(buildReceiptDraft({ action: receiptAction({ amount: '={{valor}} * 0' }), ctx, today: 'x', open, requested: [] }).ok).toBe(false);
  });
  it('fórmula en el valor', () => {
    const r = buildReceiptDraft({ action: receiptAction({ amount: '={{valor}} * 0,5' }), ctx, today: '2026-10-20', open, requested: [] });
    expect(r.ok && r.payload.amount).toBe(600_000);
  });
  it('lista de facturas limpia y sin repetidos', () => {
    expect(splitInvoiceList(' fv-1-68 ,FV-1-68;fv-1-70\n')).toEqual(['FV-1-68', 'FV-1-70']);
  });
});

describe('armar la nota crédito y el cliente', () => {
  const noteAction = (over: Record<string, unknown> = {}) =>
    automationInputSchema.parse({ name: 'x', trigger: { type: 'row_created', tracker: 'pagos_clientes' }, actions: [{ type: 'accounting_draft_credit_note', invoice: '{{factura}}', ...over }] }).actions[0] as Parameters<typeof buildCreditNoteDraft>[0]['action'];
  it('toda la factura, con el número limpio y el motivo', () => {
    const r = buildCreditNoteDraft({ action: noteAction({ reason: 1, observations: 'Devuelta {{ref}}' }), ctx, today: '2026-10-20', invoice: { externalId: 'i68', customerTaxId: '900123456' } });
    expect(r.ok && r.payload).toMatchObject({ invoiceNumber: 'FV-1-68', invoiceExternalId: 'i68', mode: 'total', reason: 1, observations: 'Devuelta BAN-9', date: '2026-10-20' });
    expect(r.ok && r.problems).toEqual([]);
  });
  it('por ítems evalúa cantidades y salta las de cero', () => {
    const r = buildCreditNoteDraft({
      action: noteAction({ mode: 'items', items: [{ description: 'Dev {{ref}}', productCode: 'S1', quantity: 2, unitPrice: '={{valor}} / 1000' }, { description: 'Nada', productCode: 'S2', quantity: 0, unitPrice: 5 }] }),
      ctx, today: '2026-10-20', invoice: null,
    });
    expect(r.ok && r.payload.items).toEqual([{ description: 'Dev BAN-9', productCode: 'S1', quantity: 2, unitPrice: 1200, taxRate: 'iva_19' }]);
  });
  it('sin número de factura no se arma', () => {
    expect(buildCreditNoteDraft({ action: noteAction(), ctx: { after: {} }, today: 'x', invoice: null }).ok).toBe(false);
  });
  it('cliente: plantillas, DV y lo que falta', () => {
    const action = automationInputSchema.parse({ name: 'x', trigger: { type: 'row_created', tracker: 'pagos_clientes' }, actions: [{ type: 'accounting_upsert_customer', taxId: '{{nit}}', name: '{{cliente}}', city: 'Cali' }] }).actions[0] as Parameters<typeof buildCustomerDraft>[0]['action'];
    const r = buildCustomerDraft({ action, ctx });
    expect(r.ok && r.payload).toMatchObject({ taxId: '900123456', personType: 'Company', name: 'Avianca', city: { cityCode: '76001' } });
    expect(r.ok && r.problems.join(' ')).toMatch(/dirección.*teléfono/s);
    expect(describeOutbox('customer', (r.ok ? r.payload : {}) as never)).toMatch(/Crear el cliente Avianca \(NIT 900123456-\d\)/);
    expect(buildCustomerDraft({ action, ctx: { after: { nit: 'x' } } }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contra la base de mentira
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
let seq = 0;
const FACT = '22222222-2222-4222-a222-222222222222';

function world() {
  const tables: Record<string, Row[]> = {
    trackers: [
      { id: 't-pg', organization_id: ORG, slug: 'pagos_clientes', name: 'Pagos', description: '', fields: [
        { key: 'nombre', label: 'Pago', type: 'text' }, { key: 'nit', label: 'NIT', type: 'text' }, { key: 'valor', label: 'Valor', type: 'money' },
        { key: 'fecha', label: 'Fecha', type: 'date' }, { key: 'estado', label: 'Estado', type: 'text' }, { key: 'recibo', label: 'Recibo', type: 'text' },
        { key: 'factura', label: 'Factura', type: 'text' },
      ], duplicates: null, created_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
      { id: 't-sf', organization_id: ORG, slug: 'siigo_facturas', name: 'Facturas (Siigo)', description: '', fields: [
        { key: 'numero', label: 'Número', type: 'text' }, { key: 'cliente', label: 'Cliente', type: 'text' }, { key: 'saldo', label: 'Saldo', type: 'money' }, { key: 'estado', label: 'Estado', type: 'text' },
      ], duplicates: null, created_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
      { id: 't-sc', organization_id: ORG, slug: 'siigo_clientes', name: 'Clientes (Siigo)', description: '', fields: [
        { key: 'nombre', label: 'Nombre', type: 'text' }, { key: 'nit', label: 'NIT', type: 'text' },
      ], duplicates: null, created_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
      { id: 't-at', organization_id: ORG, slug: 'atenciones', name: 'Atenciones', description: '', fields: [
        { key: 'nombre', label: 'Atención', type: 'text' }, { key: 'factura', label: 'Factura', type: 'text' }, { key: 'cobro', label: 'Estado de cobro', type: 'text' },
        { key: 'saldo', label: 'Saldo', type: 'money' }, { key: 'pagada_el', label: 'Pagada el', type: 'text' },
      ], duplicates: null, created_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
    ],
    tracker_rows: [
      { id: 'p1', organization_id: ORG, tracker_id: 't-pg', label: 'Pago 1', values: { nombre: 'Pago 1', nit: '900123456', valor: 1_200_000, fecha: '2026-10-19', estado: 'Recibido', factura: 'FV-1-68' }, created_by: 'u1', created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z' },
      { id: FACT, organization_id: ORG, tracker_id: 't-sf', label: 'FV-1-68', external_key: 'i68', values: { numero: 'FV-1-68', cliente: 'Avianca', saldo: 700000, estado: 'Por cobrar' }, created_by: 'u1', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
      { id: 'a1', organization_id: ORG, tracker_id: 't-at', label: 'Atención 1', values: { nombre: 'Atención 1', factura: 'FV-1-68', cobro: 'Por cobrar', saldo: 700000 }, created_by: 'u1', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
      { id: 'a2', organization_id: ORG, tracker_id: 't-at', label: 'Atención 2', values: { nombre: 'Atención 2', factura: 'FV-1-99', cobro: 'Por cobrar', saldo: 5 }, created_by: 'u1', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
    ],
    accounting_invoices: [
      { organization_id: ORG, source_system: 'siigo', source_ref: 'i68', doc_number: 'FV-1-68', client_nit: '900123456', counterparty_name: 'Avianca', total: 700000, balance: 700000, due_on: '2026-10-01', issued_on: '2026-09-15', annulled: false },
      { organization_id: ORG, source_system: 'siigo', source_ref: 'i70', doc_number: 'FV-1-70', client_nit: '900123456', counterparty_name: 'Avianca', total: 1000000, balance: 1000000, due_on: '2026-10-30', issued_on: '2026-10-01', annulled: false },
      { organization_id: ORG, source_system: 'siigo', source_ref: 'i71', doc_number: 'FV-1-71', client_nit: '800197268', counterparty_name: 'Otra', total: 50, balance: 50, due_on: '2026-10-30', issued_on: '2026-10-01', annulled: false },
    ],
    custom_apps: [{ id: 'app-1', organization_id: ORG, slug: 'rampa', name: 'Rampa', icon: '', status: 'published', archived_at: null }],
    custom_app_screens: [], custom_app_roles: [], custom_app_automations: [], custom_app_automation_runs: [], custom_app_users: [], custom_app_members: [],
    users: [{ id: 'u1', organization_id: ORG, role: 'org_admin', email: 'a@a.co' }],
    app_invoice_drafts: [], clients: [], client_contacts: [],
    accounting_connections: [{ id: 'conn-siigo', organization_id: ORG, provider: 'siigo', enabled: true, created_at: '2026-01-01T00:00:00Z', trackers: {}, cursors: {}, entities: ['invoices'] }],
  };
  const fake = createFakeSupabase(tables, {});
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
          created_at: '2026-10-20T00:00:00Z',
          updated_at: '2026-10-20T00:00:00Z',
          ...(table === 'app_invoice_drafts' ? { status: 'pending', sales_document_id: null, error: null, decided_by: null, decided_at: null, provider: null, provider_invoice_id: null, provider_number: null, sent_to_dian: null, currency: 'COP', app_id: null, automation_id: null, choices: {}, write_back: {}, kind: 'invoice', payload: {}, lines: [] } : {}),
          ...r,
        }));
      qb.insert = (values: Row | Row[]) => { const list = fill(values); return insert(Array.isArray(values) ? list : list[0]); };
      qb.upsert = (values: Row | Row[], opts: unknown) => { const list = fill(values); return upsert(Array.isArray(values) ? list : list[0], opts); };
      return qb;
    },
  } as unknown as SupabaseClient;
  forgetAutomationWatch();
  return { db: createOrgScopedClient(raw, ORG), tables };
}

function deps(notified: string[][] = []): AutomationDeps {
  return {
    now: () => NOW, baseUrl: 'https://cortex.test', signingSecret: 's', sendEmail: async () => ({ sent: true }),
    notifyMembers: async (_d, users) => { notified.push(users); return users.length; },
    pushAppUsers: async () => [], askCortex: async () => ({ summary: 'ok', staged: 0 }),
  };
}

let q = 0;
function queue(tables: Record<string, Row[]>, ruleId: string, event: Partial<AutomationEvent> & { trackerId: string; rowId: string }) {
  const rowValues = (tables.tracker_rows?.find((r) => r.id === event.rowId) as { values: Row } | undefined)?.values ?? {};
  const run = {
    id: `run-${++q}`, organization_id: ORG, app_id: 'app-1', automation_id: ruleId, trigger_ref: 'x', status: 'queued', attempts: 0,
    next_attempt_at: NOW.toISOString(),
    event: { kind: 'row_created', before: null, after: rowValues, label: (rowValues.nombre as string | undefined) ?? 'x', version: `v${q}`, actor: { kind: 'system' }, chain: [], depth: 0, ...event },
    result: [], error: null as string | null, ask_cortex_calls: 0, idempotency_key: `${ruleId}:${q}`, created_at: NOW.toISOString(),
  };
  tables.custom_app_automation_runs?.push(run);
  return run;
}

const rule = (tables: Record<string, Row[]>, id: string, trigger: Row, trackerId: string, actions: Row[], kind = String(trigger.type)) =>
  tables.custom_app_automations?.push({ id, organization_id: ORG, app_id: 'app-1', name: id, enabled: true, trigger, conditions: [], actions, tracker_id: trackerId, trigger_kind: kind, created_by: 'u1' });

const RECEIPT_RULE = {
  type: 'accounting_draft_receipt', customer: { taxId: '{{nit}}' }, amount: '{{valor}}', date: '{{fecha}}', reference: 'Pago {{nombre}}',
  writeBack: { invoiceNumber: 'recibo', status: { field: 'estado', pending: 'Recibo por registrar', created: 'Recibo registrado' } },
  notifyAdmins: true, notifyRoles: [],
};

function session(over: Partial<NonNullable<ProviderSession['outbound']>> = {}): ProviderSession {
  return {
    requests: 0,
    verify: async () => ({ token: null }),
    listPage: async () => ({ records: [], hasMore: false }),
    outbound: {
      upsertCustomer: async () => ({ id: 'c1', name: 'X', created: true }),
      createReceipt: async () => ({ id: 'rc1', number: 'RC-1-5', total: 1_200_000 }),
      createCreditNote: async () => ({ id: 'nc1', number: 'NC-1-2', total: 700_000 }),
      ...over,
    },
  } as ProviderSession;
}
const approveCtx = (db: SupabaseClient) => ({ db, organizationId: ORG, userId: USER });

describe('recibo de caja: de la fila al borrador y de ahí a Siigo', () => {
  it('cuando entra un pago arma el recibo contra las facturas del cliente y no toca Siigo', async () => {
    const { db, tables } = world();
    rule(tables, 'r-rc', { type: 'row_created', tracker: 'pagos_clientes' }, 't-pg', [RECEIPT_RULE]);
    const notified: string[][] = [];
    const run = queue(tables, 'r-rc', { trackerId: 't-pg', rowId: 'p1' });
    expect((await executeRun(db, run.id, ORG, deps(notified))).status).toBe('succeeded');
    const [d] = await listInvoiceDrafts(db);
    expect(d).toMatchObject({ kind: 'receipt', status: 'pending', customer_tax_id: '900123456', row_id: 'p1', total: 1_200_000, provider: 'siigo' });
    const apps = (d?.payload as { applications: Array<{ invoiceNumber: string; amount: number }> }).applications;
    expect(apps.map((a) => [a.invoiceNumber, a.amount])).toEqual([['FV-1-68', 700_000], ['FV-1-70', 500_000]]);
    expect((d?.payload as { reference: string }).reference).toBe('Pago Pago 1');
    expect(outboxDraftProblems(d as NonNullable<typeof d>)).toEqual([]);
    expect((tables.tracker_rows?.find((r) => r.id === 'p1') as { values: Row }).values.estado).toBe('Recibo por registrar');
    expect(notified).toHaveLength(1);
    expect((run.result as Array<{ detail: string }>)[0]?.detail).toMatch(/Nada se envió a Siigo/);
  });

  it('idempotente: la misma fila no genera dos recibos, ni aunque se descarte', async () => {
    const { db, tables } = world();
    rule(tables, 'r-rc', { type: 'row_created', tracker: 'pagos_clientes' }, 't-pg', [RECEIPT_RULE]);
    await executeRun(db, queue(tables, 'r-rc', { trackerId: 't-pg', rowId: 'p1' }).id, ORG, deps());
    const second = queue(tables, 'r-rc', { trackerId: 't-pg', rowId: 'p1' });
    await executeRun(db, second.id, ORG, deps());
    expect((second.result as Array<{ detail: string }>)[0]?.detail).toMatch(/Ya existía un borrador de recibo de caja/);
    const [d] = await listInvoiceDrafts(db);
    await discardInvoiceDraft(db, d?.id as string, USER);
    await executeRun(db, queue(tables, 'r-rc', { trackerId: 't-pg', rowId: 'p1' }).id, ORG, deps());
    expect(tables.app_invoice_drafts).toHaveLength(1);
  });

  it('aprobar registra el recibo UNA vez, escribe el número en la fila y reaprobar no duplica', async () => {
    const { db, tables } = world();
    rule(tables, 'r-rc', { type: 'row_created', tracker: 'pagos_clientes' }, 't-pg', [RECEIPT_RULE]);
    await executeRun(db, queue(tables, 'r-rc', { trackerId: 't-pg', rowId: 'p1' }).id, ORG, deps());
    const [d] = await listInvoiceDrafts(db);
    const createReceipt = vi.fn(async () => ({ id: 'rc1', number: 'RC-1-5', total: 1_200_000 }));
    const open = async () => session({ createReceipt });
    const out = await approveOutboxItem(approveCtx(db), d?.id as string, { openSession: open });
    expect(out.draft).toMatchObject({ status: 'created', provider_number: 'RC-1-5' });
    expect(createReceipt).toHaveBeenCalledTimes(1);
    const [, opts] = createReceipt.mock.calls[0] as unknown as [unknown, { idempotencyKey: string }];
    expect(opts.idempotencyKey).toMatch(/^CXO[0-9a-f]{27}$/);
    const values = (tables.tracker_rows?.find((r) => r.id === 'p1') as { values: Row }).values;
    expect(values).toMatchObject({ recibo: 'RC-1-5', estado: 'Recibo registrado' });
    const again = await approveOutboxItem(approveCtx(db), d?.id as string, { openSession: open });
    expect(again.already).toBe(true);
    expect(createReceipt).toHaveBeenCalledTimes(1);
  });

  it('una red cortada deja el borrador con error y reintentar usa la MISMA llave', async () => {
    const { db, tables } = world();
    rule(tables, 'r-rc', { type: 'row_created', tracker: 'pagos_clientes' }, 't-pg', [RECEIPT_RULE]);
    await executeRun(db, queue(tables, 'r-rc', { trackerId: 't-pg', rowId: 'p1' }).id, ORG, deps());
    const [d] = await listInvoiceDrafts(db);
    const keys: string[] = [];
    let fail = true;
    const open = async () =>
      session({
        createReceipt: async (_p, o) => {
          keys.push(o.idempotencyKey);
          if (fail) throw new ProviderUncertainError('La conexión con Siigo se cortó: no se sabe si quedó creada.');
          return { id: 'rc1', number: 'RC-1-5', total: 1 };
        },
      });
    await expect(approveOutboxItem(approveCtx(db), d?.id as string, { openSession: open })).rejects.toThrow(/no se sabe si quedó creada/);
    expect((await getInvoiceDraft(db, d?.id as string))?.status).toBe('error');
    fail = false;
    const out = await approveOutboxItem(approveCtx(db), d?.id as string, { openSession: open });
    expect(out.draft.status).toBe('created');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('con problemas (sin facturas con saldo) no se puede aprobar y nada sale', async () => {
    const { db, tables } = world();
    tables.accounting_invoices = [];
    rule(tables, 'r-rc', { type: 'row_created', tracker: 'pagos_clientes' }, 't-pg', [RECEIPT_RULE]);
    await executeRun(db, queue(tables, 'r-rc', { trackerId: 't-pg', rowId: 'p1' }).id, ORG, deps());
    const [d] = await listInvoiceDrafts(db);
    const createReceipt = vi.fn();
    await expect(approveOutboxItem(approveCtx(db), d?.id as string, { openSession: async () => session({ createReceipt }) })).rejects.toThrow(/No hay facturas/);
    expect(createReceipt).not.toHaveBeenCalled();
  });

  it('editar el cruce antes de aprobar', async () => {
    const { db, tables } = world();
    rule(tables, 'r-rc', { type: 'row_created', tracker: 'pagos_clientes' }, 't-pg', [RECEIPT_RULE]);
    await executeRun(db, queue(tables, 'r-rc', { trackerId: 't-pg', rowId: 'p1' }).id, ORG, deps());
    const [d] = await listInvoiceDrafts(db);
    const edited = await updateOutboxPayload(db, d?.id as string, { receipt: { applications: [{ invoiceNumber: 'FV-1-70', amount: 1_200_000 }], reference: 'otra' } });
    expect(edited.total).toBe(1_200_000);
    expect((edited.payload as { applications: unknown[]; reference: string }).applications).toHaveLength(1);
    expect((edited.payload as { reference: string }).reference).toBe('otra');
    await expect(updateOutboxPayload(db, d?.id as string, { receipt: { date: 'ayer' } })).rejects.toThrow();
  });
});

describe('cliente', () => {
  const CUSTOMER_RULE = { type: 'accounting_upsert_customer', taxId: '{{nit}}', name: '{{nombre}}', city: 'Bogotá', address: 'Calle 1', phone: '3001112233', email: 'a@b.co', notifyAdmins: false, notifyRoles: [] };
  it('si el NIT ya está sincronizado desde Siigo no arma nada', async () => {
    const { db, tables } = world();
    tables.tracker_rows?.push({ id: 'sc1', organization_id: ORG, tracker_id: 't-sc', label: 'Avianca', values: { nombre: 'Avianca', nit: '900123456-8' }, created_at: 'x', updated_at: 'x' });
    rule(tables, 'r-c', { type: 'row_created', tracker: 'pagos_clientes' }, 't-pg', [CUSTOMER_RULE]);
    const run = queue(tables, 'r-c', { trackerId: 't-pg', rowId: 'p1' });
    await executeRun(db, run.id, ORG, deps());
    expect((run.result as Array<{ detail: string }>)[0]?.detail).toMatch(/ya está en Siigo/);
    expect(tables.app_invoice_drafts).toHaveLength(0);
  });
  it('si no está, arma el cliente completo y al aprobar lo crea', async () => {
    const { db, tables } = world();
    rule(tables, 'r-c', { type: 'row_created', tracker: 'pagos_clientes' }, 't-pg', [CUSTOMER_RULE]);
    await executeRun(db, queue(tables, 'r-c', { trackerId: 't-pg', rowId: 'p1' }).id, ORG, deps());
    const [d] = await listInvoiceDrafts(db);
    expect(d).toMatchObject({ kind: 'customer', customer_tax_id: '900123456' });
    expect(outboxDraftProblems(d as NonNullable<typeof d>)).toEqual([]);
    const upsertCustomer = vi.fn(async () => ({ id: 'c77', name: 'Pago 1', created: true }));
    const out = await approveOutboxItem(approveCtx(db), d?.id as string, { openSession: async () => session({ upsertCustomer }) });
    expect(upsertCustomer).toHaveBeenCalledTimes(1);
    expect(out.draft).toMatchObject({ status: 'created', provider_invoice_id: 'c77' });
    expect(out.markdown).toMatch(/se creó en Siigo/);
  });
  it('lo que falta (teléfono) bloquea la aprobación hasta corregirlo en la bandeja', async () => {
    const { db, tables } = world();
    rule(tables, 'r-c', { type: 'row_created', tracker: 'pagos_clientes' }, 't-pg', [{ ...CUSTOMER_RULE, phone: undefined }]);
    await executeRun(db, queue(tables, 'r-c', { trackerId: 't-pg', rowId: 'p1' }).id, ORG, deps());
    const [d] = await listInvoiceDrafts(db);
    expect(outboxDraftProblems(d as NonNullable<typeof d>).join(' ')).toMatch(/teléfono/);
    const upsertCustomer = vi.fn(async () => ({ id: 'c', name: 'x', created: true }));
    await expect(approveOutboxItem(approveCtx(db), d?.id as string, { openSession: async () => session({ upsertCustomer }) })).rejects.toThrow(/teléfono/);
    const fixed = await updateOutboxPayload(db, d?.id as string, { customer: { phone: '601 555 1234' } });
    expect(outboxDraftProblems(fixed)).toEqual([]);
    await approveOutboxItem(approveCtx(db), d?.id as string, { openSession: async () => session({ upsertCustomer }) });
    expect(upsertCustomer).toHaveBeenCalledTimes(1);
  });
  it('editar el NIT recalcula el dígito y rechaza uno que no cuadra', () => {
    const base = { taxId: '900123456', dv: '8', idType: '31', personType: 'Company', name: 'A', email: null, phone: null, address: null, city: null, vatResponsible: false };
    const ok = applyPayloadEdit('customer', base, { customer: { taxId: '800197268' } });
    expect(ok.payload).toMatchObject({ taxId: '800197268', dv: '4' });
    expect(() => applyPayloadEdit('customer', base, { customer: { taxId: '800197268-9' } })).toThrow(/no cuadra/);
  });
});

describe('nota crédito', () => {
  const NOTE_RULE = { type: 'accounting_draft_credit_note', invoice: '{{factura}}', reason: 2, observations: 'Anulada: {{nombre}}', notifyAdmins: false, notifyRoles: [] };
  it('al anular arma la nota contra la factura (con su id de Siigo) y al aprobar la crea; el DIAN sólo si se pide', async () => {
    const { db, tables } = world();
    rule(tables, 'r-n', { type: 'row_updated', tracker: 'pagos_clientes', field: 'estado', to: 'Anulado' }, 't-pg', [NOTE_RULE]);
    await executeRun(db, queue(tables, 'r-n', { kind: 'row_updated', trackerId: 't-pg', rowId: 'p1', before: { estado: 'Recibido' } }).id, ORG, deps());
    const [d] = await listInvoiceDrafts(db);
    expect(d).toMatchObject({ kind: 'credit_note', customer_tax_id: '900123456' });
    expect(d?.payload).toMatchObject({ invoiceNumber: 'FV-1-68', invoiceExternalId: 'i68', mode: 'total', reason: 2 });
    const createCreditNote = vi.fn(async () => ({ id: 'nc1', number: 'NC-1-2', total: 700_000 }));
    const out = await approveOutboxItem(approveCtx(db), d?.id as string, { openSession: async () => session({ createCreditNote }) });
    expect(out.draft).toMatchObject({ status: 'created', provider_number: 'NC-1-2', sent_to_dian: false });
    expect((createCreditNote.mock.calls[0] as unknown as [unknown, { stamp: boolean }])[1].stamp).toBe(false);
  });
  it('factura que todavía no se sincronizó: queda armada con un aviso', async () => {
    const { db, tables } = world();
    rule(tables, 'r-n', { type: 'row_created', tracker: 'pagos_clientes' }, 't-pg', [{ ...NOTE_RULE, invoice: 'FV-9-9' }]);
    await executeRun(db, queue(tables, 'r-n', { trackerId: 't-pg', rowId: 'p1' }).id, ORG, deps());
    const [d] = await listInvoiceDrafts(db);
    expect(d?.payload).toMatchObject({ invoiceNumber: 'FV-9-9', invoiceExternalId: null });
  });
});

describe('Siigo → app: factura pagada actualiza la fila y avisa', () => {
  const PAID_RULE = [
    { type: 'update_rows', tracker: 'atenciones', where: [{ field: 'factura', op: 'eq', value: '{{numero}}' }], set: { cobro: 'Cobrada', saldo: '{{saldo}}', pagada_el: '{{hoy}}' } },
    { type: 'notify_member', admins: true, title: 'Factura {{numero}} pagada ({{cliente}})', roles: [], members: [] },
  ];
  const paidTrigger = { type: 'accounting_event', event: 'invoice_paid', provider: 'siigo' };

  it('la sincronización compara antes y después y encola la regla SÓLO si pasó a Pagada', async () => {
    const { db, tables } = world();
    rule(tables, 'r-paid', paidTrigger, 't-sf', PAID_RULE);
    // La sincronización dejó la fila en Pagada.
    const row = tables.tracker_rows?.find((r) => r.id === FACT) as { values: Row; updated_at: string };
    row.values = { ...row.values, saldo: 0, estado: 'Pagada' };
    row.updated_at = '2026-10-20T14:59:00Z';
    const befores = new Map<string, Record<string, string | number>>([['i68', { numero: 'FV-1-68', cliente: 'Avianca', saldo: 700000, estado: 'Por cobrar' }]]);
    const n = await emitSyncEvents(db, { id: 't-sf', slug: 'siigo_facturas' }, '2026-10-20T14:00:00Z', { befores });
    expect(n).toBe(1);
    expect(tables.custom_app_automation_runs).toHaveLength(1);
    // Otra vez la misma fila ya pagada, sin cambio de estado: nada.
    forgetAutomationWatch();
    tables.custom_app_automation_runs = [];
    const same = new Map<string, Record<string, string | number>>([['i68', { estado: 'Pagada' }]]);
    expect(await emitSyncEvents(db, { id: 't-sf', slug: 'siigo_facturas' }, '2026-10-20T14:00:00Z', { befores: same })).toBe(0);
  });

  it('la carga inicial (backfill) no dispara nada', async () => {
    const { db, tables } = world();
    rule(tables, 'r-paid', paidTrigger, 't-sf', PAID_RULE);
    const row = tables.tracker_rows?.find((r) => r.id === FACT) as { values: Row; updated_at: string };
    row.values = { ...row.values, estado: 'Pagada' };
    row.updated_at = '2026-10-20T14:59:00Z';
    const befores = new Map<string, Record<string, string | number>>([['i68', { estado: 'Por cobrar' }]]);
    expect(await emitSyncEvents(db, { id: 't-sf', slug: 'siigo_facturas' }, '2026-10-20T14:00:00Z', { befores, backfill: true })).toBe(0);
  });

  it('la corrida actualiza la atención de esa factura (y sólo esa), con saldo y fecha de hoy, y avisa', async () => {
    const { db, tables } = world();
    rule(tables, 'r-paid', paidTrigger, 't-sf', PAID_RULE);
    const row = tables.tracker_rows?.find((r) => r.id === FACT) as { values: Row };
    row.values = { numero: 'FV-1-68', cliente: 'Avianca', saldo: 0, estado: 'Pagada' };
    const notified: string[][] = [];
    const run = queue(tables, 'r-paid', { kind: 'row_updated', trackerId: 't-sf', trackerSlug: 'siigo_facturas', rowId: FACT, before: { estado: 'Por cobrar', saldo: 700000 }, after: row.values as Record<string, string | number> });
    const out = await executeRun(db, run.id, ORG, deps(notified));
    expect(out.status).toBe('succeeded');
    const a1 = (tables.tracker_rows?.find((r) => r.id === 'a1') as { values: Row }).values;
    const a2 = (tables.tracker_rows?.find((r) => r.id === 'a2') as { values: Row }).values;
    expect(a1).toMatchObject({ cobro: 'Cobrada', saldo: 0 });
    expect(String(a1.pagada_el)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(a2).toMatchObject({ cobro: 'Por cobrar', saldo: 5 });
    expect(notified).toHaveLength(1);
  });

  it('una regla sin tabla sincronizada se rechaza al guardar con la guía para conectar', async () => {
    const { db, tables } = world();
    tables.trackers = (tables.trackers ?? []).filter((t) => t.slug !== 'siigo_facturas');
    const { createAutomation } = await import('../store');
    await expect(
      createAutomation(db, 'app-1', { name: 'x', trigger: { type: 'accounting_event', event: 'invoice_paid' }, actions: [{ type: 'notify_member', admins: true, title: 't' }] }, USER),
    ).rejects.toThrow(/conecta Siigo/i);
  });
});

describe('probar con una fila de ejemplo (simulación)', () => {
  it('«factura pagada»: la fila de ejemplo se lleva a Pagada y la regla dice qué cambiaría, sin escribir', async () => {
    const { simulateAutomation } = await import('../simulate');
    const { db, tables } = world();
    const out = await simulateAutomation(
      db,
      { id: 'app-1', name: 'Rampa', slug: 'rampa' },
      automationInputSchema.parse({
        name: 'x',
        trigger: { type: 'accounting_event', event: 'invoice_paid' },
        actions: [
          { type: 'update_rows', tracker: 'atenciones', where: [{ field: 'factura', op: 'eq', value: '{{numero}}' }], set: { cobro: 'Cobrada', saldo: '{{saldo}}' } },
          { type: 'notify_member', admins: true, title: 'Factura {{numero}} pagada' },
        ],
      }),
    );
    expect(out.triggers).toBe(true);
    expect(out.sample?.label).toBe('FV-1-68');
    expect(out.actions[0]?.summary).toMatch(/Atención 1/);
    expect(out.actions[1]?.summary).toMatch(/FV-1-68 pagada/);
    expect((tables.tracker_rows?.find((r) => r.id === 'a1') as { values: Row }).values.cobro).toBe('Por cobrar');
  });
  it('recibo, nota y cliente se describen sin hacer nada', async () => {
    const { simulateAutomation } = await import('../simulate');
    const { db, tables } = world();
    const out = await simulateAutomation(
      db,
      { id: 'app-1', name: 'Rampa', slug: 'rampa' },
      automationInputSchema.parse({
        name: 'x',
        trigger: { type: 'row_created', tracker: 'pagos_clientes' },
        actions: [
          { type: 'accounting_draft_receipt', customer: { taxId: '{{nit}}' }, amount: '{{valor}}' },
          { type: 'accounting_draft_credit_note', invoice: '{{factura}}' },
          { type: 'accounting_upsert_customer', taxId: '{{nit}}', name: '{{nombre}}' },
        ],
      }),
    );
    expect(out.actions.map((a) => a.summary).join('\n')).toMatch(/recibo de caja.*900123456.*POR REVISAR/s);
    expect(out.actions[1]?.summary).toMatch(/nota crédito.*FV-1-68/);
    expect(out.actions[2]?.summary).toMatch(/cliente «Pago 1»/);
    expect(tables.app_invoice_drafts).toHaveLength(0);
  });
});
