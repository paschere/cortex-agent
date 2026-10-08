import { logger } from '@cortex/core';
import {
  MAX_SHEET_CELLS,
  type RawSheet,
  detectSpreadsheetFormat,
  readSheetsByFormat,
} from './spreadsheet-bytes';

/**
 * LOS ESTADOS FINANCIEROS DEL PROGRAMA CONTABLE, A UNA SOLA FORMA (0191).
 *
 * Cada programa los entrega distinto, y lo que cada uno expone está verificado
 * contra su documentación (octubre de 2026):
 *
 *   Siigo       POST /v1/test-balance-report → `{ file_id, file_url }`: un Excel
 *               con el BALANCE DE PRUEBA (cuenta, saldo inicial, débitos,
 *               créditos, saldo final) para un año y un rango de meses. No hay
 *               balance general ni estado de resultados como tales: se arman
 *               aquí desde el balance de prueba con las clases del PUC.
 *               (reports-siigo.ts)
 *   Alegra      Las herramientas `reports__getGeneralBalance` (Estado de
 *               Situación Financiera a una fecha) y `reports__getProfitAndLoss`
 *               (Estado de Resultados en un rango), que Alegra publica en su
 *               servidor MCP (POST https://mcp.alegra.com/mcp, JSON-RPC
 *               `tools/call`, la misma llave Basic). (reports-alegra.ts)
 *   QuickBooks  Reports API: GET /reports/BalanceSheet y /reports/ProfitAndLoss
 *               (filas con `group`: TotalAssets, CurrentAssets, Income, COGS…).
 *               (reports-quickbooks.ts)
 *
 * Todo lo de aquí es puro: de filas ya leídas a `ProviderBalance` /
 * `ProviderPnl`. Lo que no se puede saber (p. ej. qué parte del pasivo es
 * corriente cuando el programa no lo separa) queda `null` y en `notes`: nunca
 * se inventa una partición.
 */

export type BalanceSection =
  | 'activo_corriente'
  | 'activo_no_corriente'
  | 'activo'
  | 'pasivo_corriente'
  | 'pasivo_no_corriente'
  | 'pasivo'
  | 'patrimonio';

export interface ReportLine {
  section: string;
  code?: string | null;
  name: string;
  amount: number;
}

export interface ProviderBalance {
  provider: 'siigo' | 'alegra' | 'quickbooks';
  /** Fecha de corte, AAAA-MM-DD. */
  asOf: string;
  currency: string;
  totalAssets: number;
  currentAssets: number | null;
  nonCurrentAssets: number | null;
  totalLiabilities: number;
  currentLiabilities: number | null;
  nonCurrentLiabilities: number | null;
  equity: number;
  /** Partidas principales (grupos), para «de dónde sale». */
  lines: ReportLine[];
  notes: string[];
}

export type PnlSection = 'ingreso' | 'costo' | 'gasto' | 'otro_ingreso' | 'otro_gasto' | 'impuesto';

export interface ProviderPnl {
  provider: 'siigo' | 'alegra' | 'quickbooks';
  from: string;
  to: string;
  currency: string;
  revenue: number;
  costOfSales: number;
  operatingExpenses: number;
  otherIncome: number;
  otherExpenses: number;
  /** Impuesto de renta, si el programa lo separa; si no, va en otros gastos. */
  incomeTax: number | null;
  netIncome: number;
  lines: ReportLine[];
  notes: string[];
}

/** Lo que una sesión de programa contable sabe leer de estados financieros. */
export interface ProviderReports {
  balanceSheet(asOf: string): Promise<ProviderBalance>;
  profitAndLoss(from: string, to: string): Promise<ProviderPnl>;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** «1.234.567,89», «(1,234.56)», «-1234.5», 1234 → número; vacío → null. */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') {
    const r = raw as { result?: unknown; value?: unknown };
    if ('result' in r) return parseAmount(r.result);
    if ('value' in r) return parseAmount(r.value);
    return null;
  }
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$\s]|COP|USD/gi, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    // Colombia: punto de miles, coma decimal.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma && lastComma >= 0) {
    s = s.replace(/,/g, '');
  } else if (lastDot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    // «1.234.567» sin decimales: miles.
    s = s.replace(/\./g, '');
  } else if (lastComma >= 0 && /^\d{1,3}(,\d{3})+$/.test(s)) {
    s = s.replace(/,/g, '');
  } else {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

// ---------------------------------------------------------------------------
// El PUC colombiano (Decreto 2650 de 1993): la clase es el primer dígito
// ---------------------------------------------------------------------------

/** Nombre del grupo (dos dígitos) del PUC, para las partidas del balance. */
export const PUC_GROUP: Record<string, string> = {
  '11': 'Disponible (caja y bancos)',
  '12': 'Inversiones',
  '13': 'Deudores (cartera)',
  '14': 'Inventarios',
  '15': 'Propiedades, planta y equipo',
  '16': 'Intangibles',
  '17': 'Diferidos',
  '18': 'Otros activos',
  '19': 'Valorizaciones',
  '21': 'Obligaciones financieras',
  '22': 'Proveedores',
  '23': 'Cuentas por pagar',
  '24': 'Impuestos por pagar',
  '25': 'Obligaciones laborales',
  '26': 'Pasivos estimados y provisiones',
  '27': 'Diferidos',
  '28': 'Otros pasivos',
  '29': 'Bonos y papeles comerciales',
  '31': 'Capital social',
  '32': 'Superávit de capital',
  '33': 'Reservas',
  '34': 'Revalorización del patrimonio',
  '36': 'Resultados del ejercicio',
  '37': 'Resultados de ejercicios anteriores',
  '38': 'Superávit por valorizaciones',
  '41': 'Ingresos operacionales',
  '42': 'Ingresos no operacionales',
  '51': 'Gastos operacionales de administración',
  '52': 'Gastos operacionales de ventas',
  '53': 'Gastos no operacionales',
  '54': 'Impuesto de renta',
  '61': 'Costo de ventas',
  '71': 'Costos de producción',
};

/** Activo corriente en el PUC: disponible, inversiones, deudores, inventarios. */
const CURRENT_ASSET_GROUPS = new Set(['11', '12', '13', '14']);
/**
 * Pasivo «de corto plazo» en el PUC: proveedores, cuentas por pagar,
 * impuestos, laborales y estimados. Las obligaciones financieras (21) pueden
 * ser de largo plazo y el PUC no lo dice: se cuentan corrientes, y se avisa.
 */
const CURRENT_LIABILITY_GROUPS = new Set(['21', '22', '23', '24', '25', '26']);

export interface TrialBalanceRow {
  code: string;
  name: string;
  initial: number;
  debit: number;
  credit: number;
  final: number;
}

/**
 * Las HOJAS del árbol de cuentas: una cuenta cuyo código no es prefijo de
 * otra más larga. Un balance de prueba trae la clase, el grupo, la cuenta y la
 * subcuenta, cada una con su total; sumarlas todas contaría lo mismo cuatro
 * veces. Las hojas, en cambio, suman exactamente una vez.
 */
export function leafAccounts(rows: TrialBalanceRow[]): TrialBalanceRow[] {
  const codes = rows.map((r) => r.code).sort();
  const isParent = new Set<string>();
  for (let i = 0; i < codes.length - 1; i++) {
    const a = codes[i] as string;
    const b = codes[i + 1] as string;
    if (b.length > a.length && b.startsWith(a)) isParent.add(a);
  }
  // Un mismo código repetido (dos filas de la misma cuenta) se suma una vez por fila.
  return rows.filter((r) => !isParent.has(r.code));
}

function sumBy(
  rows: TrialBalanceRow[],
  test: (code: string) => boolean,
  pick: (r: TrialBalanceRow) => number,
) {
  return rows.filter((r) => test(r.code)).reduce((s, r) => s + pick(r), 0);
}

/**
 * Balance general desde el balance de prueba (saldo final de las hojas).
 *
 * Los saldos de pasivo y patrimonio son de naturaleza crédito: según cómo los
 * exporte el programa salen positivos o negativos. Se mira el signo del total
 * de la clase y se lee en positivo. El resultado del ejercicio todavía no
 * cerrado (clases 4 a 7) se suma al patrimonio, para que el balance cuadre.
 */
export function balanceFromTrialBalance(
  rows: TrialBalanceRow[],
  meta: { provider: ProviderBalance['provider']; asOf: string; currency: string },
): ProviderBalance {
  const leaves = leafAccounts(rows);
  const cls = (c: string) => (code: string) => code.startsWith(c);
  const final = (r: TrialBalanceRow) => r.final;
  const assetSign = Math.sign(sumBy(leaves, cls('1'), final)) || 1;
  const liabRaw = sumBy(leaves, cls('2'), final);
  const eqRaw = sumBy(leaves, cls('3'), final);
  // Patrimonio: mismo sentido que el pasivo (los dos son crédito). Sin pasivo,
  // el signo del propio patrimonio.
  const liabSign = Math.sign(liabRaw) || Math.sign(eqRaw) || 1;
  const eqSign = liabSign;

  const group = (code: string) => code.slice(0, 2);
  const lines: ReportLine[] = [];
  const byGroup = new Map<string, number>();
  for (const r of leaves) {
    const k = r.code[0];
    if (k !== '1' && k !== '2' && k !== '3') continue;
    const g = group(r.code);
    byGroup.set(g, (byGroup.get(g) ?? 0) + r.final);
  }
  const sign = (g: string) =>
    g.startsWith('1') ? assetSign : g.startsWith('2') ? liabSign : eqSign;
  for (const [g, v] of [...byGroup.entries()].sort()) {
    const amount = round2(v * sign(g));
    if (Math.abs(amount) < 0.005) continue;
    const section = g.startsWith('1')
      ? CURRENT_ASSET_GROUPS.has(g)
        ? 'activo_corriente'
        : 'activo_no_corriente'
      : g.startsWith('2')
        ? CURRENT_LIABILITY_GROUPS.has(g)
          ? 'pasivo_corriente'
          : 'pasivo_no_corriente'
        : 'patrimonio';
    lines.push({ section, code: g, name: PUC_GROUP[g] ?? `Grupo ${g}`, amount });
  }

  // El resultado del período que sigue abierto en las cuentas de resultado.
  const pnl = pnlFromTrialBalance(rows, {
    provider: meta.provider,
    from: `${meta.asOf.slice(0, 4)}-01-01`,
    to: meta.asOf,
    currency: meta.currency,
  });
  const openResult = round2(pnl.netIncome);
  if (Math.abs(openResult) >= 0.005)
    lines.push({
      section: 'patrimonio',
      code: null,
      name: 'Resultado del ejercicio (cuentas de resultado sin cerrar)',
      amount: openResult,
    });

  const total = (s: string) =>
    round2(lines.filter((l) => l.section === s).reduce((a, l) => a + l.amount, 0));
  const currentAssets = total('activo_corriente');
  const nonCurrentAssets = total('activo_no_corriente');
  const currentLiabilities = total('pasivo_corriente');
  const nonCurrentLiabilities = total('pasivo_no_corriente');
  const equity = round2(eqRaw * eqSign + openResult);
  const notes = [
    'Armado desde el balance de prueba con las clases del PUC: activo corriente = grupos 11 a 14; pasivo corriente = grupos 21 a 26.',
  ];
  if (byGroup.has('21'))
    notes.push(
      'Las obligaciones financieras (grupo 21) se cuentan como corrientes: el PUC no separa la porción de largo plazo.',
    );
  return {
    provider: meta.provider,
    asOf: meta.asOf,
    currency: meta.currency,
    totalAssets: round2(currentAssets + nonCurrentAssets),
    currentAssets,
    nonCurrentAssets,
    totalLiabilities: round2(currentLiabilities + nonCurrentLiabilities),
    currentLiabilities,
    nonCurrentLiabilities,
    equity,
    lines,
    notes,
  };
}

/**
 * Estado de resultados desde el balance de prueba de un rango de meses: los
 * MOVIMIENTOS del período (no el saldo, que depende de cómo exporte el
 * programa el signo). Ingresos = créditos − débitos de la clase 4; costos y
 * gastos = débitos − créditos de las clases 5, 6 y 7.
 */
export function pnlFromTrialBalance(
  rows: TrialBalanceRow[],
  meta: { provider: ProviderPnl['provider']; from: string; to: string; currency: string },
): ProviderPnl {
  const leaves = leafAccounts(rows);
  const credit = (r: TrialBalanceRow) => r.credit - r.debit;
  const debit = (r: TrialBalanceRow) => r.debit - r.credit;
  const starts = (p: string) => (code: string) => code.startsWith(p);
  const revenue = sumBy(leaves, starts('41'), credit);
  const otherIncome = sumBy(leaves, (c) => c.startsWith('4') && !c.startsWith('41'), credit);
  const cost = sumBy(leaves, (c) => c.startsWith('6') || c.startsWith('7'), debit);
  const opex = sumBy(leaves, (c) => c.startsWith('51') || c.startsWith('52'), debit);
  const tax = sumBy(leaves, starts('54'), debit);
  const otherExp = sumBy(
    leaves,
    (c) => c.startsWith('5') && !c.startsWith('51') && !c.startsWith('52') && !c.startsWith('54'),
    debit,
  );
  const lines: ReportLine[] = [];
  const groups = new Map<string, number>();
  for (const r of leaves) {
    const k = r.code[0];
    if (!k || !'4567'.includes(k)) continue;
    const g = r.code.slice(0, 2);
    groups.set(g, (groups.get(g) ?? 0) + (k === '4' ? credit(r) : debit(r)));
  }
  for (const [g, v] of [...groups.entries()].sort()) {
    if (Math.abs(v) < 0.005) continue;
    const section: PnlSection =
      g === '41'
        ? 'ingreso'
        : g.startsWith('4')
          ? 'otro_ingreso'
          : g.startsWith('6') || g.startsWith('7')
            ? 'costo'
            : g === '51' || g === '52'
              ? 'gasto'
              : g === '54'
                ? 'impuesto'
                : 'otro_gasto';
    lines.push({ section, code: g, name: PUC_GROUP[g] ?? `Grupo ${g}`, amount: round2(v) });
  }
  return {
    provider: meta.provider,
    from: meta.from,
    to: meta.to,
    currency: meta.currency,
    revenue: round2(revenue),
    costOfSales: round2(cost),
    operatingExpenses: round2(opex),
    otherIncome: round2(otherIncome),
    otherExpenses: round2(otherExp),
    incomeTax: round2(tax),
    netIncome: round2(revenue + otherIncome - cost - opex - otherExp - tax),
    lines,
    notes: [
      'Armado desde los movimientos del balance de prueba: ingresos = clase 4; costos = clases 6 y 7; gastos operacionales = grupos 51 y 52.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Un balance de prueba en Excel → filas
// ---------------------------------------------------------------------------

const HEADER = {
  code: /^(c[oó]digo|cuenta( contable)?|c[oó]d\.?( cuenta)?|n[uú]mero de cuenta)$/i,
  name: /(nombre|descripci[oó]n)/i,
  initial: /saldo (inicial|anterior)/i,
  debit: /d[eé]bito/i,
  credit: /cr[eé]dito/i,
  final: /(saldo final|nuevo saldo|saldo actual)/i,
};

function norm(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'object') {
    const c = cell as { text?: unknown; result?: unknown; richText?: Array<{ text?: string }> };
    if (Array.isArray(c.richText))
      return c.richText
        .map((t) => t.text ?? '')
        .join('')
        .trim();
    if (c.text !== undefined) return String(c.text).trim();
    if (c.result !== undefined) return String(c.result).trim();
  }
  return String(cell).replace(/\s+/g, ' ').trim();
}

/**
 * Filas de una hoja (celdas ya leídas) → cuentas del balance de prueba. Busca
 * el encabezado (código, débito, crédito y saldo final) en las primeras 40
 * filas: los programas ponen arriba el nombre de la empresa, el NIT y el
 * período. Una fila sin código numérico (subtotales, totales) no es cuenta.
 */
export function trialBalanceFromRows(rows: unknown[][]): TrialBalanceRow[] {
  let header = -1;
  const col: Partial<Record<keyof typeof HEADER, number>> = {};
  for (let i = 0; i < Math.min(rows.length, 40) && header < 0; i++) {
    const cells = (rows[i] ?? []).map(norm);
    const find = (re: RegExp) => cells.findIndex((c) => re.test(c));
    const debit = find(HEADER.debit);
    const credit = find(HEADER.credit);
    const final = find(HEADER.final);
    let code = cells.findIndex((c) => HEADER.code.test(c));
    if (code < 0) code = cells.findIndex((c) => /c[oó]digo/i.test(c));
    if (debit >= 0 && credit >= 0 && final >= 0 && code >= 0) {
      header = i;
      col.code = code;
      col.debit = debit;
      col.credit = credit;
      col.final = final;
      const initial = find(HEADER.initial);
      if (initial >= 0) col.initial = initial;
      const name = cells.findIndex((c, idx) => idx !== code && HEADER.name.test(c));
      if (name >= 0) col.name = name;
    }
  }
  if (header < 0) return [];
  const out: TrialBalanceRow[] = [];
  for (const raw of rows.slice(header + 1)) {
    const cells = raw ?? [];
    const code = norm(cells[col.code as number]).replace(/[\s.\-]/g, '');
    if (!/^\d{1,16}$/.test(code)) continue;
    const num = (k: keyof typeof HEADER) =>
      col[k] === undefined ? 0 : (parseAmount(cells[col[k] as number]) ?? 0);
    out.push({
      code,
      name: col.name === undefined ? code : norm(cells[col.name]) || code,
      initial: num('initial'),
      debit: num('debit'),
      credit: num('credit'),
      final: num('final'),
    });
  }
  return out;
}

/**
 * Un archivo de hoja de cálculo (bytes) → filas de su primera hoja con datos
 * de balance de prueba. Detecta el formato por firma (xlsx, HTML como .xls…);
 * un .xlsx va por exceljs y, si éste falla, por el lector mínimo propio.
 */
export async function readSpreadsheetBytes(
  bytes: Uint8Array,
  opts: { contentType?: string | null } = {},
): Promise<unknown[][]> {
  const sheets = await readSheetsByFormat(bytes, {
    tryPrimary: async (b) => {
      const { default: ExcelJS } = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      // exceljs tipa `load` con el Buffer de una versión vieja de @types/node.
      await workbook.xlsx.load(
        Buffer.from(b) as unknown as Parameters<typeof workbook.xlsx.load>[0],
      );
      const out: RawSheet[] = [];
      for (const sheet of workbook.worksheets) {
        if (sheet.rowCount * Math.max(sheet.columnCount, 1) > MAX_SHEET_CELLS) continue;
        const rows: unknown[][] = [];
        sheet.eachRow({ includeEmpty: true }, (row) => {
          rows.push(Array.from({ length: sheet.columnCount }, (_, i) => row.getCell(i + 1).value));
        });
        out.push({ name: sheet.name, rows: rows as RawSheet['rows'] });
      }
      return out;
    },
    onPrimaryFailure: (err, format) =>
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          format,
          contentType: opts.contentType ?? null,
          bytes: bytes.length,
        },
        'exceljs no pudo leer la hoja; uso el lector mínimo',
      ),
  }).catch((err) => {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        format: detectSpreadsheetFormat(bytes),
        contentType: opts.contentType ?? null,
        bytes: bytes.length,
      },
      'no se pudo leer la hoja de cálculo',
    );
    throw err;
  });
  for (const sheet of sheets) {
    if (trialBalanceFromRows(sheet.rows).length) return sheet.rows;
  }
  return [];
}

/** Un .xlsx (bytes) → filas de su primera hoja con datos. */
export const xlsxRows = readSpreadsheetBytes;
