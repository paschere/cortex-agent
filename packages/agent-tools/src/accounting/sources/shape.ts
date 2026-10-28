import { type TrmTable, trmOn } from '../../trackers/trm';
import { nitDv } from '../../clients/shape';
import { carteraNameKey, docKey } from '../../payments/cartera';

/**
 * FUENTES CONTABLES COMBINADAS — LA PARTE PURA (0239).
 *
 * Una tabla de la empresa (casi siempre una hoja de cálculo conectada) se
 * declara como fuente contable de un TIPO —ventas, compras, pagos recibidos,
 * pagos a proveedores, movimientos, presupuesto— con un mapeo de columnas.
 * Aquí viven los tres pasos que no tocan la base:
 *
 *   1. leer una celda como la escribe un colombiano (montos «$ 1.234.567,89»,
 *      fechas «04/03/2026», NIT con o sin dígito de verificación);
 *   2. proponer el mapeo a partir de los encabezados reales y unas filas de
 *      ejemplo (la persona lo aprueba);
 *   3. normalizar las filas a registros contables y REPORTAR las que no sirven:
 *      una fila sin número, sin fecha o sin valor no se cuela en silencio.
 */

export const SOURCE_KINDS = [
  'ventas',
  'compras',
  'pagos_recibidos',
  'pagos_proveedores',
  'movimientos',
  'presupuesto',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  ventas: 'Ventas (facturas de venta)',
  compras: 'Compras y gastos (facturas de proveedor)',
  pagos_recibidos: 'Pagos recibidos',
  pagos_proveedores: 'Pagos a proveedores',
  movimientos: 'Movimientos contables',
  presupuesto: 'Presupuesto',
};

export const MAPPING_FIELDS = [
  'numero',
  'fecha',
  'vencimiento',
  'nit',
  'nombre',
  'total',
  'iva',
  'saldo',
  'moneda',
  'trm',
  'centro_costo',
  'cuenta',
  'concepto',
  'factura',
  'debito',
  'credito',
] as const;
export type MappingField = (typeof MAPPING_FIELDS)[number];

/** campo canónico → clave del campo de la tabla (la columna de la hoja). */
export type Mapping = Partial<Record<MappingField, string>>;

export const MAPPING_FIELD_LABEL: Record<MappingField, string> = {
  numero: 'Número',
  fecha: 'Fecha',
  vencimiento: 'Vencimiento',
  nit: 'NIT / tercero',
  nombre: 'Nombre del tercero',
  total: 'Valor / total',
  iva: 'IVA / impuestos',
  saldo: 'Saldo',
  moneda: 'Moneda',
  trm: 'TRM',
  centro_costo: 'Centro de costo',
  cuenta: 'Cuenta',
  concepto: 'Concepto',
  factura: 'Factura que paga / afecta',
  debito: 'Débito',
  credito: 'Crédito',
};

interface KindSpec {
  required: MappingField[];
  allowed: MappingField[];
  /** Una de estas (al menos) además de los requeridos. */
  oneOf?: MappingField[];
}

const INVOICE_ALLOWED: MappingField[] = [
  'numero',
  'fecha',
  'vencimiento',
  'nit',
  'nombre',
  'total',
  'iva',
  'saldo',
  'moneda',
  'trm',
  'centro_costo',
  'cuenta',
  'concepto',
  'factura',
];
const PAYMENT_ALLOWED: MappingField[] = [
  'numero',
  'fecha',
  'nit',
  'nombre',
  'total',
  'moneda',
  'trm',
  'factura',
  'concepto',
  'centro_costo',
  'cuenta',
];

export const KIND_SPEC: Record<SourceKind, KindSpec> = {
  ventas: { required: ['numero', 'fecha', 'total'], allowed: INVOICE_ALLOWED },
  compras: { required: ['numero', 'fecha', 'total'], allowed: INVOICE_ALLOWED },
  pagos_recibidos: { required: ['fecha', 'total'], allowed: PAYMENT_ALLOWED },
  pagos_proveedores: { required: ['fecha', 'total'], allowed: PAYMENT_ALLOWED },
  movimientos: {
    required: ['fecha', 'cuenta'],
    allowed: [
      'numero',
      'fecha',
      'cuenta',
      'debito',
      'credito',
      'total',
      'nit',
      'nombre',
      'centro_costo',
      'concepto',
      'moneda',
    ],
    oneOf: ['debito', 'credito', 'total'],
  },
  presupuesto: {
    required: ['fecha', 'total'],
    allowed: ['fecha', 'total', 'cuenta', 'centro_costo', 'concepto', 'nombre', 'moneda'],
  },
};

/** Los tipos que son facturas: tienen número, vencimiento y saldo. */
export const isInvoiceKind = (k: SourceKind) => k === 'ventas' || k === 'compras';
export const isPaymentKind = (k: SourceKind) =>
  k === 'pagos_recibidos' || k === 'pagos_proveedores';

// ---------------------------------------------------------------------------
// Leer celdas
// ---------------------------------------------------------------------------

const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';
  return String(v).trim();
}

/**
 * Un monto como lo escribe un colombiano. «$ 1.234.567,89», «1.234.567», «(1.200.000)»
 * (negativo), «-1.200.000», «1.200.000-», «1234567.5». Devuelve null si no es un
 * número; NUNCA adivina con texto que no lo parece.
 */
export function parseMoneyCO(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/\b(COP|USD|EUR|MXN|PEN|CLP)\b/gi, '').replace(/[$€£\s ]/g, '');
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!s || !/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  let normalized: string;
  if (dots && commas) {
    // El último separador es el decimal.
    const decimalIsComma = s.lastIndexOf(',') > s.lastIndexOf('.');
    normalized = decimalIsComma ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    const parts = normalized.split('.');
    if (parts.length > 2) return null;
  } else if (dots) {
    if (dots > 1) normalized = s.replace(/\./g, '');
    else {
      const [int, frac = ''] = s.split('.');
      // «1.234» en Colombia son mil doscientos treinta y cuatro; «12.5» es doce y medio.
      normalized =
        frac.length === 3 && (int?.length ?? 0) <= 3 && int !== '0' ? `${int}${frac}` : s;
    }
  } else if (commas) {
    if (commas > 1) normalized = s.replace(/,/g, '');
    else {
      const [int, frac = ''] = s.split(',');
      // «1,234» (tres decimales casi nunca existen en plata): miles. «12,5» y «1,50»: decimal.
      normalized =
        frac.length === 3 && (int?.length ?? 0) <= 3 && int !== '0'
          ? `${int}${frac}`
          : `${int}.${frac}`;
    }
  } else normalized = s;
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const MONTHS_ES: Record<string, number> = {
  ene: 1,
  enero: 1,
  feb: 2,
  febrero: 2,
  mar: 3,
  marzo: 3,
  abr: 4,
  abril: 4,
  may: 5,
  mayo: 5,
  jun: 6,
  junio: 6,
  jul: 7,
  julio: 7,
  ago: 8,
  agosto: 8,
  sep: 9,
  sept: 9,
  septiembre: 9,
  setiembre: 9,
  oct: 10,
  octubre: 10,
  nov: 11,
  noviembre: 11,
  dic: 12,
  diciembre: 12,
};

function isoDay(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

/** Una fecha como la escribe un colombiano (día primero). Devuelve AAAA-MM-DD o null. */
export function parseDateCO(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    // Serial de Excel/Sheets (días desde 1899-12-30).
    if (raw >= 30000 && raw <= 70000) {
      return new Date(Date.UTC(1899, 11, 30) + Math.floor(raw) * 86_400_000)
        .toISOString()
        .slice(0, 10);
    }
    return null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return isoDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = m[3]?.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    // Día primero; sólo si el segundo número no puede ser mes se lee mes/día.
    return b > 12 && a <= 12 ? isoDay(y, a, b) : isoDay(y, b, a);
  }
  m = /^(\d{1,2})\s*(?:de\s+|[-/]\s*)?([a-záéíóú]+)\.?\s*(?:de\s+|[-/]\s*)?(\d{2}|\d{4})$/i.exec(s);
  if (m) {
    const mon = MONTHS_ES[(m[2] ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')];
    const y = m[3]?.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (mon) return isoDay(y, mon, Number(m[1]));
  }
  if (/^\d{5}$/.test(s)) return parseDateCO(Number(s));
  return null;
}

export interface ParsedNit {
  /** Sin dígito de verificación, sólo dígitos. */
  core: string;
  dv: number | null;
  /** true/false si traía DV y se pudo comprobar; null si no traía. */
  dvOk: boolean | null;
}

/** NIT con o sin DV: «900.123.456-7», «9001234567», «900123456». */
export function parseNit(raw: unknown): ParsedNit | null {
  const s = cellText(raw);
  if (!s) return null;
  const hy = /^([\d.\s]+?)\s*-\s*(\d)$/.exec(s);
  if (hy) {
    const core = (hy[1] ?? '').replace(/\D/g, '');
    const dv = Number(hy[2]);
    if (core.length < 5 || core.length > 12) return null;
    return { core, dv, dvOk: nitDv(core) === dv };
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 13 || /[A-Za-z]{3,}/.test(s)) return null;
  if (digits.length >= 10 && nitDv(digits.slice(0, -1)) === Number(digits.slice(-1)))
    return { core: digits.slice(0, -1), dv: Number(digits.slice(-1)), dvOk: true };
  return { core: digits, dv: null, dvOk: null };
}

const CURRENCY_RE = /^[A-Z]{3}$/;
const CURRENCY_ALIASES: Record<string, string> = {
  PESOS: 'COP',
  PESO: 'COP',
  COL: 'COP',
  DOLARES: 'USD',
  DOLAR: 'USD',
  US: 'USD',
  USD$: 'USD',
  EUROS: 'EUR',
  EURO: 'EUR',
};

export function parseCurrency(raw: unknown, fallback: string): string {
  const s = cellText(raw)
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Z$]/g, '');
  if (!s) return fallback;
  if (CURRENCY_RE.test(s)) return s;
  return CURRENCY_ALIASES[s] ?? fallback;
}

// ---------------------------------------------------------------------------
// El registro normalizado
// ---------------------------------------------------------------------------

export interface AccRecord {
  kind: SourceKind;
  /** «accounting_sources.id», «base» para lo que ya trae el programa/documentos. */
  sourceId: string;
  /** «Siigo», «Hoja: Ventas Medellín», «Documento leído», «a mano». */
  origin: string;
  rowId: string;
  number: string;
  date: string;
  due: string | null;
  /** NIT sin DV (dígitos) o ''. */
  nit: string;
  party: string;
  /** Con signo: una nota crédito / devolución es negativa. */
  total: number;
  tax: number | null;
  balance: number | null;
  currency: string;
  trm: number | null;
  /** total × TRM cuando la moneda no es COP y hay TRM. */
  totalCop: number | null;
  costCenter: string | null;
  account: string | null;
  concept: string | null;
  /** Número de la factura que paga o afecta (pagos y notas). */
  invoiceRef: string | null;
  debit: number | null;
  credit: number | null;
  creditNote: boolean;
}

export type IssueCode =
  | 'sin_numero'
  | 'sin_fecha'
  | 'fecha_invalida'
  | 'sin_valor'
  | 'valor_invalido'
  | 'nit_invalido'
  | 'nit_dv_distinto'
  | 'moneda_sin_trm'
  | 'monto_negativo'
  | 'repetida_en_hoja'
  | 'sin_saldo'
  | 'sin_tercero'
  | 'fuente_ilegible';

export interface RowIssue {
  rowId: string | null;
  code: IssueCode;
  /** rechazada: no entra en ninguna cifra; aviso: entra y se avisa. */
  severity: 'rechazada' | 'aviso';
  message: string;
  number?: string | null;
  sourceLabel?: string;
}

export interface NormalizeOptions {
  sourceId: string;
  origin: string;
  /** Moneda de las filas que no traen columna de moneda. */
  currency?: string;
  /** Varias filas con el mismo número = líneas de la misma factura: se suman. */
  sumRepeated?: boolean;
  /**
   * TRM oficial (cortex.trm): una fila en dólares que NO trae su TRM usa la que
   * regía el día de su fecha, en vez de quedar fuera de los pesos. Si la fila
   * trae TRM, manda la de la fila.
   */
  trmTable?: TrmTable;
}

export interface NormalizeResult {
  records: AccRecord[];
  issues: RowIssue[];
  stats: { rows: number; used: number; rejected: number; warnings: number; blank: number };
}

export interface RawRow {
  id: string;
  values: Record<string, unknown>;
}

const COP = 'COP';

/** Valida el mapeo contra el tipo: devuelve lo que falta y lo que sobra. */
export function validateMapping(
  kind: SourceKind,
  mapping: Mapping,
  columns?: readonly string[],
): { ok: boolean; problems: string[] } {
  const spec = KIND_SPEC[kind];
  const problems: string[] = [];
  for (const f of spec.required)
    if (!mapping[f]) problems.push(`Falta la columna de «${MAPPING_FIELD_LABEL[f]}».`);
  if (spec.oneOf && !spec.oneOf.some((f) => mapping[f]))
    problems.push(
      `Falta al menos una columna de ${spec.oneOf.map((f) => `«${MAPPING_FIELD_LABEL[f]}»`).join(', ')}.`,
    );
  for (const [f, col] of Object.entries(mapping) as Array<[MappingField, string]>) {
    if (!col) continue;
    if (!spec.allowed.includes(f))
      problems.push(`«${MAPPING_FIELD_LABEL[f]}» no se usa en ${SOURCE_KIND_LABEL[kind]}.`);
    if (columns && !columns.includes(col))
      problems.push(`La columna «${col}» (${MAPPING_FIELD_LABEL[f]}) no existe en la tabla.`);
  }
  return { ok: problems.length === 0, problems };
}

function pick(row: RawRow, mapping: Mapping, f: MappingField): unknown {
  const col = mapping[f];
  return col ? row.values[col] : undefined;
}

/**
 * Filas de la tabla → registros contables. Puro. Las filas que no sirven se
 * REPORTAN (`issues`), no se descartan en silencio; las que sirven pero traen
 * algo raro entran con un aviso.
 */
export function normalizeRows(
  kind: SourceKind,
  mapping: Mapping,
  rows: readonly RawRow[],
  opts: NormalizeOptions,
): NormalizeResult {
  const spec = KIND_SPEC[kind];
  const defaultCurrency = (opts.currency ?? COP).toUpperCase();
  const issues: RowIssue[] = [];
  const records: AccRecord[] = [];
  const stats = { rows: rows.length, used: 0, rejected: 0, warnings: 0, blank: 0 };
  const seen = new Map<string, AccRecord>();

  const reject = (row: RawRow, code: IssueCode, message: string, number?: string) => {
    stats.rejected += 1;
    issues.push({ rowId: row.id, code, severity: 'rechazada', message, number: number || null });
  };

  for (const row of rows) {
    const mapped = Object.keys(mapping) as MappingField[];
    if (mapped.every((f) => blank(pick(row, mapping, f)))) {
      stats.blank += 1;
      continue;
    }
    const warn = (code: IssueCode, message: string, number?: string) => {
      stats.warnings += 1;
      issues.push({ rowId: row.id, code, severity: 'aviso', message, number: number || null });
    };

    const number = cellText(pick(row, mapping, 'numero'));
    const needsNumber = spec.required.includes('numero');
    if (needsNumber && !number) {
      reject(row, 'sin_numero', 'La fila no tiene número de documento.');
      continue;
    }

    const rawDate = pick(row, mapping, 'fecha');
    if (blank(rawDate)) {
      reject(row, 'sin_fecha', 'La fila no tiene fecha.', number);
      continue;
    }
    const date = parseDateCO(rawDate);
    if (!date) {
      reject(row, 'fecha_invalida', `La fecha «${cellText(rawDate)}» no se entiende.`, number);
      continue;
    }

    let due: string | null = null;
    const rawDue = pick(row, mapping, 'vencimiento');
    if (!blank(rawDue)) {
      due = parseDateCO(rawDue);
      if (!due)
        warn('fecha_invalida', `El vencimiento «${cellText(rawDue)}» no se entiende.`, number);
    }

    // Monto: el valor, o débito/crédito en movimientos.
    const rawTotal = pick(row, mapping, 'total');
    let total: number | null = null;
    let debit: number | null = null;
    let credit: number | null = null;
    if (kind === 'movimientos') {
      const d = blank(pick(row, mapping, 'debito'))
        ? null
        : parseMoneyCO(pick(row, mapping, 'debito'));
      const c = blank(pick(row, mapping, 'credito'))
        ? null
        : parseMoneyCO(pick(row, mapping, 'credito'));
      debit = d;
      credit = c;
      if (d !== null || c !== null) total = (d ?? 0) - (c ?? 0);
      else if (!blank(rawTotal)) total = parseMoneyCO(rawTotal);
      if (total === null) {
        reject(
          row,
          blank(rawTotal) && d === null && c === null ? 'sin_valor' : 'valor_invalido',
          'El movimiento no tiene un débito o crédito que se entienda.',
          number,
        );
        continue;
      }
    } else {
      if (blank(rawTotal)) {
        reject(row, 'sin_valor', 'La fila no tiene valor.', number);
        continue;
      }
      total = parseMoneyCO(rawTotal);
      if (total === null) {
        reject(row, 'valor_invalido', `El valor «${cellText(rawTotal)}» no es un monto.`, number);
        continue;
      }
    }

    const nitRaw = pick(row, mapping, 'nit');
    let nit = '';
    if (!blank(nitRaw)) {
      const parsed = parseNit(nitRaw);
      if (!parsed) warn('nit_invalido', `El NIT «${cellText(nitRaw)}» no parece un NIT.`, number);
      else {
        nit = parsed.core;
        if (parsed.dvOk === false)
          warn(
            'nit_dv_distinto',
            `El dígito de verificación de «${cellText(nitRaw)}» no coincide con el NIT.`,
            number,
          );
      }
    }

    const currency = parseCurrency(pick(row, mapping, 'moneda'), defaultCurrency);
    const trmRaw = pick(row, mapping, 'trm');
    let trm = blank(trmRaw) ? null : parseMoneyCO(trmRaw);
    if (currency !== COP && !(trm && trm > 0) && opts.trmTable) {
      const official = trmOn(opts.trmTable, date);
      if (official.ok) trm = official.value;
    }
    let totalCop: number | null = currency === COP ? total : null;
    if (currency !== COP) {
      if (trm && trm > 0) totalCop = Math.round(total * trm * 100) / 100;
      else
        warn(
          'moneda_sin_trm',
          `Está en ${currency} y no trae TRM: se cuenta en ${currency}, no en pesos.`,
          number,
        );
    }

    const taxRaw = pick(row, mapping, 'iva');
    const balRaw = pick(row, mapping, 'saldo');
    const tax = blank(taxRaw) ? null : parseMoneyCO(taxRaw);
    const balance = blank(balRaw) ? null : parseMoneyCO(balRaw);

    const creditNote = isInvoiceKind(kind) && total < 0;
    if (creditNote)
      warn(
        'monto_negativo',
        'Valor negativo: se trata como nota crédito / devolución y resta.',
        number,
      );

    const rec: AccRecord = {
      kind,
      sourceId: opts.sourceId,
      origin: opts.origin,
      rowId: row.id,
      number,
      date,
      due,
      nit,
      party: cellText(pick(row, mapping, 'nombre')),
      total,
      tax,
      balance,
      currency,
      trm: trm && trm > 0 ? trm : null,
      totalCop,
      costCenter: cellText(pick(row, mapping, 'centro_costo')) || null,
      account: cellText(pick(row, mapping, 'cuenta')) || null,
      concept: cellText(pick(row, mapping, 'concepto')) || null,
      invoiceRef: cellText(pick(row, mapping, 'factura')) || null,
      debit,
      credit,
      creditNote,
    };

    // Repetidas dentro de la misma hoja (mismo número y tercero): una sola vez.
    if (isInvoiceKind(kind) || (isPaymentKind(kind) && number)) {
      const key = `${docKey(number)}|${partyKey(rec)}|${currency}`;
      const prior = seen.get(key);
      if (prior) {
        if (opts.sumRepeated) {
          prior.total += rec.total;
          prior.tax =
            prior.tax === null && rec.tax === null ? null : (prior.tax ?? 0) + (rec.tax ?? 0);
          prior.balance =
            prior.balance === null && rec.balance === null
              ? null
              : (prior.balance ?? 0) + (rec.balance ?? 0);
          if (prior.totalCop !== null && rec.totalCop !== null) prior.totalCop += rec.totalCop;
          prior.creditNote = prior.total < 0;
          continue;
        }
        stats.rejected += 1;
        issues.push({
          rowId: row.id,
          code: 'repetida_en_hoja',
          severity: 'rechazada',
          number: number || null,
          message: `«${number}» ya está en otra fila de la misma tabla: se cuenta una sola vez (si cada fila es una línea de la factura, activa «sumar filas repetidas»).`,
        });
        continue;
      }
      seen.set(key, rec);
    }
    records.push(rec);
  }
  stats.used = records.length;
  return { records, issues, stats };
}

/** Identidad del tercero: el NIT sin DV, o el nombre sin tildes ni formas societarias. */
export function partyKey(r: Pick<AccRecord, 'nit' | 'party'>): string {
  if (r.nit) return `nit:${r.nit}`;
  const n = carteraNameKey(r.party);
  return n ? `name:${n}` : '';
}

// ---------------------------------------------------------------------------
// Proponer el mapeo
// ---------------------------------------------------------------------------

const ALIASES: Record<MappingField, string[]> = {
  numero: [
    'numero',
    'num',
    'no',
    'nro',
    'factura',
    'n factura',
    'numero factura',
    'documento',
    'doc',
    'consecutivo',
    'comprobante',
    'recibo',
    'id',
    'referencia',
  ],
  fecha: [
    'fecha',
    'fecha factura',
    'fecha emision',
    'emision',
    'fecha documento',
    'periodo',
    'mes',
    'date',
    'fecha pago',
  ],
  vencimiento: [
    'vence',
    'vencimiento',
    'fecha vencimiento',
    'fecha vence',
    'fecha limite',
    'due',
    'plazo',
  ],
  nit: [
    'nit',
    'identificacion',
    'cedula',
    'documento tercero',
    'nit tercero',
    'nit cliente',
    'nit proveedor',
    'tax id',
    'rut',
  ],
  nombre: [
    'cliente',
    'proveedor',
    'tercero',
    'nombre',
    'razon social',
    'beneficiario',
    'nombre tercero',
    'empresa',
  ],
  total: [
    'total',
    'valor',
    'valor total',
    'monto',
    'importe',
    'valor factura',
    'total factura',
    'presupuesto',
    'valor pagado',
    'amount',
  ],
  iva: ['iva', 'impuesto', 'impuestos', 'valor iva', 'tax'],
  saldo: ['saldo', 'pendiente', 'por cobrar', 'por pagar', 'saldo pendiente', 'balance'],
  moneda: ['moneda', 'divisa', 'currency'],
  trm: ['trm', 'tasa', 'tasa de cambio', 'tipo de cambio'],
  centro_costo: [
    'centro de costo',
    'centro costo',
    'cc',
    'centro',
    'area',
    'proyecto',
    'sede',
    'sucursal',
  ],
  cuenta: ['cuenta', 'puc', 'codigo cuenta', 'cuenta contable', 'rubro', 'categoria'],
  concepto: ['concepto', 'descripcion', 'detalle', 'observaciones', 'nota', 'glosa'],
  factura: [
    'factura',
    'factura pagada',
    'factura asociada',
    'aplica a',
    'documento afectado',
    'factura aplicada',
  ],
  debito: ['debito', 'debe', 'db', 'debitos'],
  credito: ['credito', 'haber', 'cr', 'creditos'],
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export interface ColumnInfo {
  key: string;
  label: string;
  type?: string;
}

export interface ProposedColumn {
  field: MappingField;
  column: string;
  /** 0–1. */
  confidence: number;
  /** De cuántas filas de ejemplo se pudo leer con el tipo esperado. */
  validSamples: number;
  totalSamples: number;
  examples: string[];
}

export interface MappingProposal {
  mapping: Mapping;
  columns: ProposedColumn[];
  missing: MappingField[];
  warnings: string[];
}

const TYPE_CHECK: Partial<Record<MappingField, (v: unknown) => boolean>> = {
  fecha: (v) => parseDateCO(v) !== null,
  vencimiento: (v) => parseDateCO(v) !== null,
  total: (v) => parseMoneyCO(v) !== null,
  iva: (v) => parseMoneyCO(v) !== null,
  saldo: (v) => parseMoneyCO(v) !== null,
  debito: (v) => parseMoneyCO(v) !== null,
  credito: (v) => parseMoneyCO(v) !== null,
  trm: (v) => parseMoneyCO(v) !== null,
  nit: (v) => parseNit(v) !== null,
};

const TYPE_HINT: Partial<Record<MappingField, string[]>> = {
  fecha: ['date'],
  vencimiento: ['date'],
  total: ['money', 'number'],
  iva: ['money', 'number'],
  saldo: ['money', 'number'],
  debito: ['money', 'number'],
  credito: ['money', 'number'],
};

/**
 * Propone qué columna es cada campo, mirando el nombre del encabezado y si las
 * filas de ejemplo se pueden leer con el tipo que ese campo necesita. Una
 * columna se usa una sola vez; el campo que no encuentra queda sin mapear (y
 * se dice), no se inventa.
 */
export function proposeMapping(
  kind: SourceKind,
  columns: readonly ColumnInfo[],
  samples: ReadonlyArray<Record<string, unknown>>,
): MappingProposal {
  const spec = KIND_SPEC[kind];
  const candidates: Array<{
    field: MappingField;
    col: ColumnInfo;
    score: number;
    valid: number;
    n: number;
  }> = [];
  for (const field of spec.allowed) {
    // En un pago, una columna «Factura» dice QUÉ factura paga, no el número del recibo.
    const aliases =
      field === 'numero' && isPaymentKind(kind)
        ? ALIASES.numero.filter((a) => !a.includes('factura'))
        : ALIASES[field];
    for (const col of columns) {
      const names = [norm(col.label), norm(col.key.replace(/_/g, ' '))];
      let nameScore = 0;
      for (const nm of names) {
        if (!nm) continue;
        if (aliases.includes(nm)) nameScore = Math.max(nameScore, 1);
        else if (aliases.some((a) => a.length > 3 && (nm.includes(a) || a.includes(nm))))
          nameScore = Math.max(nameScore, 0.6);
      }
      const values = samples.map((s) => s[col.key]).filter((v) => !blank(v));
      const check = TYPE_CHECK[field];
      const valid = check ? values.filter(check).length : values.length;
      const typeRatio = values.length ? valid / values.length : 0;
      const hinted = TYPE_HINT[field]?.includes(col.type ?? '') ? 0.15 : 0;
      if (check && values.length && typeRatio < 0.6) continue; // el contenido no es de ese tipo
      if (nameScore === 0 && !(check && values.length && typeRatio >= 0.9 && hinted > 0)) continue;
      // «saldo» y «total» se confunden: el nombre manda.
      const score = nameScore * 0.7 + (check ? typeRatio * 0.3 : 0.2) + hinted;
      candidates.push({ field, col, score, valid, n: values.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const mapping: Mapping = {};
  const usedCols = new Set<string>();
  const columnsOut: ProposedColumn[] = [];
  for (const c of candidates) {
    if (mapping[c.field] || usedCols.has(c.col.key)) continue;
    // «factura» como número y como referencia: sólo la primera vez, el resto por nombre exacto.
    mapping[c.field] = c.col.key;
    usedCols.add(c.col.key);
    columnsOut.push({
      field: c.field,
      column: c.col.key,
      confidence: Math.min(1, Math.round(c.score * 100) / 100),
      validSamples: c.valid,
      totalSamples: c.n,
      examples: samples
        .map((s) => cellText(s[c.col.key]))
        .filter(Boolean)
        .slice(0, 3),
    });
  }
  const missing = spec.required.filter((f) => !mapping[f]);
  if (spec.oneOf && !spec.oneOf.some((f) => mapping[f]))
    missing.push(spec.oneOf[0] as MappingField);
  const warnings: string[] = [];
  for (const c of columnsOut) {
    if (c.totalSamples && c.validSamples < c.totalSamples)
      warnings.push(
        `«${c.column}» (${MAPPING_FIELD_LABEL[c.field]}): ${c.totalSamples - c.validSamples} de ${c.totalSamples} ejemplos no se leen como ${c.field === 'fecha' || c.field === 'vencimiento' ? 'fecha' : c.field === 'nit' ? 'NIT' : 'monto'}.`,
      );
    if (c.confidence < 0.6)
      warnings.push(
        `«${c.column}» como ${MAPPING_FIELD_LABEL[c.field]} es una suposición: confírmala.`,
      );
  }
  return { mapping, columns: columnsOut, missing, warnings };
}

/** Lo que el mapeo hace con unas filas de ejemplo: para mostrar antes de aprobar. */
export function previewNormalized(
  kind: SourceKind,
  mapping: Mapping,
  rows: readonly RawRow[],
  opts: NormalizeOptions,
  limit = 5,
): { preview: AccRecord[]; issues: RowIssue[]; stats: NormalizeResult['stats'] } {
  const r = normalizeRows(kind, mapping, rows, opts);
  return { preview: r.records.slice(0, limit), issues: r.issues, stats: r.stats };
}
