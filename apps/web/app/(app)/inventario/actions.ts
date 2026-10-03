'use server';

import type { GridRow } from '@/components/datagrid/types';
import { buildToolContext } from '@/lib/agent';
import type { ActionResult } from '@/lib/inventory/shape';
import { productRow } from '@/lib/inventory/views';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type ProductInput,
  applyStockCount,
  approvePurchaseOrder,
  bogotaToday,
  cancelPurchaseOrder,
  createOrdersFromSuggestions,
  createProduct,
  importSheetProducts,
  loadInventoryOverview,
  parseInventoryCsv,
  parseProductSheet,
  purchasingSendPo,
  receivePurchaseOrder,
  recordMovements,
  resolveSupplier,
  runTool,
  saveLocation,
  submitPurchaseOrder,
  updateDraftLines,
  updateProduct,
} from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE HACE DESDE /inventario (0183).
 *
 * Todo con el handle de la empresa de la sesión. Lo que el chat también hace
 * —aprobar y enviar una orden— pasa por la MISMA herramienta (`runTool` con
 * `purchasing.send_po`), para que la auditoría, el correo y la verificación de
 * quién aprueba sean los mismos en las dos superficies. Lo demás llama al
 * almacén del paquete, que ya valida y revisa permisos (aprobar exige
 * administrar la empresa).
 */

const PATH = '/inventario';

function fail(err: unknown, fallback: string): ActionResult {
  const message = err instanceof Error ? err.message : '';
  return { ok: false, error: message && message.length < 240 ? message : fallback };
}

async function session() {
  const user = await requireSession();
  return { user, db: getOrgScopedClient(user.organization.id), today: bogotaToday() };
}

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

const NUMBER_KEYS: Record<string, keyof ProductInput> = {
  minimo: 'minStock',
  reponer: 'reorderQty',
  entrega: 'leadTimeDays',
  precio: 'price',
};
const TEXT_KEYS: Record<string, keyof ProductInput> = {
  codigo: 'sku',
  producto: 'name',
  unidad: 'unit',
  categoria: 'category',
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function inputFrom(values: Record<string, unknown>): ProductInput {
  const input: ProductInput = {};
  for (const [key, value] of Object.entries(values)) {
    if (key in NUMBER_KEYS) {
      const n = toNumber(value);
      (input as Record<string, unknown>)[NUMBER_KEYS[key] as string] =
        key === 'entrega' && n !== null ? Math.round(n) : n;
    } else if (key in TEXT_KEYS)
      (input as Record<string, unknown>)[TEXT_KEYS[key] as string] =
        value === null || value === undefined ? null : String(value);
    else if (key === 'proveedor')
      input.preferredSupplierId = typeof value === 'string' && value ? value : null;
  }
  return input;
}

export async function editProductCell(rowId: string, key: string, value: unknown): Promise<void> {
  const { db } = await session();
  await updateProduct(db, rowId, inputFrom({ [key]: value }));
  revalidatePath(PATH);
}

export async function bulkEditProducts(
  rowIds: string[],
  key: string,
  value: unknown,
): Promise<void> {
  const { db } = await session();
  const input = inputFrom({ [key]: value });
  for (const id of rowIds.slice(0, 500)) await updateProduct(db, id, input);
  revalidatePath(PATH);
}

export async function createProductRow(values: Record<string, unknown>): Promise<GridRow> {
  const { db, user, today } = await session();
  const created = await createProduct(db, inputFrom(values), { userId: user.id });
  const overview = await loadInventoryOverview(db, { today, includeInactive: true });
  const row = overview.products.find((p) => p.id === created.id);
  revalidatePath(PATH);
  if (!row) throw new Error('No se pudo leer el producto recién creado.');
  return productRow(row);
}

/** Importar una hoja o CSV pegado/subido. */
export async function importProductsCsv(text: string): Promise<ActionResult> {
  const { db, user, today } = await session();
  if (!text.trim()) return { ok: false, error: 'La hoja está vacía.' };
  if (text.length > 2_000_000)
    return { ok: false, error: 'La hoja es muy grande: parte en archivos de menos de 2 MB.' };
  try {
    const parsed = parseProductSheet(parseInventoryCsv(text));
    if (!parsed.recognized.name && !parsed.recognized.sku)
      return {
        ok: false,
        error:
          'No encontré una columna de nombre o código. Los encabezados pueden ser «Código», «Producto», «Existencias», «Mínimo», «Costo», «Proveedor»…',
      };
    const result = await importSheetProducts(db, parsed.drafts, {
      userId: user.id,
      today,
      resolveSupplier: async (name, taxId) =>
        (await resolveSupplier(db, { name, taxId }, { create: true, userId: user.id })).supplier
          ?.id ?? null,
    });
    revalidatePath(PATH);
    const skipped = parsed.skipped.length + result.skipped.length;
    return {
      ok: true,
      note: `Listo: ${result.created} productos nuevos, ${result.updated} actualizados${result.adjusted ? ` y ${result.adjusted} existencias ajustadas` : ''}.${skipped ? ` ${skipped} filas saltadas (sin nombre o con datos inválidos).` : ''}${parsed.ignored.length ? ` Columnas que no usé: ${parsed.ignored.slice(0, 5).join(', ')}.` : ''}`,
    };
  } catch (err) {
    return fail(err, 'No pude importar la hoja.');
  }
}

/** Fijar el proveedor habitual por nombre (lo registra si no existe). */
export async function setPreferredSupplier(
  productIds: string[],
  supplierName: string,
): Promise<ActionResult> {
  const { db, user } = await session();
  try {
    const r = await resolveSupplier(db, { name: supplierName }, { create: true, userId: user.id });
    if (!r.supplier)
      return {
        ok: false,
        error: r.candidates.length
          ? `Hay varios proveedores parecidos: ${r.candidates.map((c) => c.name).join(', ')}.`
          : 'Escribe el nombre del proveedor.',
      };
    for (const id of productIds.slice(0, 500))
      await updateProduct(db, id, { preferredSupplierId: r.supplier.id });
    revalidatePath(PATH);
    return {
      ok: true,
      note: `${r.supplier.name} quedó como proveedor habitual${r.created ? ' (nuevo)' : ''}.`,
    };
  } catch (err) {
    return fail(err, 'No pude guardar el proveedor.');
  }
}

export async function updateProductSettings(
  id: string,
  values: Record<string, unknown>,
): Promise<ActionResult> {
  const { db } = await session();
  try {
    await updateProduct(db, id, inputFrom(values));
    revalidatePath(`${PATH}/${id}`);
    return { ok: true, note: 'Guardado.' };
  } catch (err) {
    return fail(err, 'No pude guardar.');
  }
}

/** Una entrada, salida o ajuste desde la ficha del producto. */
export async function recordProductMove(input: {
  productId: string;
  kind: 'entrada' | 'salida' | 'ajuste';
  qty: number;
  unitCost?: number | null;
  locationId?: string | null;
  note?: string | null;
}): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    if (input.kind === 'ajuste') {
      const r = await applyStockCount(db, {
        locationId: input.locationId ?? null,
        lines: [{ productId: input.productId, counted: input.qty }],
        userId: user.id,
        note: input.note ?? null,
        today,
      });
      revalidatePath(`${PATH}/${input.productId}`);
      return {
        ok: true,
        note: r.adjusted ? 'Ajustado al conteo.' : 'El conteo cuadra con el libro.',
      };
    }
    await recordMovements(
      db,
      [
        {
          productId: input.productId,
          kind: input.kind,
          qty: input.qty,
          unitCost: input.unitCost ?? null,
          locationId: input.locationId ?? null,
          note: input.note ?? null,
        },
      ],
      { userId: user.id, today },
    );
    revalidatePath(`${PATH}/${input.productId}`);
    return {
      ok: true,
      note: input.kind === 'entrada' ? 'Entrada registrada.' : 'Salida registrada.',
    };
  } catch (err) {
    return fail(err, 'No pude registrar el movimiento.');
  }
}

// ---------------------------------------------------------------------------
// Bodegas y conteo
// ---------------------------------------------------------------------------

export async function addLocation(name: string): Promise<ActionResult> {
  const { db, user } = await session();
  try {
    await saveLocation(db, { name, userId: user.id });
    revalidatePath(PATH);
    return { ok: true, note: `Bodega «${name.trim()}» creada.` };
  } catch (err) {
    return fail(err, 'No pude crear la bodega.');
  }
}

export async function applyCount(
  locationId: string,
  lines: Array<{ productId: string; counted: number }>,
  note: string | null,
): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    const r = await applyStockCount(db, { locationId, lines, userId: user.id, note, today });
    revalidatePath(PATH);
    const value =
      r.value === 0
        ? ''
        : ` La diferencia vale $ ${Math.round(Math.abs(r.value)).toLocaleString('es-CO')} ${r.value < 0 ? 'de menos' : 'de más'} al costo promedio.`;
    return {
      ok: true,
      note: `Conteo guardado: ${r.adjusted} ajustes, ${r.unchanged} productos cuadraron.${value}`,
    };
  } catch (err) {
    return fail(err, 'No pude guardar el conteo.');
  }
}

// ---------------------------------------------------------------------------
// Órdenes de compra
// ---------------------------------------------------------------------------

/** «Crear órdenes de compra»: una por proveedor con lo sugerido, y a aprobar. */
export async function createOrdersFromReorder(productIds?: string[]): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    const r = await createOrdersFromSuggestions(db, {
      today,
      productIds,
      userId: user.id,
      origin: 'sugerencia',
    });
    for (const po of r.created)
      if (po.total > 0) await submitPurchaseOrder(db, po.id, { userId: user.id });
    revalidatePath(PATH);
    if (!r.created.length)
      return {
        ok: false,
        error: r.withoutSupplier.length
          ? 'Nada de lo sugerido tiene proveedor habitual: fíjalo primero.'
          : 'No hay nada por pedir.',
      };
    return {
      ok: true,
      note: `Listo: ${r.created.length === 1 ? 'una orden' : `${r.created.length} órdenes`} (${r.created.map((p) => p.label).join(', ')}) por aprobar. La aprobación está en Aprobaciones; aprobarlas se puede hacer de una vez.`,
      href: r.created.length === 1 ? `${PATH}/ordenes/${r.created[0]?.id}` : `${PATH}?tab=ordenes`,
    };
  } catch (err) {
    return fail(err, 'No pude crear las órdenes.');
  }
}

export async function submitOrder(poId: string): Promise<ActionResult> {
  const { db, user } = await session();
  try {
    const po = await submitPurchaseOrder(db, poId, { userId: user.id });
    revalidatePath(`${PATH}/ordenes/${poId}`);
    return { ok: true, note: `${po.label} quedó por aprobar.` };
  } catch (err) {
    return fail(err, 'No pude pedir la aprobación.');
  }
}

export async function approveOrder(poId: string): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    const po = await approvePurchaseOrder(db, poId, { userId: user.id, today });
    revalidatePath(`${PATH}/ordenes/${poId}`);
    return { ok: true, note: `${po.label} aprobada. Ya cuenta en la proyección de caja.` };
  } catch (err) {
    return fail(err, 'No pude aprobarla.');
  }
}

/** Aprobar (si falta) y enviar al proveedor: la herramienta de siempre. */
export async function sendOrder(poId: string, to: string | null): Promise<ActionResult> {
  const { db, user } = await session();
  const { data, error } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
  if (error || !data?.id)
    return { ok: false, error: 'Cortex no está configurado en este espacio.' };
  const ctx = buildToolContext({
    userId: user.id as UUID,
    agentId: data.id as UUID,
    organizationId: user.organization.id,
  });
  try {
    const out = (await runTool(
      purchasingSendPo,
      { purchaseOrderId: poId, ...(to ? { to } : {}) },
      ctx,
      { confirmed: true },
    )) as { sent: boolean; guidance: string };
    revalidatePath(`${PATH}/ordenes/${poId}`);
    return out.sent ? { ok: true, note: out.guidance } : { ok: false, error: out.guidance };
  } catch (err) {
    return fail(err, 'No pude enviar la orden.');
  }
}

export async function receiveOrder(
  poId: string,
  quantities: Record<string, number>,
  locationId: string | null,
): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    const map = new Map(Object.entries(quantities).filter(([, q]) => q > 0));
    if (!map.size) return { ok: false, error: 'Escribe cuánto llegó de al menos una línea.' };
    const r = await receivePurchaseOrder(db, poId, {
      quantities: map,
      locationId,
      userId: user.id,
      today,
    });
    revalidatePath(`${PATH}/ordenes/${poId}`);
    revalidatePath(PATH);
    return {
      ok: true,
      note:
        r.po.status === 'recibida'
          ? 'Recibida completa: las existencias ya se actualizaron.'
          : 'Recibido en parte: queda pendiente el resto.',
    };
  } catch (err) {
    return fail(err, 'No pude registrar lo recibido.');
  }
}

export async function cancelOrder(poId: string, reason: string): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    const po = await cancelPurchaseOrder(db, poId, { reason, today, userId: user.id });
    revalidatePath(`${PATH}/ordenes/${poId}`);
    return { ok: true, note: `${po.label} cancelada.` };
  } catch (err) {
    return fail(err, 'No pude cancelarla.');
  }
}

export async function editOrderLines(
  poId: string,
  lines: Array<{ id: string; qty?: number; unitCost?: number; remove?: boolean }>,
): Promise<ActionResult> {
  const { db } = await session();
  try {
    await updateDraftLines(db, poId, lines);
    revalidatePath(`${PATH}/ordenes/${poId}`);
    return { ok: true, note: 'Orden actualizada. Vuelve a pedir la aprobación cuando esté lista.' };
  } catch (err) {
    return fail(err, 'No pude guardar los cambios.');
  }
}
