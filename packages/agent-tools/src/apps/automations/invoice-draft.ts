import { createHash } from 'node:crypto';
import { documentTotals, roundCents } from '../../sales/totals';
import { type TemplateContext, lookupRaw, renderRaw, renderTemplate } from './engine';
import type { ListPriceLookup } from '../../accounting/price-lists';
import type { InvoiceItemSpec, InvoiceWriteBack } from './invoice-draft-spec';

/**
 * ARMAR LA PREFACTURA (módulo puro: sin base, sin reloj, sin red).
 *
 * De la acción `accounting_draft_invoice` y la fila que disparó la regla sale
 * una `InvoiceDraftData`: cliente (NIT), líneas en PESOS (con la TRM aplicada si
 * el precio venía en otra moneda), observaciones y un total estimado. Lo que no
 * se puede calcular (un NIT vacío, una cantidad que no es número) no se
 * inventa: la prefactura no se arma y la corrida dice por qué.
 */

export interface DraftLine {
  description: string;
  productCode: string | null;
  quantity: number;
  /** Pesos, antes de IVA. */
  unitPrice: number;
  taxRate: 'iva_19' | 'iva_5' | 'iva_0' | 'excluido';
  unit: string | null;
  discountPct: number;
  /** Precio original en la moneda del origen, si no era COP. */
  sourceUnitPrice?: number;
}

export interface InvoiceDraftData {
  customerTaxId: string;
  customerName: string;
  currency: string;
  trm: number | null;
  lines: DraftLine[];
  observations: string;
  paymentForm: 'contado' | 'credito';
  paymentDays: number;
  total: number;
  /** Líneas que se dejaron fuera y por qué (p. ej. cantidad cero). */
  skipped: string[];
}

export type DraftBuild =
  | { ok: true; draft: InvoiceDraftData }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Números y fórmulas
// ---------------------------------------------------------------------------

/** «1.234,5», «1234.5», «$ 1.200», «0,80» → número; vacío o ilegible → NaN. */
export function parseLooseNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return Number.NaN;
  let s = raw.replace(/[^\d.,-]/g, '');
  if (!s || s === '-') return Number.NaN;
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  if (dots && commas) {
    // El último separador es el decimal.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (commas) s = commas > 1 ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (dots > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Evalúa `1 + 2 * (3 - 1) / 4` (sólo números y operadores); NaN si algo no cuadra. */
export function evalArithmetic(expr: string): number {
  const src = expr.replace(/(\d),(\d)/g, '$1.$2').replace(/\s+/g, '');
  if (!/^[\d.+\-*/()×÷x]+$/i.test(src)) return Number.NaN;
  const text = src.replace(/[×x]/gi, '*').replace(/÷/g, '/');
  let i = 0;
  const peek = () => text[i];
  const factor = (): number => {
    if (peek() === '-') {
      i++;
      return -factor();
    }
    if (peek() === '+') {
      i++;
      return factor();
    }
    if (peek() === '(') {
      i++;
      const v = expression();
      if (peek() !== ')') return Number.NaN;
      i++;
      return v;
    }
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(text.slice(i));
    if (!m) return Number.NaN;
    i += m[0].length;
    return Number(m[0]);
  };
  const term = (): number => {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = text[i++];
      const r = factor();
      v = op === '*' ? v * r : r === 0 ? Number.NaN : v / r;
    }
    return v;
  };
  const expression = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = text[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const out = expression();
  return i === text.length && Number.isFinite(out) ? out : Number.NaN;
}

/** Una cantidad, un precio o una TRM: número fijo, `{{campo}}` o fórmula `=…`. */
export function evalAmount(spec: number | string, ctx: TemplateContext): number {
  if (typeof spec === 'number') return spec;
  const trimmed = spec.trim();
  if (trimmed.startsWith('=')) {
    let missing = false;
    const body = trimmed.slice(1).replace(/\{\{\s*([^{}]{1,48}?)\s*\}\}/g, (_m, name: string) => {
      const n = parseLooseNumber(lookupRaw(name, ctx));
      if (Number.isNaN(n)) {
        missing = true;
        return '0';
      }
      return `(${n})`;
    });
    return missing ? Number.NaN : evalArithmetic(body);
  }
  const rendered = /^\{\{[^{}]+\}\}$/.test(trimmed)
    ? String(lookupRaw(trimmed.slice(2, -2), ctx) ?? '')
    : renderTemplate(trimmed, ctx);
  return parseLooseNumber(rendered);
}

// ---------------------------------------------------------------------------
// La prefactura
// ---------------------------------------------------------------------------

export interface BuildDraftInput {
  customer: { taxId: string; name?: string };
  items: InvoiceItemSpec[];
  currency: string;
  trm?: number | string;
  observations?: string;
  paymentForm: 'contado' | 'credito';
  paymentDays: number;
  /** Contexto de la fila que disparó la regla. */
  ctx: TemplateContext;
  /** Contexto del cliente: el de la fila relacionada si `customer.via`. */
  customerCtx?: TemplateContext;
  /** Precios por lista de precios (0235), si algún ítem pide `priceList`. */
  listPrice?: ListPriceLookup;
}

export function cleanNit(raw: string): string {
  const [main] = raw.split('-');
  return (main ?? '').replace(/\D/g, '');
}

const money = (n: number) =>
  new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(n);

export function buildInvoiceDraft(input: BuildDraftInput): DraftBuild {
  const { ctx } = input;
  const cctx = input.customerCtx ?? ctx;
  const taxIdRaw = renderRaw(input.customer.taxId, cctx).trim();
  const taxId = cleanNit(taxIdRaw);
  if (taxId.length < 3)
    return {
      ok: false,
      reason: taxIdRaw
        ? `El NIT «${taxIdRaw}» no parece un NIT válido.`
        : 'La fila no tiene NIT del cliente: sin él no se arma la prefactura.',
    };
  const name = (input.customer.name ? renderTemplate(input.customer.name, cctx) : '').trim();

  const currency = input.currency || 'COP';
  let trm: number | null = null;
  if (currency !== 'COP') {
    if (input.trm === undefined)
      return { ok: false, reason: `Los precios están en ${currency}: falta la TRM para pasarlos a pesos.` };
    trm = evalAmount(input.trm, ctx);
    if (!(trm > 0))
      return { ok: false, reason: `No se pudo leer la TRM (${String(input.trm)}); tiene que ser un número mayor que cero.` };
  }

  const lines: DraftLine[] = [];
  const skipped: string[] = [];
  for (const [i, item] of input.items.entries()) {
    const description = renderTemplate(item.description, ctx).trim() || `Ítem ${i + 1}`;
    const quantity = evalAmount(item.quantity, ctx);
    let price = evalAmount(item.unitPrice, ctx);
    const codeForList = item.productCode ? renderTemplate(item.productCode, ctx).trim() : '';
    const listName = item.priceList ? renderTemplate(item.priceList, cctx).trim() : '';
    if (listName && codeForList && input.listPrice) {
      const fromList = input.listPrice(codeForList, listName);
      if (fromList !== undefined) price = fromList;
      else if (Number.isNaN(price))
        return {
          ok: false,
          reason: `El producto ${codeForList} no tiene precio en la lista «${listName}» y el ítem ${i + 1} no trae un precio de respaldo.`,
        };
    }
    if (Number.isNaN(quantity))
      return { ok: false, reason: `La cantidad del ítem ${i + 1} («${String(item.quantity)}») no es un número en esta fila.` };
    if (Number.isNaN(price))
      return { ok: false, reason: `El precio del ítem ${i + 1} («${String(item.unitPrice)}») no es un número en esta fila.` };
    if (!(quantity > 0)) {
      skipped.push(`«${description}»: cantidad ${money(quantity)}.`);
      continue;
    }
    if (price < 0) return { ok: false, reason: `El precio del ítem ${i + 1} es negativo.` };
    const code = item.productCode ? renderTemplate(item.productCode, ctx).trim() : '';
    lines.push({
      description,
      productCode: code || null,
      quantity,
      unitPrice: trm ? roundCents(price * trm) : roundCents(price),
      taxRate: item.taxRate,
      unit: item.unit ?? null,
      discountPct: item.discountPct ?? 0,
      ...(trm ? { sourceUnitPrice: price } : {}),
    });
  }
  if (!lines.length)
    return { ok: false, reason: `Ningún ítem tiene cantidad mayor que cero${skipped.length ? ` (${skipped.join(' ')})` : ''}.` };

  const notes: string[] = [];
  if (input.observations) notes.push(renderTemplate(input.observations, ctx).trim());
  if (trm) {
    const first = lines[0] as DraftLine;
    notes.push(
      `Precios en ${currency} convertidos a pesos con TRM ${money(trm)}${lines.length === 1 ? ` (${currency} ${money(first.sourceUnitPrice ?? 0)} por unidad)` : ''}.`,
    );
  }
  const totals = documentTotals(
    lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      taxRate: l.taxRate,
    })),
  );
  return {
    ok: true,
    draft: {
      customerTaxId: taxId,
      customerName: name,
      currency,
      trm,
      lines,
      observations: notes.filter(Boolean).join('\n').slice(0, 4000),
      paymentForm: input.paymentForm,
      paymentDays: input.paymentDays,
      total: totals.total,
      skipped,
    },
  };
}

/** UNA fila + UNA regla = UNA prefactura, siempre la misma llave. */
export function invoiceDraftKey(automationId: string, rowId: string): string {
  return `invdraft:${automationId}:${rowId}`;
}

/** La llave para una prefactura sin fila (botón o horario): una por corrida. */
export function invoiceDraftKeyForRun(automationId: string, runKey: string): string {
  return `invdraft:${automationId}:run:${createHash('sha256').update(runKey).digest('hex').slice(0, 24)}`;
}

/** Lo que se escribe en la fila al armar o crear: texto legible de cada paso. */
export function writeBackValues(
  wb: InvoiceWriteBack | undefined,
  step: 'pending' | 'created',
  invoiceNumber?: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!wb) return out;
  if (wb.status) {
    const v = step === 'pending' ? wb.status.pending : wb.status.created;
    if (v) out[wb.status.field] = v;
  }
  if (step === 'created' && wb.invoiceNumber && invoiceNumber) out[wb.invoiceNumber] = invoiceNumber;
  return out;
}
