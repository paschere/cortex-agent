import { type PurchaseDocInput, type SaleDocInput, round2 } from './draft-shape';
import { resolveConcept } from './drafts';
import type { WithholdingConcept } from './rates-co';
import { nitCheckDigit } from './shape';

/**
 * LA PREPARACIÓN DE LA EXÓGENA (formatos 1001, 1007, 1008 y 1009). PURO.
 *
 * Cortex NO genera el XML que se sube a la DIAN: arma, con los datos que ya
 * tiene, las listas por tercero que el contador necesita para llenar cada
 * formato, en CSV. Las versiones de los formatos y los códigos de concepto
 * cambian por resolución cada año: aquí van como «por confirmar» y el
 * encabezado del CSV lo dice.
 *
 *   1001  Pagos o abonos en cuenta y retenciones practicadas  ← cuentas por pagar (0181)
 *   1007  Ingresos recibidos                                   ← facturas de venta (0182)
 *   1008  Saldos de cuentas por cobrar al 31 de diciembre      ← el libro (0172)
 *   1009  Saldos de cuentas por pagar al 31 de diciembre       ← cuentas por pagar (0181)
 */

export const EXOGENA_FORMATS = ['1001', '1007', '1008', '1009'] as const;
export type ExogenaFormatCode = (typeof EXOGENA_FORMATS)[number];

export const EXOGENA_FORMAT_LABEL: Record<ExogenaFormatCode, string> = {
  '1001': 'Pagos o abonos en cuenta y retenciones practicadas',
  '1007': 'Ingresos recibidos',
  '1008': 'Saldos de cuentas por cobrar al 31 de diciembre',
  '1009': 'Saldos de cuentas por pagar al 31 de diciembre',
};

/** Los códigos de concepto de 1001 que se usan aquí. POR CONFIRMAR con la resolución del año. */
export const CONCEPT_1001: Record<WithholdingConcept | 'sin_concepto', string> = {
  compras: '5007',
  servicios: '5004',
  honorarios: '5002',
  comisiones: '5003',
  arrendamiento_inmuebles: '5005',
  arrendamiento_muebles: '5005',
  transporte: '5004',
  servicios_temporales: '5004',
  otros: '5016',
  sin_concepto: '5016',
};

export interface ExogenaPurchase extends PurchaseDocInput {
  /** Día en que se pagó (null = sigue por pagar). */
  paidAt: string | null;
  supplierDv?: string | null;
}

export interface ExogenaReceivable {
  id: string;
  thirdNit: string | null;
  thirdName: string | null;
  date: string;
  amount: number;
  settledAt: string | null;
}

export interface ExogenaFormat {
  code: ExogenaFormatCode;
  title: string;
  year: number;
  /** Siempre por confirmar: la versión del formato es de la resolución del año. */
  versionNote: string;
  columns: string[];
  rows: Array<Array<string | number>>;
  total: number;
  /** Lo que no se pudo poner (sin NIT, en otra moneda…). */
  missing: string[];
  notes: string[];
}

const VERSION_NOTE =
  'Versión del formato y códigos de concepto por confirmar con la resolución de exógena del año';

function dvOf(nit: string | null, given?: string | null): string {
  if (!nit) return '';
  return given ?? nitCheckDigit(nit);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function buildExogena(input: {
  year: number;
  purchases: ExogenaPurchase[];
  sales: SaleDocInput[];
  receivables: ExogenaReceivable[];
}): ExogenaFormat[] {
  const y = input.year;
  const inYear = (d: string) => d.startsWith(`${y}-`);
  const dec31 = `${y}-12-31`;

  // --- 1001 -------------------------------------------------------------------
  const purchases = input.purchases.filter((d) => inYear(d.date));
  const noNit1001 = purchases.filter((d) => !d.supplierNit);
  const map1001 = new Map<
    string,
    {
      concept: string;
      nit: string;
      dv: string;
      name: string;
      pago: number;
      iva: number;
      rf: number;
      riva: number;
    }
  >();
  for (const d of purchases) {
    if (!d.supplierNit) continue;
    const sign = d.kind === 'credit_note' ? -1 : 1;
    const { concept } = resolveConcept(d);
    const code = CONCEPT_1001[concept ?? 'sin_concepto'];
    const key = `${code}|${d.supplierNit}`;
    const cur = map1001.get(key) ?? {
      concept: code,
      nit: d.supplierNit,
      dv: dvOf(d.supplierNit, d.supplierDv),
      name: d.supplierName,
      pago: 0,
      iva: 0,
      rf: 0,
      riva: 0,
    };
    cur.pago = round2(cur.pago + sign * (d.subtotal ?? Math.max(0, d.total - d.iva)));
    cur.iva = round2(cur.iva + sign * d.iva);
    cur.rf = round2(cur.rf + sign * d.retefuente);
    cur.riva = round2(cur.riva + sign * d.reteiva);
    map1001.set(key, cur);
  }
  const rows1001 = [...map1001.values()].sort(
    (a, b) => a.concept.localeCompare(b.concept) || b.pago - a.pago,
  );
  const f1001: ExogenaFormat = {
    code: '1001',
    title: EXOGENA_FORMAT_LABEL['1001'],
    year: y,
    versionNote: VERSION_NOTE,
    columns: [
      'Concepto',
      'Tipo de documento',
      'Número de identificación',
      'DV (calculado)',
      'Razón social o nombre',
      'Pago o abono en cuenta',
      'IVA',
      'Retención en la fuente practicada (renta)',
      'Retención de IVA practicada',
    ],
    rows: rows1001.map((r) => [r.concept, '31', r.nit, r.dv, r.name, r.pago, r.iva, r.rf, r.riva]),
    total: round2(rows1001.reduce((s, r) => s + r.pago, 0)),
    missing: noNit1001.length
      ? [
          `${plural(noNit1001.length, 'factura de proveedor', 'facturas de proveedor')} sin NIT: no se pueden reportar por tercero.`,
        ]
      : [],
    notes: [
      'Tipo de documento 31 = NIT; si el tercero es persona natural con cédula, cámbialo a 13.',
      'El concepto sale del concepto de retención del proveedor (o se deduce de la tarifa).',
      'Los terceros por debajo de la cuantía mínima van agregados según la resolución: lo hace tu contador.',
    ],
  };

  // --- 1007 -------------------------------------------------------------------
  const sales = input.sales.filter((d) => inYear(d.date));
  const noNit1007 = sales.filter((d) => !d.clientNit);
  const map1007 = new Map<
    string,
    { nit: string; name: string; ingresos: number; devoluciones: number }
  >();
  for (const d of sales) {
    if (!d.clientNit) continue;
    const base = round2(d.lines.reduce((s, l) => s + l.base, 0));
    const cur = map1007.get(d.clientNit) ?? {
      nit: d.clientNit,
      name: d.clientName,
      ingresos: 0,
      devoluciones: 0,
    };
    if (d.kind === 'credit_note') cur.devoluciones = round2(cur.devoluciones + base);
    else cur.ingresos = round2(cur.ingresos + base);
    map1007.set(d.clientNit, cur);
  }
  const rows1007 = [...map1007.values()].sort((a, b) => b.ingresos - a.ingresos);
  const f1007: ExogenaFormat = {
    code: '1007',
    title: EXOGENA_FORMAT_LABEL['1007'],
    year: y,
    versionNote: VERSION_NOTE,
    columns: [
      'Concepto',
      'Tipo de documento',
      'Número de identificación',
      'DV (calculado)',
      'Razón social o nombre',
      'Ingresos brutos recibidos',
      'Devoluciones, rebajas y descuentos',
    ],
    rows: rows1007.map((r) => [
      '4001',
      '31',
      r.nit,
      dvOf(r.nit),
      r.name,
      r.ingresos,
      r.devoluciones,
    ]),
    total: round2(rows1007.reduce((s, r) => s + r.ingresos - r.devoluciones, 0)),
    missing: noNit1007.length
      ? [
          `${plural(noNit1007.length, 'factura de venta', 'facturas de venta')} sin NIT del cliente.`,
        ]
      : [],
    notes: [
      'Sólo las facturas emitidas desde Cortex. Si facturas también en el programa contable, usa su reporte de ingresos por tercero.',
    ],
  };

  // --- 1008 -------------------------------------------------------------------
  const open1008 = input.receivables.filter(
    (r) => r.date <= dec31 && (r.settledAt === null || r.settledAt > dec31),
  );
  const noNit1008 = open1008.filter((r) => !r.thirdNit);
  const map1008 = new Map<string, { nit: string; name: string; saldo: number }>();
  for (const r of open1008) {
    if (!r.thirdNit) continue;
    const cur = map1008.get(r.thirdNit) ?? { nit: r.thirdNit, name: r.thirdName ?? '', saldo: 0 };
    cur.saldo = round2(cur.saldo + r.amount);
    map1008.set(r.thirdNit, cur);
  }
  const rows1008 = [...map1008.values()].sort((a, b) => b.saldo - a.saldo);
  const f1008: ExogenaFormat = {
    code: '1008',
    title: EXOGENA_FORMAT_LABEL['1008'],
    year: y,
    versionNote: VERSION_NOTE,
    columns: [
      'Concepto',
      'Tipo de documento',
      'Número de identificación',
      'DV (calculado)',
      'Razón social o nombre',
      'Saldo al 31 de diciembre',
    ],
    rows: rows1008.map((r) => ['1315', '31', r.nit, dvOf(r.nit), r.name, r.saldo]),
    total: round2(rows1008.reduce((s, r) => s + r.saldo, 0)),
    missing: noNit1008.length
      ? [
          `${plural(noNit1008.length, 'cuenta por cobrar', 'cuentas por cobrar')} sin NIT del cliente.`,
        ]
      : [],
    notes: [
      'Facturas emitidas hasta el 31 de diciembre que no se habían cobrado a esa fecha, por su valor completo: un abono parcial no se descuenta. Compáralo con el auxiliar de clientes.',
    ],
  };

  // --- 1009 -------------------------------------------------------------------
  const open1009 = input.purchases.filter(
    (d) => d.date <= dec31 && d.kind === 'invoice' && (d.paidAt === null || d.paidAt > dec31),
  );
  const noNit1009 = open1009.filter((d) => !d.supplierNit);
  const map1009 = new Map<string, { nit: string; dv: string; name: string; saldo: number }>();
  for (const d of open1009) {
    if (!d.supplierNit) continue;
    const net = round2(Math.max(0, d.total - d.retefuente - d.reteiva - d.reteica));
    const cur = map1009.get(d.supplierNit) ?? {
      nit: d.supplierNit,
      dv: dvOf(d.supplierNit, d.supplierDv),
      name: d.supplierName,
      saldo: 0,
    };
    cur.saldo = round2(cur.saldo + net);
    map1009.set(d.supplierNit, cur);
  }
  const rows1009 = [...map1009.values()].sort((a, b) => b.saldo - a.saldo);
  const f1009: ExogenaFormat = {
    code: '1009',
    title: EXOGENA_FORMAT_LABEL['1009'],
    year: y,
    versionNote: VERSION_NOTE,
    columns: [
      'Concepto',
      'Tipo de documento',
      'Número de identificación',
      'DV (calculado)',
      'Razón social o nombre',
      'Saldo al 31 de diciembre',
    ],
    rows: rows1009.map((r) => ['2201', '31', r.nit, r.dv, r.name, r.saldo]),
    total: round2(rows1009.reduce((s, r) => s + r.saldo, 0)),
    missing: noNit1009.length
      ? [
          `${plural(noNit1009.length, 'factura por pagar', 'facturas por pagar')} sin NIT del proveedor.`,
        ]
      : [],
    notes: [
      'Facturas de proveedor recibidas hasta el 31 de diciembre y no pagadas a esa fecha, netas de retenciones.',
    ],
  };

  return [f1001, f1007, f1008, f1009];
}

function cell(v: string | number): string {
  if (typeof v === 'number') return String(Math.round(v));
  const text = v.replace(/\r?\n/g, ' ');
  return /[",;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Un formato como CSV (con BOM para que Excel abra las tildes), con su advertencia arriba. */
export function exogenaCsv(f: ExogenaFormat): string {
  const head = [
    `# Formato ${f.code} — ${f.title} — año gravable ${f.year}`,
    `# Borrador — tu contador revisa y presenta. ${f.versionNote}.`,
  ];
  const lines = [f.columns.map(cell).join(','), ...f.rows.map((r) => r.map(cell).join(','))];
  return `﻿${[...head, ...lines].join('\r\n')}\r\n`;
}
