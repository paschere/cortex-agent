/**
 * LOS TOTALES DE UNA COTIZACIÓN, UN PEDIDO O UNA FACTURA (migración 0182).
 *
 * Módulo puro: sin base, sin red, sin reloj. Lo usan las herramientas, la
 * pantalla del editor (en el navegador, para ver el total mientras se escribe)
 * y el PDF, así que los tres dicen la misma cifra porque es la misma función.
 *
 * Cómo se cuenta, línea por línea, en centavos para no perder nada en el camino:
 *
 *   bruto     = cantidad × precio unitario
 *   descuento = bruto × % de descuento
 *   base      = bruto − descuento
 *   IVA       = base × tarifa (19 %, 5 %, 0 % exento; «excluido» no causa IVA)
 *   total     = base + IVA
 *
 * Cada valor de línea se redondea al centavo (mitad hacia arriba), y el
 * documento suma las líneas ya redondeadas: así lo hacen Siigo y Alegra, y así
 * el total de Cortex y el del programa no se separan por un peso.
 *
 * RETENCIONES. Las practica el CLIENTE al pagar (él es el agente retenedor),
 * así que no cambian el total de la factura: cambian lo que de verdad va a
 * entrar. Se calculan sobre la base gravable (retención en la fuente, ICA) o
 * sobre el IVA (ReteIVA) y dan el «neto a recibir». Las bases mínimas en UVT
 * NO se aplican solas —dependen del concepto y de quién retiene—; se avisa
 * cuando la base queda por debajo de la mínima más común para que una persona
 * decida (`withholdingWarnings`).
 *
 * REDONDEO EN PESOS. Los pesos colombianos se cobran sin centavos: el total
 * para mostrar en COP se redondea al peso (`displayTotal`), y la diferencia,
 * si la hay, se nombra («ajuste al peso») en vez de esconderse. Lo que se le
 * manda al programa contable son los valores al centavo: el programa recalcula
 * y tiene que llegar a lo mismo.
 */

export type TaxRate = 'iva_19' | 'iva_5' | 'iva_0' | 'excluido';

export const TAX_RATES: readonly TaxRate[] = ['iva_19', 'iva_5', 'iva_0', 'excluido'] as const;

/** Porcentaje de IVA de cada tarifa. «Excluido» y «exento» son 0, pero no son lo mismo. */
export const TAX_RATE_PERCENT: Record<TaxRate, number> = {
  iva_19: 19,
  iva_5: 5,
  iva_0: 0,
  excluido: 0,
};

export const TAX_RATE_LABEL: Record<TaxRate, string> = {
  iva_19: 'IVA 19 %',
  iva_5: 'IVA 5 %',
  iva_0: 'Exento (IVA 0 %)',
  excluido: 'Excluido de IVA',
};

export interface LineInput {
  quantity: number;
  unitPrice: number;
  /** 0 a 100. */
  discountPct?: number;
  taxRate?: TaxRate;
}

export interface LineTotals {
  gross: number;
  discount: number;
  base: number;
  iva: number;
  lineTotal: number;
}

export interface Withholdings {
  /** Retención en la fuente, en % de la base (servicios 4, compras 2,5, transporte 1…). */
  retefuentePct?: number;
  /** ReteICA, por mil de la base (Bogotá servicios 9,66 ‰). */
  reteicaPerMil?: number;
  /** ReteIVA, en % del IVA (normalmente 15). */
  reteivaPct?: number;
}

export interface DocumentTotals {
  lines: LineTotals[];
  /** Suma de los brutos. */
  subtotal: number;
  discountTotal: number;
  /** Suma de las bases (subtotal − descuentos). */
  taxBase: number;
  /** Base de las líneas que causan IVA (no las excluidas ni exentas). */
  taxableBase: number;
  ivaTotal: number;
  /** Lo que dice la factura: base + IVA. */
  total: number;
  /** IVA por tarifa, para el pie del documento. */
  ivaByRate: Array<{ rate: TaxRate; base: number; iva: number }>;
  retefuente: number;
  reteica: number;
  reteiva: number;
  withholdingTotal: number;
  /** Lo que de verdad va a entrar: total − retenciones. */
  netTotal: number;
}

/** Al centavo, mitad hacia arriba (también para negativos, por simetría). */
export function roundCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  // El épsilon corrige 1.005 * 100 = 100.49999999999999.
  return (sign * Math.round(Math.abs(value) * 100 + 1e-7)) / 100;
}

/** Al peso, mitad hacia arriba. */
export function roundPesos(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(value) + 1e-9);
}

function clampPct(value: number | undefined, max = 100): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, max);
}

export function lineTotals(line: LineInput): LineTotals {
  const quantity = Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0;
  const price = Number.isFinite(line.unitPrice) && line.unitPrice > 0 ? line.unitPrice : 0;
  const gross = roundCents(quantity * price);
  const discount = roundCents(gross * (clampPct(line.discountPct) / 100));
  const base = roundCents(gross - discount);
  const iva = roundCents(base * (TAX_RATE_PERCENT[line.taxRate ?? 'iva_19'] / 100));
  return { gross, discount, base, iva, lineTotal: roundCents(base + iva) };
}

const sum = (values: number[]) => roundCents(values.reduce((a, b) => a + b, 0));

export function documentTotals(
  lines: readonly LineInput[],
  withholdings: Withholdings = {},
): DocumentTotals {
  const computed = lines.map(lineTotals);
  const subtotal = sum(computed.map((l) => l.gross));
  const discountTotal = sum(computed.map((l) => l.discount));
  const taxBase = sum(computed.map((l) => l.base));
  const ivaTotal = sum(computed.map((l) => l.iva));
  const taxableBase = sum(
    computed
      .filter((_, i) => TAX_RATE_PERCENT[lines[i]?.taxRate ?? 'iva_19'] > 0)
      .map((l) => l.base),
  );
  const ivaByRate = TAX_RATES.map((rate) => {
    const idx = lines
      .map((l, i) => ((l.taxRate ?? 'iva_19') === rate ? i : -1))
      .filter((i) => i >= 0);
    return {
      rate,
      base: sum(idx.map((i) => computed[i]?.base ?? 0)),
      iva: sum(idx.map((i) => computed[i]?.iva ?? 0)),
    };
  }).filter((r) => r.base > 0);
  const total = roundCents(taxBase + ivaTotal);
  const retefuente = roundCents(taxBase * (clampPct(withholdings.retefuentePct, 20) / 100));
  const reteica = roundCents(taxBase * (clampPct(withholdings.reteicaPerMil, 20) / 1000));
  const reteiva = roundCents(ivaTotal * (clampPct(withholdings.reteivaPct, 100) / 100));
  const withholdingTotal = roundCents(retefuente + reteica + reteiva);
  return {
    lines: computed,
    subtotal,
    discountTotal,
    taxBase,
    taxableBase,
    ivaTotal,
    total,
    ivaByRate,
    retefuente,
    reteica,
    reteiva,
    withholdingTotal,
    netTotal: roundCents(total - withholdingTotal),
  };
}

/** El total para mostrar: en COP al peso, con la diferencia nombrada. */
export function displayTotal(total: number, currency = 'COP'): { value: number; rounding: number } {
  if (currency !== 'COP') return { value: roundCents(total), rounding: 0 };
  const value = roundPesos(total);
  return { value, rounding: roundCents(value - total) };
}

/**
 * Unidad de Valor Tributario de 2026 (Resolución DIAN 000238 del 15-dic-2025).
 * Sólo se usa para AVISAR que una retención podría no aplicar; si la DIAN
 * publica otra cifra, se cambia aquí. El módulo de impuestos (0180) puede
 * reemplazar esta constante cuando exista.
 */
export const UVT_2026 = 52_374;

/** Bases mínimas más comunes de retención en la fuente, en UVT. */
export const RETEFUENTE_MIN_UVT = { servicios: 4, compras: 27 } as const;

export function withholdingWarnings(totals: DocumentTotals, withholdings: Withholdings): string[] {
  const out: string[] = [];
  if (clampPct(withholdings.retefuentePct, 20) > 0) {
    const minServices = RETEFUENTE_MIN_UVT.servicios * UVT_2026;
    if (totals.taxBase < minServices)
      out.push(
        `La base (${formatMoney(totals.taxBase)}) es menor que la mínima de retención por servicios (4 UVT = ${formatMoney(minServices)}): puede que el cliente no retenga.`,
      );
  }
  if (clampPct(withholdings.reteivaPct, 100) > 0 && totals.ivaTotal === 0)
    out.push('Hay ReteIVA pero ninguna línea causa IVA: no se retiene nada.');
  return out;
}

/** «$1.234.567» en COP; con centavos sólo si los hay. Otras monedas, con su código. */
export function formatMoney(value: number, currency = 'COP'): string {
  const cents = Math.abs(roundCents(value) % 1) > 0;
  const formatted = new Intl.NumberFormat('es-CO', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(roundCents(value));
  return currency === 'COP' ? `$${formatted}` : `${currency} ${formatted}`;
}
