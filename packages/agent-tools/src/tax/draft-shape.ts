import type { WithholdingConcept } from './rates-co';
import type { ObligationKind } from './shape';

/**
 * EL VOCABULARIO DE LOS BORRADORES (migración 0197). Sólo tipos, etiquetas y
 * funciones puras.
 *
 * Un borrador es una lista de SECCIONES con RENGLONES. Cada renglón tiene un
 * valor y, si no es un total, las FUENTES que lo forman (la factura de venta,
 * la compra, el movimiento, el mes del estado de resultados): la suma de las
 * fuentes ES el valor del renglón, y las pruebas lo comprueban renglón por
 * renglón. Un total (`derived`) dice con qué fórmula sale de otros renglones.
 *
 * NO HAY NÚMEROS DE RENGLÓN DE LOS FORMULARIOS OFICIALES. No se pudo verificar
 * la estructura vigente de los formularios 300, 350, 110 y 260 contra los
 * instructivos de la DIAN, así que el borrador agrupa (bases, tarifas,
 * impuesto generado, descontable, retenciones, saldo) y el contador lleva cada
 * cifra a su casilla.
 */

export const DRAFT_KINDS = ['iva', 'retencion', 'ica', 'simple_anticipo', 'renta'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export const DRAFT_KIND_LABEL: Record<DraftKind, string> = {
  iva: 'IVA',
  retencion: 'Retención en la fuente',
  ica: 'ICA',
  simple_anticipo: 'Anticipo del Régimen Simple',
  renta: 'Renta (estimado)',
};

/** El formulario de referencia, sólo para decir cuál es. */
export const DRAFT_FORM: Record<DraftKind, string | null> = {
  iva: '300',
  retencion: '350',
  ica: null,
  simple_anticipo: '2593',
  renta: '110',
};

export const DRAFT_STATUSES = ['borrador', 'revisado', 'presentado', 'anulado'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const DRAFT_STATUS_LABEL: Record<DraftStatus, string> = {
  borrador: 'Borrador',
  revisado: 'Revisado por el contador',
  presentado: 'Presentado',
  anulado: 'Anulado',
};

/** La frase que va en todo borrador, en pantalla, CSV y PDF. */
export const DRAFT_DISCLAIMER = 'Borrador — tu contador revisa y presenta';

// ---------------------------------------------------------------------------
// Las fuentes (lo que hay debajo de cada cifra)
// ---------------------------------------------------------------------------

export type SourceKind =
  | 'venta' // factura de venta de Cortex (0182)
  | 'nota_credito_venta'
  | 'compra' // factura de proveedor (0181)
  | 'nota_credito_compra'
  | 'contable' // factura que trajo el programa contable (0165)
  | 'libro' // movimiento del libro de plata (0172)
  | 'nomina' // total de la nómina (sin detalle por persona)
  | 'estados'; // un mes del estado de resultados (0191)

export interface SourceRef {
  kind: SourceKind;
  id: string;
  /** «FE-120 · Comercial Andina», «Septiembre 2025». */
  label: string;
  date: string | null;
  /** Lo que esta fuente aporta al renglón (negativo para notas crédito). */
  amount: number;
  /** Ruta dentro del espacio («/ventas/…»), si hay a dónde ir. */
  path?: string | null;
}

export interface DraftLine {
  key: string;
  label: string;
  /** El valor del renglón. Con fuentes, es la suma de sus `amount`. */
  amount: number;
  /** Para un impuesto calculado: la base y la tarifa (%) con que sale. */
  base?: number | null;
  rate?: number | null;
  sources: SourceRef[];
  /** Un total: sale de otros renglones con `formula`. No tiene fuentes. */
  derived?: boolean;
  formula?: string | null;
  /** Usa una tarifa o un dato que hay que confirmar con el contador. */
  needsConfirmation?: boolean;
  note?: string | null;
}

export interface DraftSection {
  key: string;
  label: string;
  lines: DraftLine[];
}

export interface MissingItem {
  code: string;
  /** «3 facturas de compra sin IVA discriminado». */
  message: string;
  count: number;
  refs: SourceRef[];
}

export interface DraftResult {
  label: string;
  /** Positivo = a pagar; negativo = saldo a favor. */
  amount: number;
  direction: 'pagar' | 'favor' | 'cero';
}

export interface DraftFigures {
  kind: DraftKind;
  title: string;
  period: { from: string; to: string; label: string };
  currency: 'COP';
  rulesVersion: string;
  disclaimer: string;
  /** «Causación (fecha de la factura)», «Caja (estado de resultados)». */
  basis: string;
  sections: DraftSection[];
  result: DraftResult;
  missing: MissingItem[];
  notes: string[];
  /** Algún renglón usa una tarifa por confirmar. */
  needsConfirmation: boolean;
  builtAt: string;
}

// ---------------------------------------------------------------------------
// Lo que entra a los constructores (ya leído y normalizado por draft-sources)
// ---------------------------------------------------------------------------

export type IvaRateKey = 'iva_19' | 'iva_5' | 'iva_0' | 'excluido';

export interface SaleLineInput {
  rate: IvaRateKey;
  base: number;
  iva: number;
}

export interface SaleDocInput {
  id: string;
  /** «FE-120». */
  number: string;
  date: string;
  clientName: string;
  clientNit: string | null;
  kind: 'invoice' | 'credit_note';
  /** Montos en positivo; la nota crédito resta por su `kind`. */
  lines: SaleLineInput[];
  /** % pactado de retenciones que el cliente nos practica (estimadas). */
  withholdings: { retefuentePct?: number; reteivaPct?: number; reteicaPerMil?: number };
  path?: string | null;
}

export interface PurchaseDocInput {
  id: string;
  number: string;
  date: string;
  supplierId: string | null;
  supplierName: string;
  supplierNit: string | null;
  kind: 'invoice' | 'credit_note';
  /** Base sin IVA; null = la factura no la discrimina. */
  subtotal: number | null;
  iva: number;
  total: number;
  retefuente: number;
  reteiva: number;
  reteica: number;
  /** El concepto del proveedor (0197) o null. */
  concept: WithholdingConcept | null;
  /** Aún sin aprobar (recibida / por aprobar). */
  pendingApproval: boolean;
  path?: string | null;
}

export interface ForeignDocInput {
  id: string;
  label: string;
  date: string;
  amount: number;
  currency: string;
}

export interface AccountingSaleInput {
  id: string;
  number: string;
  date: string;
  clientName: string | null;
  total: number;
  provider: string;
}

export interface LedgerIncomeInput {
  id: string;
  date: string;
  amount: number;
  description: string;
  counterparty: string | null;
}

/** Retención por salarios: SÓLO el total del periodo (la nómina es confidencial). */
export interface SalaryWithholdingInput {
  total: number;
  base: number | null;
  employees: number | null;
  source: string;
}

export interface DraftPeriod {
  from: string;
  to: string;
  label: string;
}

/** Lo que una obligación del calendario necesita para tener borrador. */
export interface DraftTarget {
  kind: DraftKind;
  period: DraftPeriod;
}

export const DRAFTABLE_OBLIGATION_KINDS: readonly ObligationKind[] = [
  'iva',
  'retencion',
  'ica',
  'simple_anticipo',
  'renta',
];

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function sumAmounts(refs: Array<{ amount: number }>): number {
  return round2(refs.reduce((s, r) => s + r.amount, 0));
}

export function resultOf(label: string, amount: number): DraftResult {
  const a = round2(amount);
  return { label, amount: a, direction: a > 0.004 ? 'pagar' : a < -0.004 ? 'favor' : 'cero' };
}

/** Todos los renglones de un borrador, en orden. */
export function allLines(f: Pick<DraftFigures, 'sections'>): DraftLine[] {
  return f.sections.flatMap((s) => s.lines);
}

export function lineAmount(f: Pick<DraftFigures, 'sections'>, key: string): number {
  return allLines(f).find((l) => l.key === key)?.amount ?? 0;
}
