import { nitDv } from '../clients/shape';
import {
  type PayableCheck,
  type PayableLine,
  cleanNit,
  moneyCop,
  numberKey,
  round2,
  shortDay,
  supplierNameKey,
} from './shape';

/**
 * LA REVISIÓN DE UNA FACTURA DE PROVEEDOR ANTES DE APROBARLA. Pura.
 *
 * Un cruce «a tres bandas» a la medida de una pyme: contra la orden de compra
 * cuando el módulo de compras la tiene (0183), y siempre contra lo que se
 * espera del proveedor —su historia— y contra lo obvio:
 *
 *   - ¿YA LA TENEMOS? Otra factura del mismo proveedor, por el mismo valor, a
 *     pocos días, con otro número: posible doble cobro. Detiene.
 *   - ¿ES NUESTRA? La factura viene a nombre de otro NIT. Detiene.
 *   - ¿LA DIAN LA RECHAZÓ? Detiene.
 *   - ¿EL NIT DEL PROVEEDOR CUADRA? Dígito de verificación, y que el proveedor
 *     que conocemos por nombre tenga ese NIT.
 *   - ¿SUBIÓ EL PRECIO? Por ítem (código o descripción) contra la última vez
 *     que se le compró; y el total contra lo que suele facturar.
 *   - ¿FALTA LA RETENCIÓN? Una compra sobre la base mínima sin retención
 *     definida para el proveedor.
 *   - ¿CUADRA CON LA ORDEN? Total y cantidades contra la orden de compra.
 *   - Sin vencimiento, vencida, líneas que no suman el subtotal: notas.
 *
 * Cada hallazgo dice el porqué con cifras. «block» deja la factura en
 * «Por revisar» (la mira una persona antes de pedir aprobación); «warn» y
 * «info» viajan con ella hasta quien aprueba. Nada aquí rechaza solo.
 */

/** Subida de precio de un ítem que ya merece aviso. */
export const PRICE_JUMP = 0.15;
/** Un total mayor que esto por la mediana del proveedor es inusual. */
export const AMOUNT_UNUSUAL_FACTOR = 2.5;
/** Ventana para sospechar doble cobro (mismo valor, otro número). */
export const DUPLICATE_WINDOW_DAYS = 10;
/**
 * Base mínima de retención en la fuente por compras: 27 UVT. El valor de la
 * UVT lo fija la DIAN cada año (resolución de diciembre); actualizar aquí.
 */
export const UVT_BY_YEAR: Record<number, number> = { 2025: 49_799, 2026: 52_374 };
export const PURCHASE_WITHHOLDING_BASE_UVT = 27;

export function withholdingBase(issueDate: string): number {
  const year = Number(issueDate.slice(0, 4));
  const known = Object.keys(UVT_BY_YEAR)
    .map(Number)
    .sort((a, b) => a - b);
  const pick = known.filter((y) => y <= year).pop() ?? known[0] ?? 2026;
  return PURCHASE_WITHHOLDING_BASE_UVT * (UVT_BY_YEAR[pick] ?? 52_374);
}

export interface CheckInvoice {
  docNumber: string;
  supplierNit: string | null;
  supplierDv: string | null;
  supplierName: string;
  customerNit: string | null;
  currency: string;
  issueDate: string;
  dueDate: string | null;
  subtotal: number | null;
  total: number;
  lines: PayableLine[];
  withholdings: { retefuente: number; reteiva: number; reteica: number };
  orderReference: string | null;
  dianAccepted: boolean | null;
}

export interface HistoryInvoice {
  id: string;
  docNumber: string;
  issueDate: string;
  total: number;
  currency: string;
  status: string;
  lines: PayableLine[];
}

export interface KnownSupplier {
  nit: string | null;
  name: string;
  /** Tiene alguna retención definida (aunque sea 0 a propósito). */
  hasWithholdingRates: boolean;
}

/** Una orden de compra, en la forma mínima que hace falta para cruzar. */
export interface PurchaseOrderView {
  id: string;
  number: string;
  total: number | null;
  currency: string | null;
  status: string | null;
  lines: Array<{
    code: string | null;
    description: string;
    quantity: number | null;
    unitPrice: number | null;
  }>;
}

export interface CheckContext {
  today: string;
  /** Nuestro NIT (sin DV), si la empresa lo tiene registrado. */
  companyNit: string | null;
  /** El proveedor como lo conocemos, si lo conocemos. */
  supplier: KnownSupplier | null;
  /** Otras facturas del mismo proveedor (no rechazadas), sin ésta. */
  history: HistoryInvoice[];
  /** La orden de compra que corresponde, si el módulo de compras existe y la encontró. */
  purchaseOrder: PurchaseOrderView | null;
  /** ¿Existe el módulo de órdenes de compra en esta instalación? */
  purchaseOrdersAvailable: boolean;
}

function days(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

/** La llave de un ítem para comparar precios: su código, o su descripción normalizada. */
export function itemKey(line: Pick<PayableLine, 'code' | 'description'>): string {
  if (line.code?.trim()) return `c:${line.code.trim().toUpperCase()}`;
  return `d:${supplierNameKey(line.description).slice(0, 80)}`;
}

function unitPriceOf(line: PayableLine): number | null {
  if (line.unitPrice != null && line.unitPrice > 0) return line.unitPrice;
  if (line.quantity && line.quantity > 0 && line.amount > 0) return line.amount / line.quantity;
  return null;
}

export function checkPayable(inv: CheckInvoice, ctx: CheckContext): PayableCheck[] {
  const out: PayableCheck[] = [];
  const money = (n: number) => moneyCop(n, inv.currency);

  // --- Lo que detiene --------------------------------------------------------
  if (inv.dianAccepted === false) {
    out.push({
      code: 'dian_rejected',
      severity: 'block',
      message: 'La DIAN rechazó esta factura electrónica: no es válida para pagar ni para deducir.',
    });
  }

  const ours = cleanNit(ctx.companyNit);
  const theirs = cleanNit(inv.customerNit);
  if (ours && theirs && ours.slice(0, 9) !== theirs.slice(0, 9)) {
    out.push({
      code: 'wrong_customer_nit',
      severity: 'block',
      message: `La factura viene a nombre del NIT ${theirs}, no del nuestro (${ours}). Pídele al proveedor que la corrija.`,
    });
  }

  const sameCurrency = ctx.history.filter((h) => h.currency === inv.currency);
  const twin = sameCurrency.find(
    (h) =>
      numberKey(h.docNumber) !== numberKey(inv.docNumber) &&
      Math.abs(h.total - inv.total) <= Math.max(1, inv.total * 0.005) &&
      Math.abs(days(h.issueDate, inv.issueDate)) <= DUPLICATE_WINDOW_DAYS,
  );
  if (twin) {
    out.push({
      code: 'duplicate_suspect',
      severity: 'block',
      message: `Ya hay otra factura de ${inv.supplierName} por ${money(twin.total)} del ${shortDay(twin.issueDate)} (${twin.docNumber}). ¿Es un doble cobro?`,
    });
  }

  // --- El NIT del proveedor ----------------------------------------------------
  const nit = cleanNit(inv.supplierNit);
  if (nit && inv.supplierDv != null && /^\d$/.test(inv.supplierDv)) {
    const dv = nitDv(nit);
    if (dv !== null && String(dv) !== inv.supplierDv) {
      out.push({
        code: 'invalid_supplier_dv',
        severity: 'warn',
        message: `El NIT ${nit}-${inv.supplierDv} no cuadra: su dígito de verificación debería ser ${dv}.`,
      });
    }
  }
  const known = ctx.supplier;
  if (known?.nit && nit && known.nit.slice(0, 9) !== nit.slice(0, 9)) {
    out.push({
      code: 'supplier_nit_mismatch',
      severity: 'warn',
      message: `Conocemos a ${known.name} con el NIT ${known.nit}, pero esta factura trae el ${nit}. Confirma que sea el mismo proveedor (y su cuenta bancaria).`,
    });
  }

  // --- Precios contra la historia --------------------------------------------
  const lastPrice = new Map<string, { price: number; date: string; doc: string }>();
  const ordered = [...sameCurrency].sort((a, b) => a.issueDate.localeCompare(b.issueDate));
  for (const h of ordered) {
    for (const line of h.lines ?? []) {
      const price = unitPriceOf(line);
      if (price == null) continue;
      lastPrice.set(itemKey(line), { price, date: h.issueDate, doc: h.docNumber });
    }
  }
  const jumps: Array<{ text: string; rise: number }> = [];
  for (const line of inv.lines) {
    const price = unitPriceOf(line);
    const prev = lastPrice.get(itemKey(line));
    if (price == null || !prev || prev.price <= 0) continue;
    const rise = price / prev.price - 1;
    if (rise > PRICE_JUMP) {
      jumps.push({
        rise,
        text: `«${line.description.slice(0, 60)}» subió ${pct(rise)} (de ${money(round2(prev.price))} a ${money(round2(price))} desde el ${shortDay(prev.date)})`,
      });
    }
  }
  if (jumps.length) {
    jumps.sort((a, b) => b.rise - a.rise);
    const shown = jumps.slice(0, 3).map((j) => j.text);
    const more = jumps.length > 3 ? ` y ${jumps.length - 3} ítem(s) más` : '';
    out.push({
      code: 'price_jump',
      severity: 'warn',
      message: `Precio más alto que la última compra: ${shown.join('; ')}${more}.`,
    });
  }

  const totals = sameCurrency.map((h) => h.total).filter((t) => t > 0);
  if (totals.length >= 3) {
    const typical = median(totals);
    if (typical > 0 && inv.total > typical * AMOUNT_UNUSUAL_FACTOR) {
      out.push({
        code: 'amount_unusual',
        severity: 'warn',
        message: `${money(inv.total)} es ${(inv.total / typical).toFixed(1)} veces lo que ${inv.supplierName} suele facturar (${money(round2(typical))}).`,
      });
    }
  }

  // --- Retención --------------------------------------------------------------
  const withheld =
    inv.withholdings.retefuente + inv.withholdings.reteiva + inv.withholdings.reteica;
  const base = inv.subtotal ?? inv.total;
  if (
    inv.currency === 'COP' &&
    withheld <= 0 &&
    !known?.hasWithholdingRates &&
    base >= withholdingBase(inv.issueDate)
  ) {
    out.push({
      code: 'missing_withholding',
      severity: 'warn',
      message: `Compra de ${money(base)} antes de IVA, sobre la base mínima de retención, y sin retención definida para ${inv.supplierName}. Si la empresa es agente retenedor, define su retefuente (y ReteIVA/ReteICA si aplican) antes de pagar.`,
    });
  }

  // --- Orden de compra ---------------------------------------------------------
  const po = ctx.purchaseOrder;
  if (po) {
    const issues: string[] = [];
    if (po.total != null && Math.abs(po.total - inv.total) > Math.max(1, po.total * 0.01)) {
      issues.push(
        `la orden ${po.number} era por ${money(po.total)} y la factura dice ${money(inv.total)}`,
      );
    }
    const poQty = new Map<string, number>();
    for (const l of po.lines) if (l.quantity != null) poQty.set(itemKey(l), l.quantity);
    for (const line of inv.lines) {
      const ordered = poQty.get(itemKey(line));
      if (ordered != null && line.quantity != null && line.quantity > ordered + 1e-9) {
        issues.push(
          `«${line.description.slice(0, 50)}»: se pidieron ${ordered} y facturan ${line.quantity}`,
        );
      }
    }
    out.push(
      issues.length
        ? {
            code: 'po_mismatch',
            severity: 'warn',
            message: `No cuadra con la orden de compra: ${issues.slice(0, 3).join('; ')}.`,
          }
        : {
            code: 'po_match',
            severity: 'info',
            message: `Cuadra con la orden de compra ${po.number}.`,
          },
    );
  } else if (ctx.purchaseOrdersAvailable && inv.orderReference) {
    out.push({
      code: 'po_missing',
      severity: 'warn',
      message: `La factura cita la orden de compra ${inv.orderReference}, que no encontré.`,
    });
  }

  // --- Notas -------------------------------------------------------------------
  const lineSum = round2(inv.lines.reduce((s, l) => s + (l.amount || 0), 0));
  if (inv.lines.length && inv.subtotal != null && inv.subtotal > 0) {
    if (Math.abs(lineSum - inv.subtotal) > Math.max(1, inv.subtotal * 0.01)) {
      out.push({
        code: 'totals_mismatch',
        severity: 'warn',
        message: `Las líneas suman ${money(lineSum)} y el subtotal dice ${money(inv.subtotal)}.`,
      });
    }
  }
  if (!inv.dueDate) {
    out.push({
      code: 'no_due_date',
      severity: 'info',
      message: 'La factura no trae vencimiento: uso el plazo del proveedor (o 30 días).',
    });
  } else if (inv.dueDate < ctx.today) {
    out.push({
      code: 'overdue',
      severity: 'info',
      message: `Venció hace ${days(inv.dueDate, ctx.today)} día(s), el ${shortDay(inv.dueDate)}.`,
    });
  }
  return out;
}

/** ¿Algún hallazgo detiene la factura en «Por revisar»? */
export function isBlocked(checks: readonly PayableCheck[]): boolean {
  return checks.some((c) => c.severity === 'block');
}

/** Una línea con lo más importante, para listas y avisos. */
export function checksHeadline(checks: readonly PayableCheck[]): string | null {
  const order = { block: 0, warn: 1, info: 2 } as const;
  const top = [...checks].sort((a, b) => order[a.severity] - order[b.severity])[0];
  return top ? top.message : null;
}
