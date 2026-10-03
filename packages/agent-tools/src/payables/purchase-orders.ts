import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type PurchaseOrder,
  listOpenPurchaseOrders,
  markPurchaseOrderInvoiced,
} from '../inventory/purchasing';
import { TABLE_TENANCY } from '../tenancy/tables';
import type { PurchaseOrderView } from './checks';
import { cleanNit, numberKey } from './shape';

/**
 * EL PUENTE A LAS ÓRDENES DE COMPRA (módulo de inventario y compras, 0183).
 *
 * Cuentas por pagar no es dueño de las órdenes: usa el contrato que ese módulo
 * expone para esto (`listOpenPurchaseOrders`, `markPurchaseOrderInvoiced`, en
 * inventory/purchasing.ts). Este archivo es el ÚNICO punto de contacto: si el
 * módulo de compras no está en la instalación (la tabla no está clasificada en
 * tenancy/tables.ts o no existe en la base), `available` es falso y la
 * revisión cruza sólo contra la historia del proveedor.
 *
 *   find         la orden que cubre la factura: la que la factura cita por
 *                número («OC-0012», «12»), o la ÚNICA abierta de ese proveedor
 *                por ese valor (±1 %).
 *   markInvoiced la orden queda «facturada» con esta factura (y su «por
 *                pagar» esperado sale del libro: lo reemplaza la factura real).
 */

export const PURCHASE_ORDERS_TABLE = 'purchase_orders';

export interface PurchaseOrderLookup {
  available: boolean;
  find(input: {
    orderReference: string | null;
    supplierNit: string | null;
    total: number;
    currency: string;
  }): Promise<PurchaseOrderView | null>;
  markInvoiced(poId: string, payableId: string, today: string): Promise<boolean>;
}

const NONE: PurchaseOrderLookup = {
  available: false,
  find: async () => null,
  markInvoiced: async () => false,
};

/** La orden, en la forma mínima para cruzar. Pura. */
export function adaptPurchaseOrder(po: PurchaseOrder): PurchaseOrderView {
  return {
    id: po.id,
    number: po.label,
    total: po.total,
    currency: po.currency,
    status: po.status,
    lines: po.lines.map((l) => ({
      code: null,
      description: l.description,
      quantity: l.qty,
      unitPrice: l.unitCost,
    })),
  };
}

/** ¿La referencia que trae la factura es esta orden? «OC-0012», «oc 12» y «12» lo son. */
export function referencesOrder(
  reference: string,
  po: Pick<PurchaseOrder, 'number' | 'label'>,
): boolean {
  if (numberKey(reference) === numberKey(po.label)) return true;
  const digits = reference.replace(/\D/g, '').replace(/^0+/, '');
  return digits !== '' && digits === String(po.number);
}

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === 'PGRST205';
}

export function purchaseOrderLookup(db: SupabaseClient): PurchaseOrderLookup {
  if (!TABLE_TENANCY[PURCHASE_ORDERS_TABLE]) return NONE;
  let open: Promise<PurchaseOrder[] | null> | null = null;
  const load = () => {
    open ??= listOpenPurchaseOrders(db).catch((err) => {
      if (isMissingTable(err)) return null;
      throw err;
    });
    return open;
  };
  return {
    available: true,
    async find(input) {
      const all = await load();
      if (!all) return null;
      if (input.orderReference) {
        const hit = all.find((po) => referencesOrder(input.orderReference as string, po));
        if (hit) return adaptPurchaseOrder(hit);
      }
      const nit = cleanNit(input.supplierNit);
      if (!nit) return null;
      const candidates = all.filter(
        (po) =>
          cleanNit(po.supplierTaxId)?.slice(0, 9) === nit.slice(0, 9) &&
          po.currency === input.currency &&
          Math.abs(po.total - input.total) <= Math.max(1, po.total * 0.01),
      );
      return candidates.length === 1 ? adaptPurchaseOrder(candidates[0] as PurchaseOrder) : null;
    },
    async markInvoiced(poId, payableId, today) {
      try {
        await markPurchaseOrderInvoiced(db, poId, payableId, { today });
        return true;
      } catch {
        // Ya cubierta por otra factura, o cambió de estado: la revisión lo dice.
        return false;
      }
    },
  };
}
