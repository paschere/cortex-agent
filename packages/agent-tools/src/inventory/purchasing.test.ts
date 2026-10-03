import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Tables, createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { collectReposicion } from './autopilot-collect';
import { buildMimeWithAttachment, purchaseOrderEmail, renderPurchaseOrderPdf } from './document';
import { pdfImageFrom } from './pdf';
import { importAccountingProducts, importSheetProducts, listProducts } from './products';
import {
  approvePurchaseOrder,
  buildReorderPlan,
  cancelPurchaseOrder,
  createOrdersFromSuggestions,
  listOpenPurchaseOrders,
  markPurchaseOrderInvoiced,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from './purchasing';
import { parseCsv, parseProductSheet } from './sheet';
import { applyStockCount, levelsToStock, loadLevels, recordMovements } from './stock';

/**
 * EL CAMINO ENTERO, CONTRA UNA BASE DE MENTIRA CON DOS EMPRESAS.
 *
 * Hoja → productos y existencias → movimientos con costo promedio → sugerencias
 * → órdenes por proveedor → aprobación (cola) → libro de plata → recepción
 * parcial y total → factura del proveedor. Acme y Globex comparten proveedor y
 * código de producto: nada de Globex puede aparecer en las cifras de Acme.
 *
 * El doble de PostgREST (tenancy/__tests__/fake-postgrest.ts) ejecuta filtros
 * de verdad; aquí se le agregan los valores por defecto de 0183, la llave única
 * de `stock_movements.dedupe_key` y la vista `stock_levels`.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';
const ANA = '11111111-1111-4111-8111-111111111111'; // dueña de Acme
const BETO = '22222222-2222-4222-8222-222222222222'; // Acme, sin permisos
const TODAY = '2026-10-03';

const DEFAULTS: Record<string, Record<string, unknown>> = {
  products: {
    unit: 'und',
    track_stock: true,
    currency: 'COP',
    source: 'manual',
    stock_from: 'cortex',
    active: true,
    cost: null,
    price: null,
    min_stock: null,
    reorder_qty: null,
    lead_time_days: null,
    preferred_supplier_id: null,
    sku: null,
    category: null,
    source_system: null,
    source_ref: null,
  },
  stock_locations: {
    is_default: false,
    active: true,
    code: null,
    source_system: null,
    source_ref: null,
  },
  purchase_orders: {
    status: 'borrador',
    currency: 'COP',
    payment_terms_days: 30,
    origin: 'manual',
    approval_id: null,
    approved_at: null,
    approved_by: null,
    sent_at: null,
    payable_id: null,
    expected_on: null,
  },
  purchase_order_lines: { qty_received: 0, tax_rate: 0, unit: 'und' },
  stock_movements: { reference_kind: 'manual', dedupe_key: null },
};

let seq = 0;
function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

function rejected(code: string) {
  const result = { data: null, error: { code, message: 'duplicate key' } };
  const chain: Record<string, unknown> = {
    select: () => chain,
    single: () => chain,
    maybeSingle: () => chain,
    // biome-ignore lint/suspicious/noThenProperty: imita el builder de PostgREST
    then: (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok),
  };
  return chain;
}

function world(tables: Tables) {
  const fake = createFakeSupabase(tables);
  const raw = {
    ...fake.client,
    from(table: string) {
      if (table === 'stock_levels') {
        const sums = new Map<string, Record<string, unknown>>();
        for (const m of tables.stock_movements ?? []) {
          const key = `${m.organization_id}|${m.product_id}|${m.location_id}`;
          const row = sums.get(key) ?? {
            organization_id: m.organization_id,
            product_id: m.product_id,
            location_id: m.location_id,
            on_hand: 0,
            last_movement_on: null,
            movements: 0,
          };
          row.on_hand = Number(row.on_hand) + Number(m.qty);
          row.movements = Number(row.movements) + 1;
          if (!row.last_movement_on || String(m.occurred_on) > String(row.last_movement_on))
            row.last_movement_on = m.occurred_on;
          sums.set(key, row);
        }
        tables.stock_levels = [...sums.values()];
      }
      const q = fake.client.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const insert = q.insert?.bind(q);
      if (insert)
        q.insert = (values: unknown) => {
          const list = (Array.isArray(values) ? values : [values]) as Array<
            Record<string, unknown>
          >;
          const filled = list.map(
            (v): Record<string, unknown> => ({
              id: uuid(),
              created_at: `${TODAY}T12:00:00Z`,
              ...(DEFAULTS[table] ?? {}),
              ...v,
            }),
          );
          if (table === 'stock_movements')
            for (const row of filled)
              if (
                row.dedupe_key &&
                (tables.stock_movements ?? []).some(
                  (m) =>
                    m.organization_id === row.organization_id && m.dedupe_key === row.dedupe_key,
                )
              )
                return rejected('23505');
          return insert(Array.isArray(values) ? filled : filled[0]);
        };
      return q;
    },
  } as unknown as SupabaseClient;
  return {
    acme: createOrgScopedClient(raw, ACME),
    globex: createOrgScopedClient(raw, GLOBEX),
    tables,
  };
}

function fixture(): Tables {
  return {
    users: [
      { id: ANA, organization_id: ACME, role: 'org_admin', email: 'ana@acme.co' },
      { id: BETO, organization_id: ACME, role: 'member', email: 'beto@acme.co' },
    ],
    agents: [
      { id: 'agent-acme', organization_id: ACME, slug: 'cortex' },
      { id: 'agent-globex', organization_id: GLOBEX, slug: 'cortex' },
    ],
    suppliers: [
      {
        id: 'sup-acme',
        organization_id: ACME,
        name: 'Ferretería Central',
        nit: '900123456',
        email: 'ventas@ferreteria.co',
        payment_terms_days: 45,
        approver_id: null,
      },
      {
        id: 'sup-globex',
        organization_id: GLOBEX,
        name: 'Ferretería Central',
        nit: '900123456',
        email: 'x@y.co',
        payment_terms_days: 30,
        approver_id: null,
      },
    ],
    products: [],
    stock_locations: [],
    stock_movements: [],
    purchase_orders: [],
    purchase_order_lines: [],
    ledger_movements: [],
    mcp_pending_actions: [],
    ba_member: [],
    ba_organization: [],
  };
}

describe('inventario y compras, de punta a punta', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    seq = 0;
    w = world(fixture());
  });

  async function seed() {
    const sheet = parseProductSheet(
      parseCsv(
        'Código,Producto,Existencias,Mínimo,Cantidad a pedir,Costo,Días de entrega\nT-10,Tornillo 10mm,20,50,200,300,5\nG-1,Guantes,100,10,,12000,\n',
      ),
    );
    await importSheetProducts(w.acme, sheet.drafts, { userId: ANA, today: TODAY });
    // Globex tiene el mismo código y muy poco: nunca debe aparecer en Acme.
    await importSheetProducts(
      w.globex,
      sheet.drafts.slice(0, 1).map((d) => ({ ...d, stock: 1 })),
      {
        today: TODAY,
      },
    );
    const products = await listProducts(w.acme);
    const tornillo = products.find((p) => p.sku === 'T-10');
    if (!tornillo) throw new Error('no se importó');
    w.tables.products = (w.tables.products ?? []).map((p) =>
      p.organization_id === ACME && p.sku === 'T-10'
        ? { ...p, preferred_supplier_id: 'sup-acme' }
        : p,
    );
    return { tornillo, guantes: products.find((p) => p.sku === 'G-1') };
  }

  it('la hoja crea productos con su existencia, aislados por empresa', async () => {
    const { tornillo, guantes } = await seed();
    expect(tornillo.onHand).toBe(20);
    expect(tornillo.cost).toBe(300);
    expect(guantes?.onHand).toBe(100);
    const globex = await listProducts(w.globex);
    expect(globex).toHaveLength(1);
    expect(globex[0]?.onHand).toBe(1);
  });

  it('una entrada con costo mueve el promedio; un conteo ajusta la diferencia', async () => {
    const { tornillo } = await seed();
    const r = await recordMovements(
      w.acme,
      [{ productId: tornillo.id, kind: 'entrada', qty: 20, unitCost: 500 }],
      { userId: ANA, today: TODAY },
    );
    expect(r.costs.get(tornillo.id)).toBe(400); // (20×300 + 20×500) / 40
    const count = await applyStockCount(w.acme, {
      lines: [{ productId: tornillo.id, counted: 37 }],
      userId: ANA,
      today: TODAY,
    });
    expect(count.adjusted).toBe(1);
    expect(count.value).toBe(-1200); // faltaron 3 a $400
    const stock = levelsToStock(await loadLevels(w.acme, [tornillo.id]));
    expect(stock.get(tornillo.id)?.total).toBe(37);
  });

  it('de la sugerencia a la factura del proveedor', async () => {
    const { tornillo } = await seed();
    const plan = await buildReorderPlan(w.acme, { today: TODAY });
    expect(plan.suggestions.map((s) => s.productId)).toEqual([tornillo.id]);
    expect(plan.suggestions[0]?.qty).toBe(200);

    const { created, withoutSupplier } = await createOrdersFromSuggestions(w.acme, {
      today: TODAY,
      userId: BETO,
    });
    expect(withoutSupplier).toHaveLength(0);
    expect(created).toHaveLength(1);
    const po = created[0];
    if (!po) throw new Error('sin orden');
    expect(po.label).toBe('OC-0001');
    expect(po.total).toBe(60_000);
    expect(po.termsDays).toBe(45);
    expect(po.supplierEmail).toBe('ventas@ferreteria.co');

    // Lo pedido cuenta como en camino: no se vuelve a sugerir.
    expect((await buildReorderPlan(w.acme, { today: TODAY })).suggestions).toHaveLength(0);

    // Beto pide aprobación: queda en la cola de Ana (la administradora).
    const submitted = await submitPurchaseOrder(w.acme, po.id, { userId: BETO });
    expect(submitted.status).toBe('por_aprobar');
    const approval = (w.tables.mcp_pending_actions ?? [])[0];
    expect(approval).toMatchObject({
      user_id: ANA,
      tool_id: 'purchasing.send_po',
      organization_id: ACME,
    });
    expect((approval?.input as Record<string, unknown>).expectedTotal).toBe(60_000);

    // Beto no puede aprobar; Ana sí, y el libro ve lo comprometido.
    await expect(
      approvePurchaseOrder(w.acme, po.id, { userId: BETO, today: TODAY }),
    ).rejects.toThrow(/administra/);
    await expect(
      approvePurchaseOrder(w.acme, po.id, { userId: ANA, today: TODAY, expectedTotal: 1 }),
    ).rejects.toThrow(/cambió/);
    const approved = await approvePurchaseOrder(w.acme, po.id, { userId: ANA, today: TODAY });
    expect(approved.status).toBe('aprobada');
    const ledger = (w.tables.ledger_movements ?? []).filter((m) => m.source_ref === `oc:${po.id}`);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      kind: 'payable',
      status: 'expected',
      amount: 60_000,
      due_date: '2026-11-22', // llega el 8 (5 días de entrega) + 45 de plazo
      organization_id: ACME,
    });

    // Para cuentas por pagar: abierta, por NIT con o sin DV.
    expect(
      (await listOpenPurchaseOrders(w.acme, { supplierTaxId: '900.123.456-1' })).map((p) => p.id),
    ).toEqual([po.id]);
    expect(await listOpenPurchaseOrders(w.globex, { supplierTaxId: '900123456' })).toHaveLength(0);

    // Recepción parcial, repetida sin duplicar, y luego el resto.
    const line = approved.lines[0];
    if (!line) throw new Error('sin línea');
    const part = await receivePurchaseOrder(w.acme, po.id, {
      quantities: new Map([[line.id, 80]]),
      userId: ANA,
      today: TODAY,
    });
    expect(part.po.status).toBe('recibida_parcial');
    expect(part.po.lines[0]?.qtyReceived).toBe(80);
    const rest = await receivePurchaseOrder(w.acme, po.id, { userId: ANA, today: TODAY });
    expect(rest.po.status).toBe('recibida');
    const stock = levelsToStock(await loadLevels(w.acme, [tornillo.id]));
    expect(stock.get(tornillo.id)?.total).toBe(220);
    await expect(
      receivePurchaseOrder(w.acme, po.id, { userId: ANA, today: TODAY }),
    ).rejects.toThrow(/ya se recibió/);

    // La factura del proveedor la cubre: el esperado sale del libro.
    const invoiced = await markPurchaseOrderInvoiced(w.acme, po.id, 'payable-1', { today: TODAY });
    expect(invoiced.status).toBe('facturada');
    expect(await markPurchaseOrderInvoiced(w.acme, po.id, 'payable-1')).toMatchObject({
      status: 'facturada',
    });
    await expect(markPurchaseOrderInvoiced(w.acme, po.id, 'payable-2')).rejects.toThrow(
      /otra factura/,
    );
    const after = (w.tables.ledger_movements ?? []).find((m) => m.source_ref === `oc:${po.id}`);
    expect(after?.status).toBe('cancelled');
    expect(await listOpenPurchaseOrders(w.acme)).toHaveLength(0);
  });

  it('cancelar una orden por aprobar retira su aprobación', async () => {
    await seed();
    const { created } = await createOrdersFromSuggestions(w.acme, { today: TODAY, userId: ANA });
    const po = created[0];
    if (!po) throw new Error('sin orden');
    await submitPurchaseOrder(w.acme, po.id, { userId: ANA });
    expect(w.tables.mcp_pending_actions).toHaveLength(1);
    const cancelled = await cancelPurchaseOrder(w.acme, po.id, { today: TODAY, reason: 'ya no' });
    expect(cancelled.status).toBe('cancelada');
    expect(w.tables.mcp_pending_actions).toHaveLength(0);
  });

  it('el programa contable trae productos y existencias; re-importar no escribe', async () => {
    const records = [
      {
        externalId: 'sg-1',
        name: 'Cemento gris',
        code: 'CEM-50',
        kind: 'Producto' as const,
        price: 32_000,
        stock: 40,
        warehouses: [
          { externalId: 'w1', name: 'Principal', quantity: 30 },
          { externalId: 'w2', name: 'Obra', quantity: 10 },
        ],
      },
      { externalId: 'sg-2', name: 'Asesoría', kind: 'Servicio' as const, price: 100_000 },
    ];
    const first = await importAccountingProducts(w.acme, {
      provider: 'siigo',
      records,
      today: TODAY,
    });
    expect(first).toEqual({ created: 2, updated: 0, adjusted: 2 });
    const second = await importAccountingProducts(w.acme, {
      provider: 'siigo',
      records,
      today: TODAY,
    });
    expect(second).toEqual({ created: 0, updated: 0, adjusted: 0 });
    const moved = await importAccountingProducts(w.acme, {
      provider: 'siigo',
      records: [
        { ...records[0], warehouses: [{ externalId: 'w1', name: 'Principal', quantity: 25 }] },
      ],
      today: TODAY,
    } as Parameters<typeof importAccountingProducts>[1]);
    expect(moved.adjusted).toBe(1);
    const products = await listProducts(w.acme);
    expect(products.find((p) => p.sku === 'CEM-50')).toMatchObject({
      onHand: 35,
      stockFrom: 'accounting',
    });
    expect(products.find((p) => p.name === 'Asesoría')).toMatchObject({
      onHand: null,
      trackStock: false,
    });
  });
});

describe('el piloto y el papel', () => {
  it('una pregunta con las órdenes listas; sin proveedor, sólo avisa', () => {
    const items = collectReposicion(
      {
        count: 3,
        belowMin: 3,
        orders: 2,
        amount: 1_500_000,
        currency: 'COP',
        withoutSupplier: 1,
        productIds: ['a', 'b'],
        suppliers: ['Ferretería', 'Pinturas'],
      },
      TODAY,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe(
      '3 productos bajo el mínimo → 2 órdenes de compra listas para aprobar',
    );
    expect(items[0]?.effect).toBe('money');
    expect(items[0]?.proposedAction?.toolId).toBe('purchasing.create_po');
    expect(items[0]?.why).toContain('no tiene proveedor');
    const orphan = collectReposicion(
      {
        count: 1,
        belowMin: 0,
        orders: 0,
        amount: 0,
        currency: 'COP',
        withoutSupplier: 1,
        productIds: [],
        suppliers: [],
      },
      TODAY,
    );
    expect(orphan[0]?.proposedAction).toBeNull();
    expect(collectReposicion(undefined, TODAY)).toEqual([]);
  });

  const po = {
    id: 'po-1',
    number: 7,
    label: 'OC-0007',
    status: 'aprobada' as const,
    statusLabel: 'Aprobada',
    supplierId: 's',
    supplierName: 'Ferretería Central S.A.S.',
    supplierTaxId: '900123456',
    supplierEmail: 'ventas@ferreteria.co',
    currency: 'COP',
    subtotal: 60_000,
    taxTotal: 11_400,
    total: 71_400,
    expectedOn: '2026-10-10',
    locationId: null,
    termsDays: 30,
    notes: 'Entregar en horario de oficina (8 a. m. – 5 p. m.).',
    origin: 'sugerencia' as const,
    approvalId: null,
    requestedBy: null,
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    sentTo: null,
    receivedAt: null,
    invoicedAt: null,
    payableId: null,
    cancelledReason: null,
    createdAt: TODAY,
    lines: [
      {
        id: 'l1',
        productId: 'p',
        position: 0,
        description: 'T-10 · Tornillo 10mm (galvanizado)',
        unit: 'und',
        qty: 200,
        unitCost: 300,
        taxRate: 19,
        qtyReceived: 0,
        pending: 200,
        lineTotal: 60_000,
      },
    ],
  };

  it('el PDF es un PDF, con la marca y las cifras', () => {
    const bytes = renderPurchaseOrderPdf(
      po,
      { name: 'Construcciones Ñandú', primary: '#0F766E', logo: null },
      {
        issuedOn: TODAY,
        locationName: 'Bodega principal',
      },
    );
    const text = Buffer.from(bytes).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('(OC-0007)');
    expect(text).toContain('Construcciones \\321and\\372');
    expect(text).toContain('$ 71.400');
    expect(text).toContain('\\(galvanizado\\)');
    // La tabla de referencias apunta a cada objeto.
    const xref = text.slice(text.lastIndexOf('xref'));
    const offsets = [...xref.matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]));
    for (const [i, off] of offsets.entries())
      expect(text.slice(off, off + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`));
  });

  it('un PNG con transparencia se aplana; algo que no es imagen no rompe', () => {
    expect(pdfImageFrom(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(pdfImageFrom(Buffer.from('RIFF0000WEBPVP8 '))).toBeNull();
  });

  it('el correo lleva el PDF adjunto y el asunto codificado', () => {
    const mail = purchaseOrderEmail(po, {
      name: 'Construcciones Ñandú',
      primary: null,
      logo: null,
    });
    expect(mail.subject).toBe('Orden de compra OC-0007 — Construcciones Ñandú');
    expect(mail.body).toContain('200 und — T-10 · Tornillo 10mm');
    const mime = buildMimeWithAttachment({
      to: ['ventas@ferreteria.co'],
      subject: mail.subject,
      body: mail.body,
      filename: 'Orden-de-compra-OC-0007.pdf',
      content: new Uint8Array([37, 80, 68, 70]),
    });
    expect(mime).toContain('Subject: =?UTF-8?B?');
    expect(mime).toContain('Content-Type: application/pdf; name="Orden-de-compra-OC-0007.pdf"');
    expect(mime).toContain('JVBERg==');
  });
});
