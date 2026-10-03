import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { isCompanyManager } from '../directory/store';
import { registerTool } from '../index';
import {
  loadPoBrand,
  purchaseOrderEmail,
  purchaseOrderFilename,
  renderPurchaseOrderPdf,
  sendPurchaseOrderEmail,
} from './document';
import { findProduct, loadInventoryOverview } from './products';
import {
  type PurchaseOrder,
  approvePurchaseOrder,
  buildReorderPlan,
  createOrdersFromSuggestions,
  createPurchaseOrder,
  getPurchaseOrder,
  markPurchaseOrderSent,
  receivePurchaseOrder,
  resolveSupplier,
  submitPurchaseOrder,
} from './purchasing';
import { MOVEMENT_KINDS, STOCK_ALERT_LABEL, formatMoneyCop, formatQty, round } from './shape';
import { findLocation, levelsToStock, loadLevels, recordMovements } from './stock';

/**
 * LAS HERRAMIENTAS DE INVENTARIO Y COMPRAS (migración 0183).
 *
 *   inventory.stock        leer existencias, valor y alertas.
 *   inventory.move         una entrada, salida, ajuste (conteo) o traslado. Confirma.
 *   inventory.reorder      qué hay que pedir hoy, agrupado por proveedor.
 *   purchasing.create_po   órdenes de compra (de las sugerencias o a mano). Confirma.
 *   purchasing.send_po     aprobar y enviar una orden al proveedor con su PDF. Confirma.
 *   purchasing.receive     recibir mercancía (total o parcial). Confirma.
 *
 * La aprobación de una orden es la cola de siempre: `create_po` deja cada orden
 * «por aprobar» con una aprobación de `send_po` para quien aprueba compras.
 * Cortex nunca paga: la orden entra al libro de plata como «por pagar»
 * esperado y la paga una persona en su banco.
 */

const PRODUCT_REF = z
  .string()
  .min(1)
  .max(200)
  .describe('El producto: su id, su código (SKU) o su nombre exacto.');

const PO_REF = z
  .string()
  .min(1)
  .max(60)
  .describe('La orden de compra: su id o su número («OC-0007»).');

function poSummary(po: PurchaseOrder) {
  return {
    id: po.id,
    label: po.label,
    status: po.status,
    statusLabel: po.statusLabel,
    supplierName: po.supplierName,
    total: po.total,
    currency: po.currency,
    lines: po.lines.map((l) => ({
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      unitCost: l.unitCost,
      qtyReceived: l.qtyReceived,
    })),
    href: `/inventario/ordenes/${po.id}`,
  };
}

const PO_OUTPUT = z.object({
  id: z.string(),
  label: z.string(),
  status: z.string(),
  statusLabel: z.string(),
  supplierName: z.string(),
  total: z.number(),
  currency: z.string(),
  lines: z.array(
    z.object({
      description: z.string(),
      qty: z.number(),
      unit: z.string(),
      unitCost: z.number(),
      qtyReceived: z.number(),
    }),
  ),
  href: z.string(),
});

// ---------------------------------------------------------------------------

export const inventoryStock = registerTool({
  id: 'inventory.stock',
  description:
    'Leer el inventario: existencias por producto y bodega, mínimo, valor al costo promedio, consumo diario, días que alcanza y alerta (agotado, bajo el mínimo, se agota antes de reponer, sin movimiento). «¿cuánto tenemos de tornillo 10mm?», «¿qué está bajo el mínimo?», «¿cuánto vale el inventario?». Sólo lee.',
  inputSchema: z.object({
    search: z.string().max(120).optional().describe('Nombre o código a buscar.'),
    onlyAlerts: z.boolean().optional().describe('Sólo lo agotado, bajo el mínimo o que se agota.'),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  outputSchema: z.object({
    products: z.array(
      z.object({
        id: z.string(),
        sku: z.string().nullable(),
        name: z.string(),
        unit: z.string(),
        onHand: z.number().nullable(),
        minStock: z.number().nullable(),
        alert: z.string(),
        value: z.number().nullable(),
        dailyUse: z.number(),
        daysOfCover: z.number().nullable(),
        byLocation: z.array(z.object({ location: z.string(), qty: z.number() })),
      }),
    ),
    totals: z.object({
      products: z.number(),
      value: z.number(),
      belowMin: z.number(),
      outOfStock: z.number(),
    }),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const overview = await loadInventoryOverview(ctx.db, {
      today: bogotaToday(),
      search: input.search,
    });
    const names = new Map(overview.locations.map((l) => [l.id, l.name]));
    const alerting = new Set(['agotado', 'bajo_minimo', 'se_agota']);
    const list = overview.products
      .filter((p) => !input.onlyAlerts || alerting.has(p.alert))
      .sort(
        (a, b) =>
          Number(alerting.has(b.alert)) - Number(alerting.has(a.alert)) ||
          a.name.localeCompare(b.name, 'es'),
      )
      .slice(0, input.limit ?? 20);
    const guidance =
      overview.products.length === 0
        ? 'Todavía no hay productos en el inventario. Se cargan en /inventario (desde una hoja o CSV) o llegan solos del programa contable conectado (Siigo, Alegra o QuickBooks).'
        : `${overview.totals.products} productos; inventario valorado en ${formatMoneyCop(overview.totals.value)} al costo promedio. ${overview.totals.belowMin} bajo el mínimo y ${overview.totals.outOfStock} agotados. Para saber qué pedir usa inventory.reorder. Detalle en /inventario.`;
    return {
      products: list.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        unit: p.unit,
        onHand: p.onHand,
        minStock: p.minStock,
        alert: STOCK_ALERT_LABEL[p.alert],
        value: p.value,
        dailyUse: p.dailyUse,
        daysOfCover: p.daysOfCover,
        byLocation: Object.entries(p.byLocation).map(([id, qty]) => ({
          location: names.get(id) ?? 'Bodega',
          qty,
        })),
      })),
      totals: overview.totals,
      guidance,
    };
  },
});

// ---------------------------------------------------------------------------

export const inventoryMove = registerTool({
  id: 'inventory.move',
  description:
    'Registrar un movimiento de inventario: una entrada («llegaron 50 cajas de guantes a $12.000»), una salida («salieron 3 rollos para la obra»), un ajuste por conteo («contamos 42 tornillos», usa countedQty) o un traslado entre bodegas. Las entradas con costo actualizan el costo promedio ponderado. Para recibir una orden de compra usa purchasing.receive. Requiere confirmación.',
  inputSchema: z.object({
    product: PRODUCT_REF,
    kind: z.enum(MOVEMENT_KINDS),
    qty: z
      .number()
      .positive()
      .max(1e9)
      .optional()
      .describe('Entrada, salida o traslado: la cantidad (positiva).'),
    countedQty: z
      .number()
      .min(0)
      .max(1e9)
      .optional()
      .describe('Ajuste: lo que se contó; se ajusta la diferencia.'),
    unitCost: z.number().min(0).max(1e12).optional().describe('Entrada: costo por unidad.'),
    location: z.string().max(120).optional().describe('Bodega (nombre); sin ella, la principal.'),
    toLocation: z.string().max(120).optional().describe('Traslado: bodega de destino.'),
    note: z.string().max(500).optional(),
    reference: z
      .string()
      .max(120)
      .optional()
      .describe('Factura, remisión o pedido que lo respalda.'),
  }),
  outputSchema: z.object({
    productId: z.string(),
    name: z.string(),
    onHand: z.number(),
    cost: z.number().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const { product, candidates } = await findProduct(ctx.db, input.product);
    if (!product)
      throw new Error(
        candidates.length > 1
          ? `Hay varios productos que se llaman parecido: ${candidates
              .slice(0, 5)
              .map((c) => `${c.name}${c.sku ? ` (${c.sku})` : ''}`)
              .join(', ')}. ¿Cuál?`
          : `No encontré el producto «${input.product}» en el inventario.`,
      );
    const location = input.location ? await findLocation(ctx.db, input.location) : null;
    if (input.location && !location) throw new Error(`No hay una bodega «${input.location}».`);
    const toLocation = input.toLocation ? await findLocation(ctx.db, input.toLocation) : null;
    if (input.kind === 'traslado' && !toLocation)
      throw new Error('Dime a qué bodega va el traslado.');

    let qty: number;
    if (input.kind === 'ajuste') {
      if (input.countedQty === undefined)
        throw new Error('Para un ajuste dime cuánto se contó (countedQty).');
      const stock = levelsToStock(await loadLevels(ctx.db, [product.id])).get(product.id);
      const here = location ? (stock?.byLocation.get(location.id) ?? 0) : (stock?.total ?? 0);
      qty = round(input.countedQty - here, 4);
      if (qty === 0)
        return {
          productId: product.id,
          name: product.name,
          onHand: stock?.total ?? 0,
          cost: product.cost === null ? null : Number(product.cost),
          guidance: `El conteo cuadra con el libro (${formatQty(input.countedQty)} ${product.unit}): no hay nada que ajustar.`,
        };
    } else {
      if (input.qty === undefined) throw new Error('Falta la cantidad.');
      qty = input.qty;
    }
    const written = await recordMovements(
      ctx.db,
      [
        {
          productId: product.id,
          locationId: location?.id ?? null,
          toLocationId: toLocation?.id ?? null,
          kind: input.kind,
          qty,
          unitCost: input.unitCost ?? null,
          referenceKind: input.kind === 'ajuste' ? 'conteo' : 'manual',
          referenceLabel: input.reference ?? null,
          note: input.note ?? null,
        },
      ],
      { userId: ctx.userId, today },
    );
    const after = levelsToStock(await loadLevels(ctx.db, [product.id])).get(product.id)?.total ?? 0;
    const cost =
      written.costs.get(product.id) ?? (product.cost === null ? null : Number(product.cost));
    const what =
      input.kind === 'ajuste'
        ? `Ajusté ${qty > 0 ? '+' : ''}${formatQty(qty)} ${product.unit} por el conteo`
        : input.kind === 'traslado'
          ? `Trasladé ${formatQty(qty)} ${product.unit} a ${toLocation?.name}`
          : `Registré la ${input.kind} de ${formatQty(qty)} ${product.unit}`;
    return {
      productId: product.id,
      name: product.name,
      onHand: after,
      cost,
      guidance: `${what} de ${product.name}. Ahora hay ${formatQty(after)} ${product.unit}${cost !== null ? ` a un costo promedio de ${formatMoneyCop(cost)}` : ''}.`,
    };
  },
});

// ---------------------------------------------------------------------------

export const inventoryReorder = registerTool({
  id: 'inventory.reorder',
  description:
    'Qué hay que pedir hoy: los productos bajo el mínimo (o que se agotan antes de que llegue un pedido), con la cantidad sugerida y la cuenta que la justifica, agrupados por proveedor habitual. Ya descuenta lo que viene en órdenes de compra abiertas. «¿qué tengo que comprar?», «¿qué se nos está acabando?». Sólo lee; para crear las órdenes usa purchasing.create_po con fromSuggestions.',
  inputSchema: z.object({
    productIds: z.array(z.string()).max(200).optional(),
  }),
  outputSchema: z.object({
    groups: z.array(
      z.object({
        supplierId: z.string().nullable(),
        supplierName: z.string().nullable(),
        total: z.number(),
        lines: z.array(
          z.object({
            productId: z.string(),
            name: z.string(),
            qty: z.number(),
            unit: z.string(),
            why: z.string(),
            unitCost: z.number().nullable(),
            lineTotal: z.number().nullable(),
          }),
        ),
      }),
    ),
    count: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const plan = await buildReorderPlan(ctx.db, {
      today: bogotaToday(),
      productIds: input.productIds,
    });
    const orphan = plan.groups.find((g) => g.supplierId === null);
    const withSupplier = plan.groups.filter((g) => g.supplierId !== null);
    const guidance =
      plan.suggestions.length === 0
        ? 'No hay nada por pedir: todo está sobre el mínimo o ya viene en una orden de compra.'
        : `${plan.suggestions.length} productos por reponer${withSupplier.length ? `, en ${withSupplier.length} ${withSupplier.length === 1 ? 'orden' : 'órdenes'} (una por proveedor)` : ''}.${orphan ? ` ${orphan.lines.length} no tienen proveedor habitual: pregúntale a quién se los compra o fíjalo en /inventario.` : ''} Si quiere pedirlos, usa purchasing.create_po con fromSuggestions: true.`;
    return {
      groups: plan.groups.map((g) => ({
        supplierId: g.supplierId,
        supplierName: g.supplierName,
        total: g.total,
        lines: g.lines.map((l) => ({
          productId: l.productId,
          name: l.name,
          qty: l.qty,
          unit: l.unit,
          why: l.why,
          unitCost: l.unitCost,
          lineTotal: l.lineTotal,
        })),
      })),
      count: plan.suggestions.length,
      guidance,
    };
  },
});

// ---------------------------------------------------------------------------

export const purchasingCreatePo = registerTool({
  id: 'purchasing.create_po',
  description:
    'Crear órdenes de compra. Con fromSuggestions: true, una por proveedor con lo que inventory.reorder sugiere (todo, o sólo productIds). O a mano: supplier + lines («pídele a Ferretería Central 200 tornillos 10mm a $300»). Cada orden queda «por aprobar» con su aprobación en /approvals (approve: true la deja aprobada si quien confirma administra la empresa). No envía nada al proveedor: eso es purchasing.send_po. Requiere confirmación.',
  inputSchema: z.object({
    fromSuggestions: z.boolean().optional(),
    productIds: z
      .array(z.string())
      .max(200)
      .optional()
      .describe('Con fromSuggestions: sólo estos productos.'),
    supplier: z.string().max(200).optional().describe('A mano: el proveedor, por nombre o NIT.'),
    supplierEmail: z.string().email().optional(),
    lines: z
      .array(
        z.object({
          product: PRODUCT_REF,
          qty: z.number().positive().max(1e9),
          unitCost: z.number().min(0).max(1e12).optional(),
          taxRate: z.number().min(0).max(100).optional().describe('IVA en porcentaje (19).'),
        }),
      )
      .max(100)
      .optional(),
    expectedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Cuándo debe llegar (AAAA-MM-DD).'),
    notes: z.string().max(2000).optional(),
    approve: z
      .boolean()
      .optional()
      .describe('Dejarla aprobada de una vez (sólo si quien confirma administra).'),
  }),
  outputSchema: z.object({
    orders: z.array(PO_OUTPUT),
    withoutSupplier: z.array(z.object({ name: z.string(), qty: z.number(), unit: z.string() })),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    let orders: PurchaseOrder[] = [];
    let withoutSupplier: Array<{ name: string; qty: number; unit: string }> = [];
    const origin = ctx.surface === 'schedule' ? 'piloto' : 'chat';
    if (input.fromSuggestions) {
      const r = await createOrdersFromSuggestions(ctx.db, {
        today,
        productIds: input.productIds,
        userId: ctx.userId,
        origin: ctx.surface === 'schedule' ? 'piloto' : 'sugerencia',
      });
      orders = r.created;
      withoutSupplier = r.withoutSupplier.map((s) => ({ name: s.name, qty: s.qty, unit: s.unit }));
    } else {
      if (!input.supplier || !input.lines?.length)
        throw new Error('Dime a qué proveedor y qué productos pedir, o usa fromSuggestions.');
      const resolved = await resolveSupplier(
        ctx.db,
        {
          name: input.supplier,
          taxId: /^[\d.\s-]+$/.test(input.supplier) ? input.supplier : null,
          email: input.supplierEmail,
        },
        { create: true, userId: ctx.userId },
      );
      if (!resolved.supplier)
        throw new Error(
          resolved.candidates.length > 1
            ? `Hay varios proveedores parecidos: ${resolved.candidates
                .slice(0, 5)
                .map((s) => s.name)
                .join(', ')}. ¿Cuál?`
            : `No pude registrar el proveedor «${input.supplier}».`,
        );
      const lines = [];
      for (const l of input.lines) {
        const { product, candidates } = await findProduct(ctx.db, l.product);
        if (!product)
          throw new Error(
            candidates.length > 1
              ? `«${l.product}» puede ser ${candidates
                  .slice(0, 5)
                  .map((c) => c.name)
                  .join(', ')}. ¿Cuál?`
              : `No encontré el producto «${l.product}».`,
          );
        lines.push({
          productId: product.id,
          qty: l.qty,
          unitCost: l.unitCost ?? null,
          taxRate: l.taxRate ?? 0,
        });
      }
      orders = [
        await createPurchaseOrder(ctx.db, {
          supplier: resolved.supplier,
          lines,
          expectedOn: input.expectedOn ?? null,
          notes: input.notes ?? null,
          origin,
          userId: ctx.userId,
        }),
      ];
    }
    const manager = input.approve ? await isCompanyManager(ctx.db, ctx.userId) : false;
    const final: PurchaseOrder[] = [];
    for (const po of orders) {
      if (po.total <= 0) {
        final.push(po);
        continue;
      }
      final.push(
        manager
          ? await approvePurchaseOrder(ctx.db, po.id, { userId: ctx.userId, today })
          : await submitPurchaseOrder(ctx.db, po.id, { userId: ctx.userId }),
      );
    }
    const total = final.reduce((s, p) => s + p.total, 0);
    const pending = final.filter((p) => p.status === 'por_aprobar').length;
    const zero = final.filter((p) => p.total <= 0).length;
    const guidance =
      final.length === 0
        ? withoutSupplier.length
          ? 'No creé órdenes: lo que hay que reponer no tiene proveedor habitual. Pregúntale a quién se lo compra.'
          : 'No había nada que pedir.'
        : `Creé ${final.length} ${final.length === 1 ? 'orden' : 'órdenes'} de compra por ${formatMoneyCop(total)} en total (${final.map((p) => `${p.label} a ${p.supplierName}`).join('; ')}).${pending ? ` ${pending === final.length ? 'Quedan' : `${pending} quedan`} por aprobar en /approvals; al aprobarlas se envían al proveedor con su PDF.` : ''}${manager ? ' Quedaron aprobadas: para mandarlas al proveedor usa purchasing.send_po.' : ''}${zero ? ` ${zero} sin costo: hay que ponerle precio antes de aprobarla.` : ''}${withoutSupplier.length ? ` ${withoutSupplier.length} productos no tienen proveedor habitual y no entraron.` : ''}`;
    return { orders: final.map(poSummary), withoutSupplier, guidance };
  },
});

// ---------------------------------------------------------------------------

export const purchasingSendPo = registerTool({
  id: 'purchasing.send_po',
  description:
    'Aprobar (si falta) y enviar una orden de compra al proveedor: un correo desde el Gmail de quien aprueba con el PDF de la orden con la marca de la empresa. Sólo quien administra la empresa (o quien aprueba las compras de ese proveedor) puede aprobarla. Una orden ya enviada no se reenvía salvo resend. Requiere confirmación.',
  inputSchema: z.object({
    purchaseOrderId: PO_REF,
    label: z.string().max(40).optional().describe('Número de la orden, sólo para la tarjeta.'),
    supplierName: z.string().max(200).optional().describe('Proveedor, sólo para la tarjeta.'),
    expectedTotal: z
      .number()
      .min(0)
      .optional()
      .describe('El total que la persona aprobó; si la orden cambió, no se envía.'),
    currency: z.string().length(3).optional(),
    to: z.string().email().optional().describe('Correo del proveedor, si la orden no lo tiene.'),
    message: z.string().max(2000).optional().describe('Una línea extra para el correo.'),
    resend: z.boolean().optional(),
  }),
  outputSchema: z.object({
    order: PO_OUTPUT,
    sent: z.boolean(),
    sentTo: z.string().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    let po = await getPurchaseOrder(ctx.db, input.purchaseOrderId);
    if (!po) throw new Error('No encontré esa orden de compra.');
    if (po.status === 'cancelada') throw new Error(`La orden ${po.label} está cancelada.`);
    if (po.status === 'borrador' || po.status === 'por_aprobar')
      po = await approvePurchaseOrder(ctx.db, po.id, {
        userId: ctx.userId,
        today,
        expectedTotal: input.expectedTotal ?? null,
      });
    if (po.sentAt && !input.resend)
      return {
        order: poSummary(po),
        sent: false,
        sentTo: po.sentTo,
        guidance: `La orden ${po.label} ya se le había enviado a ${po.sentTo ?? 'el proveedor'}. Si quieres mandarla otra vez, dímelo.`,
      };
    const to = input.to ?? po.supplierEmail;
    if (!to)
      return {
        order: poSummary(po),
        sent: false,
        sentTo: null,
        guidance: `La orden ${po.label} quedó aprobada, pero no tengo el correo de ${po.supplierName}. Dime cuál es y la envío, o descarga el PDF en /inventario/ordenes/${po.id}.`,
      };
    if (input.to && po.supplierId) {
      const { error } = await ctx.db
        .from('suppliers')
        .update({ email: input.to })
        .eq('id', po.supplierId)
        .is('email', null);
      if (error) ctx.logger.warn({ err: error }, 'no se pudo guardar el correo del proveedor');
    }
    const brand = await loadPoBrand(ctx.db, ctx.organizationId);
    let locationName: string | null = null;
    if (po.locationId) {
      const { data, error } = await ctx.db
        .from('stock_locations')
        .select('name')
        .eq('id', po.locationId)
        .maybeSingle();
      if (!error) locationName = (data as { name: string } | null)?.name ?? null;
    }
    const pdf = renderPurchaseOrderPdf(po, brand, { issuedOn: today, locationName });
    const mail = purchaseOrderEmail(po, brand, { message: input.message });
    try {
      await sendPurchaseOrderEmail(ctx, {
        to: [to],
        subject: mail.subject,
        body: mail.body,
        filename: purchaseOrderFilename(po),
        content: pdf,
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return {
        order: poSummary(po),
        sent: false,
        sentTo: null,
        guidance: `La orden ${po.label} quedó aprobada pero el correo no salió (${why.slice(0, 160)}). Si Gmail no está conectado, conéctalo en Integraciones o descarga el PDF en /inventario/ordenes/${po.id} y envíalo tú.`,
      };
    }
    po = await markPurchaseOrderSent(ctx.db, po.id, { to });
    return {
      order: poSummary(po),
      sent: true,
      sentTo: to,
      guidance: `Listo: la orden ${po.label} por ${formatMoneyCop(po.total, po.currency)} quedó aprobada y se le envió a ${po.supplierName} (${to}) con el PDF. Cuando llegue la mercancía, regístrala con purchasing.receive.`,
    };
  },
});

// ---------------------------------------------------------------------------

export const purchasingReceive = registerTool({
  id: 'purchasing.receive',
  description:
    'Recibir la mercancía de una orden de compra, completa o en parte («llegó todo lo de la OC-0007», «de la OC-12 llegaron 30 de los 50 guantes»). Cada línea recibida entra al inventario al costo de la orden y mueve el costo promedio; la orden queda recibida o recibida en parte. Requiere confirmación.',
  inputSchema: z.object({
    purchaseOrderId: PO_REF,
    lines: z
      .array(
        z.object({
          product: z.string().max(200).describe('El producto de la línea (id, código o nombre).'),
          qty: z.number().positive().max(1e9),
        }),
      )
      .max(100)
      .optional()
      .describe('Sin líneas: se recibe todo lo pendiente.'),
    location: z
      .string()
      .max(120)
      .optional()
      .describe('Bodega donde entra; sin ella, la de la orden.'),
    note: z.string().max(500).optional(),
  }),
  outputSchema: z.object({
    order: PO_OUTPUT,
    received: z.array(z.object({ description: z.string(), qty: z.number() })),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const po = await getPurchaseOrder(ctx.db, input.purchaseOrderId);
    if (!po) throw new Error('No encontré esa orden de compra.');
    let quantities: Map<string, number> | null = null;
    if (input.lines?.length) {
      quantities = new Map();
      for (const l of input.lines) {
        const key = l.product.trim().toLowerCase();
        const matches = po.lines.filter(
          (line) =>
            line.id === l.product ||
            line.productId === l.product ||
            line.description.toLowerCase().includes(key),
        );
        if (matches.length !== 1)
          throw new Error(
            matches.length
              ? `«${l.product}» coincide con varias líneas de ${po.label}: ${matches.map((m) => m.description).join(', ')}.`
              : `«${l.product}» no está en la orden ${po.label}.`,
          );
        const line = matches[0] as (typeof po.lines)[number];
        quantities.set(line.id, (quantities.get(line.id) ?? 0) + l.qty);
      }
    }
    const location = input.location ? await findLocation(ctx.db, input.location) : null;
    if (input.location && !location) throw new Error(`No hay una bodega «${input.location}».`);
    const r = await receivePurchaseOrder(ctx.db, po.id, {
      quantities,
      locationId: location?.id ?? null,
      userId: ctx.userId,
      today: bogotaToday(),
      note: input.note ?? null,
    });
    const pending = r.po.lines.filter((l) => l.pending > 0);
    return {
      order: poSummary(r.po),
      received: r.received.map((x) => ({ description: x.description, qty: x.qty })),
      guidance: `Recibí ${r.received.map((x) => `${formatQty(x.qty)} de ${x.description}`).join(', ')} de la ${r.po.label}. ${pending.length ? `Falta: ${pending.map((l) => `${formatQty(l.pending)} de ${l.description}`).join(', ')}.` : 'La orden quedó completa.'}${r.po.payableId ? '' : ' Cuando llegue la factura del proveedor, se ata a esta orden en Cuentas por pagar.'}`,
    };
  },
});
