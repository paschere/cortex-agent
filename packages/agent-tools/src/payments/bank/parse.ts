import { createHash } from 'node:crypto';
import {
  type Cell,
  type DateOrder,
  type DecimalStyle,
  cellText,
  inferDateOrder,
  inferDecimalStyle,
  normalizeHeader,
  normalizeText,
  parseAmount,
  parseDate,
} from './format';
import {
  type BankId,
  type BankProfile,
  COLUMN_ROLES,
  type ColumnMap,
  type ColumnRole,
  detectBank,
  mapColumns,
  mapIsUsable,
  profileOf,
} from './profiles';

/**
 * Un extracto bancario, de filas a abonos.
 *
 * PURO: recibe las filas ya leídas del archivo (`read.ts` sabe de CSV y de
 * Excel) y devuelve los movimientos que entraron, cada uno con la referencia
 * que hace que reimportarlo no lo duplique. Nada de aquí toca la base de datos.
 *
 * SÓLO LO QUE ENTRÓ. Un extracto trae también lo que salió —nómina, pagos a
 * proveedores, el 4x1000— y eso, por ahora, se cuenta y se ignora: lo que este
 * módulo responde es «¿qué facturas me pagaron?».
 *
 * LA REFERENCIA DE CADA ABONO (`sourceRef`), Y POR QUÉ ES ASÍ:
 *
 *   Si el banco da un id de transacción, ése es: `t:<fecha>:<id>`. La fecha va
 *   delante porque más de un banco reinicia su consecutivo cada día.
 *
 *   Si no, una huella estable del movimiento: fecha, importe, descripción,
 *   referencia y SALDO DESPUÉS del movimiento. El saldo es lo que separa dos
 *   abonos idénticos del mismo día (dos clientes pagando $1.000.000 por PSE con
 *   la misma glosa). Sin columna de saldo, el lugar que ocupa entre sus gemelos
 *   idénticos de ese día (1.º, 2.º…). Así, importar el mismo archivo dos veces,
 *   o dos meses que se solapan, produce las mismas referencias y la base de
 *   datos rechaza la segunda copia (`payment_reports_source_once_idx`).
 *
 *   La cuenta NO está en la huella: va en `source_system` (ver `store.ts`), de
 *   modo que dos cuentas nunca comparten referencias.
 */

export interface StatementLine {
  /** Fila del archivo, contando desde 1, para poder decir «la fila 14». */
  line: number;
  date: string;
  /** Siempre positivo. */
  amount: number;
  direction: 'credit' | 'debit';
  description: string;
  reference: string | null;
  txid: string | null;
  nit: string | null;
  counterparty: string | null;
  balance: number | null;
}

export interface StatementCredit extends StatementLine {
  direction: 'credit';
  sourceRef: string;
}

/**
 * Una salida del extracto, con su huella. Pagos no las usa (una salida no es
 * el pago de un cliente); el libro de plata (0172) sí: son los gastos.
 */
export interface StatementDebit extends StatementLine {
  direction: 'debit';
  sourceRef: string;
}

export interface SkippedLine {
  line: number;
  reason: string;
}

export interface ParsedStatement {
  status: 'ready';
  bank: { id: BankId; label: string; detectedBy: 'name' | 'headers' | 'none' | 'chosen' };
  /** Índice (desde 0) de la fila de encabezados, o -1 si el archivo no trae. */
  headerRow: number;
  headers: string[];
  columns: ColumnMap;
  /** El encabezado de cada papel, para enseñarlo. */
  columnNames: Partial<Record<ColumnRole, string>>;
  /** El número de cuenta, si las primeras filas lo dicen. */
  accountHint: string | null;
  credits: StatementCredit[];
  debits: number;
  debitsTotal: number;
  /** Las salidas, una por una, para el libro de plata. Pagos no las lee. */
  debitLines?: StatementDebit[];
  /** El saldo con el que cerró la cuenta, si el archivo trae columna de saldo. */
  closing?: { date: string; balance: number } | null;
  skipped: SkippedLine[];
  period: { from: string; to: string } | null;
  warnings: string[];
}

export interface NeedsMapping {
  status: 'needs_mapping';
  /** En español, listo para enseñarse. */
  message: string;
  headerRow: number;
  headers: string[];
  /** Unas filas de muestra, para escoger columnas mirando los datos. */
  sample: string[][];
  bank: { id: BankId; label: string };
}

export type StatementParse = ParsedStatement | NeedsMapping;

/** Lo que la persona escogió cuando el formato no se reconoció. */
export interface ManualMapping {
  /** Índice (desde 0) de la fila de encabezados; -1 si el archivo no trae. */
  headerRow?: number;
  columns: ColumnMap;
}

export interface ParseOptions {
  fileName?: string | null;
  /** Forzar el banco en vez de detectarlo. Sólo cambia la etiqueta. */
  bank?: BankId | null;
  mapping?: ManualMapping | null;
}

const MAX_ROWS = 20_000;
const HEADER_SCAN = 40;

/** Palabras que dicen «esto entró» o «esto salió» cuando el importe no trae signo. */
const CREDIT_WORDS =
  /\b(ABONO|CONSIGNACION|CONSIG|DEPOSITO|NOTA CREDITO|NC|RECAUDO|TRANSFERENCIA RECIBIDA|TRANSF(?:ERENCIA)? DE|PAGO RECIBIDO|INGRESO|CREDITO|ACH CREDITO|ENTRADA|RECIBIDO)\b/;
const DEBIT_WORDS =
  /\b(RETIRO|COMPRA|CARGO|NOTA DEBITO|ND|DEBITO|COMISION|GMF|4X1000|IVA|CUOTA|PAGO A|PAGO DE (?:NOMINA|PROVEEDORES|IMPUESTOS|SERVICIOS)|TRANSFERENCIA ENVIADA|TRANSF(?:ERENCIA)? A|EGRESO|SALIDA|CHEQUE PAGADO)\b/;
const DIRECTION_CREDIT = /^(C|CR|CRED|CREDITO|ABONO|INGRESO|ENTRADA|\+)$/;
const DIRECTION_DEBIT = /^(D|DB|DEB|DEBITO|CARGO|EGRESO|SALIDA|-)$/;
/** Filas de resumen que no son movimientos. */
const SUMMARY_ROW = /^(SALDO (ANTERIOR|INICIAL|FINAL|ACTUAL)|TOTAL(ES)?\b|SUBTOTAL)/;

function rowIsEmpty(row: Cell[]): boolean {
  return row.every((c) => cellText(c) === '');
}

function rowText(row: Cell[]): string {
  return row
    .map(cellText)
    .filter((t) => t.length > 0)
    .join(' ');
}

/** Cuántos papeles reconoce una fila si fuera el encabezado. */
function headerScore(row: Cell[]): { map: ColumnMap; score: number } {
  const headers = row.map((c) => cellText(c));
  const map = mapColumns(headers);
  const score = Object.keys(map).length;
  return { map, score: mapIsUsable(map) ? score : 0 };
}

/** La fila que mejor parece un encabezado entre las primeras. */
function findHeaderRow(rows: Cell[][]): { index: number; map: ColumnMap } | null {
  let best: { index: number; map: ColumnMap; score: number } | null = null;
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN); i += 1) {
    const { map, score } = headerScore(rows[i] ?? []);
    if (score >= 2 && (!best || score > best.score)) best = { index: i, map, score };
  }
  return best ? { index: best.index, map: best.map } : null;
}

/** La fila con más celdas de texto entre las primeras: lo más parecido a un encabezado. */
function likelyHeaderRow(rows: Cell[][]): number {
  let best = -1;
  let bestCount = 1;
  for (let i = 0; i < Math.min(rows.length, 15); i += 1) {
    const count = (rows[i] ?? []).filter(
      (c) => typeof c === 'string' && /[a-zA-Z]/.test(c) && parseDate(c) == null,
    ).length;
    if (count > bestCount) {
      best = i;
      bestCount = count;
    }
  }
  return best;
}

function accountHintOf(preamble: string): string | null {
  const m = /cuenta[^0-9]{0,40}?((?:\d[\d\s-]{4,}\d))/i.exec(preamble);
  if (!m?.[1]) return null;
  const digits = m[1].replace(/\D/g, '');
  return digits.length >= 6 ? digits : null;
}

function yearHintOf(preamble: string): number | null {
  const m = /\b(20\d{2})\b/.exec(preamble);
  return m ? Number(m[1]) : null;
}

function columnValues(rows: Cell[][], col: number | undefined): Cell[] {
  if (col == null) return [];
  return rows.map((r) => r[col]);
}

/**
 * El nombre del archivo dice el banco a veces ("movimientos_bancolombia.xlsx");
 * el texto antes del encabezado lo dice casi siempre.
 */
function preambleOf(rows: Cell[][], headerRow: number): string {
  const end = headerRow >= 0 ? headerRow : Math.min(rows.length, 8);
  return rows.slice(0, end).map(rowText).join(' ').slice(0, 4000);
}

function sampleOf(rows: Cell[][], from: number): string[][] {
  return rows
    .slice(from, from + 6)
    .filter((r) => !rowIsEmpty(r))
    .map((r) => r.map((c) => cellText(c).slice(0, 60)));
}

function headersOf(rows: Cell[][], headerRow: number): string[] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const header = headerRow >= 0 ? (rows[headerRow] ?? []) : [];
  return Array.from({ length: width }, (_, i) => cellText(header[i]) || `Columna ${i + 1}`);
}

/**
 * Leer un extracto ya convertido en filas.
 *
 * Devuelve `needs_mapping` —nunca una excepción— cuando no se reconoce qué
 * columna es qué: la pantalla enseña los encabezados encontrados y deja
 * escoger, que es mejor que adivinar con el dinero de otro.
 */
export function parseStatementRows(input: Cell[][], opts: ParseOptions = {}): StatementParse {
  const rows = input.slice(0, MAX_ROWS + HEADER_SCAN);
  const warnings: string[] = [];
  if (input.length > rows.length) {
    warnings.push(
      `El archivo trae más de ${MAX_ROWS.toLocaleString('es-CO')} filas; se leyeron las primeras. Divide el periodo para importar el resto.`,
    );
  }

  let headerRow: number;
  let map: ColumnMap;
  let chosen = false;
  if (opts.mapping) {
    headerRow = opts.mapping.headerRow ?? -1;
    map = { ...opts.mapping.columns };
    chosen = true;
  } else {
    const found = findHeaderRow(rows);
    headerRow = found?.index ?? likelyHeaderRow(rows);
    map = found?.map ?? {};
  }

  const headers = headersOf(rows, headerRow);
  const preamble = preambleOf(rows, headerRow);
  const detected = opts.bank
    ? { profile: profileOf(opts.bank), by: 'chosen' as const }
    : detectBank({ headers, preamble, fileName: opts.fileName });
  const bank = detected.profile;

  if (!mapIsUsable(map)) {
    const found = headers.filter((h) => !/^Columna \d+$/.test(h));
    return {
      status: 'needs_mapping',
      message: chosen
        ? 'Para leer el extracto hace falta, como mínimo, la columna de la fecha y la del valor (o la de créditos). Escoge cuáles son.'
        : found.length
          ? `No reconocí qué columna es la fecha y cuál el valor. Encontré estos encabezados: ${found.join(', ')}. Escoge qué es cada uno.`
          : 'El archivo no trae encabezados que reconozca. Escoge qué columna es la fecha y cuál el valor mirando las filas de muestra.',
      headerRow,
      headers,
      sample: sampleOf(rows, headerRow + 1),
      bank: { id: bank.id, label: bank.label },
    };
  }
  for (const role of COLUMN_ROLES) {
    const col = map[role];
    if (col != null && (col < 0 || col >= Math.max(headers.length, 1))) delete map[role];
  }

  const body = rows.slice(headerRow + 1);
  const dateOrder: DateOrder = inferDateOrder(columnValues(body, map.date));
  const style = (col: number | undefined): DecimalStyle | null =>
    inferDecimalStyle(columnValues(body, col));
  const amountStyle = style(map.amount);
  const creditStyle = style(map.credit);
  const debitStyle = style(map.debit);
  const balanceStyle = style(map.balance);
  const yearHint = yearHintOf(preamble);

  // ¿El valor trae signo? Si alguna fila es negativa, o el banco exporta con
  // signo, el signo manda.
  const signed =
    map.amount != null &&
    (bank.signedAmounts ||
      columnValues(body, map.amount).some((v) => (parseAmount(v, amountStyle) ?? 0) < 0));

  const lines: StatementLine[] = [];
  const skipped: SkippedLine[] = [];
  let unknownDirection = 0;

  body.forEach((row, i) => {
    const line = headerRow + 2 + i;
    if (rowIsEmpty(row)) return;
    const text = rowText(row);
    const description = map.description != null ? cellText(row[map.description]) : '';
    if (SUMMARY_ROW.test(normalizeText(description || text))) return;

    let amount: number | null = null;
    let direction: 'credit' | 'debit' | null = null;
    if (map.credit != null || map.debit != null) {
      const credit = map.credit != null ? parseAmount(row[map.credit], creditStyle) : null;
      const debit = map.debit != null ? parseAmount(row[map.debit], debitStyle) : null;
      // Un valor NEGATIVO en la columna de créditos es una reversa (sale plata)
      // y uno negativo en la de débitos también entra: el signo no se pierde.
      if (credit != null && Math.abs(credit) > 0.004) {
        amount = Math.abs(credit);
        direction = credit < 0 ? 'debit' : 'credit';
      } else if (debit != null && Math.abs(debit) > 0.004) {
        amount = Math.abs(debit);
        direction = debit < 0 ? 'credit' : 'debit';
      } else if (map.amount != null) {
        // Créditos vacíos y un valor aparte: se cae al valor de abajo.
      } else {
        if (credit == null && debit == null) {
          const date = map.date != null ? parseDate(row[map.date], dateOrder, yearHint) : null;
          if (date) skipped.push({ line, reason: 'sin valor' });
        }
        return;
      }
    }
    if (amount == null && map.amount != null) {
      const value = parseAmount(row[map.amount], amountStyle);
      if (value == null) {
        const date = map.date != null ? parseDate(row[map.date], dateOrder, yearHint) : null;
        if (date) skipped.push({ line, reason: 'el valor no es un número' });
        return;
      }
      if (Math.abs(value) < 0.005) return;
      amount = Math.abs(value);
      const flag =
        map.direction != null ? normalizeText(cellText(row[map.direction])).replace(/\.$/, '') : '';
      if (DIRECTION_CREDIT.test(flag)) direction = 'credit';
      else if (DIRECTION_DEBIT.test(flag)) direction = 'debit';
      else if (signed) direction = value < 0 ? 'debit' : 'credit';
      else {
        const words = normalizeText(text);
        const isDebit = DEBIT_WORDS.test(words);
        const isCredit = CREDIT_WORDS.test(words);
        if (isCredit && !isDebit) direction = 'credit';
        else if (isDebit && !isCredit) direction = 'debit';
        else {
          unknownDirection += 1;
          skipped.push({ line, reason: 'no se sabe si entró o salió' });
          return;
        }
      }
    }
    if (amount == null || direction == null) return;

    const date = map.date != null ? parseDate(row[map.date], dateOrder, yearHint) : null;
    if (!date) {
      skipped.push({ line, reason: 'sin fecha válida' });
      return;
    }

    const refs = [map.reference, map.reference2]
      .map((c) => (c != null ? cellText(row[c]) : ''))
      .filter((r) => r.length > 0 && r !== '0');
    lines.push({
      line,
      date,
      amount,
      direction,
      description: description || text.slice(0, 200),
      reference: refs.length ? refs.join(' / ').slice(0, 200) : null,
      txid: map.txid != null ? cellText(row[map.txid]) || null : null,
      nit: map.nit != null ? cellText(row[map.nit]) || null : null,
      counterparty: map.counterparty != null ? cellText(row[map.counterparty]) || null : null,
      balance: map.balance != null ? parseAmount(row[map.balance], balanceStyle) : null,
    });
  });

  if (unknownDirection > 0) {
    warnings.push(
      `${unknownDirection} movimiento(s) traen el valor sin signo y sin decir si fueron entrada o salida, así que no se importaron. Si el archivo tiene una columna de tipo (débito/crédito), escógela.`,
    );
  }

  const credits = assignSourceRefs(lines.filter((l) => l.direction === 'credit')).map((l) => ({
    ...l,
    direction: 'credit' as const,
  }));
  const debits = lines.filter((l) => l.direction === 'debit');
  const debitLines = assignSourceRefs(debits).map((l) => ({ ...l, direction: 'debit' as const }));
  const dates = lines.map((l) => l.date).sort();

  const columnNames: Partial<Record<ColumnRole, string>> = {};
  for (const role of COLUMN_ROLES) {
    const col = map[role];
    if (col != null) columnNames[role] = headers[col] ?? `Columna ${col + 1}`;
  }

  if (lines.length === 0) {
    warnings.push(
      'No encontré ningún movimiento con fecha y valor. Revisa que sea el extracto de movimientos y no el resumen.',
    );
  }

  return {
    status: 'ready',
    bank: { id: bank.id, label: bank.label, detectedBy: detected.by },
    headerRow,
    headers,
    columns: map,
    columnNames,
    accountHint: accountHintOf(preamble),
    credits,
    debits: debits.length,
    debitsTotal: round2(debits.reduce((s, d) => s + d.amount, 0)),
    debitLines,
    closing: closingOf(lines),
    skipped,
    period: dates.length
      ? { from: dates[0] as string, to: dates[dates.length - 1] as string }
      : null,
    warnings,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** La huella de un abono sin id del banco. Ver la cabecera. */
export function statementFingerprint(
  line: Pick<StatementLine, 'date' | 'amount' | 'description' | 'reference' | 'balance'>,
  ordinal: number,
): string {
  const parts = [
    line.date,
    line.amount.toFixed(2),
    normalizeText(line.description),
    normalizeText(line.reference ?? ''),
    line.balance != null ? line.balance.toFixed(2) : '',
    String(ordinal),
  ];
  return `h:${createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 40)}`;
}

/**
 * El saldo con el que cerró el extracto: el de la fecha más reciente que trae
 * saldo y, entre las de ese día, la última en el orden del archivo (la primera
 * si el archivo va del más nuevo al más viejo).
 */
function closingOf(lines: StatementLine[]): { date: string; balance: number } | null {
  const withBalance = lines.filter((l) => l.balance != null && Number.isFinite(l.balance));
  if (!withBalance.length) return null;
  const first = lines[0];
  const lastLine = lines[lines.length - 1];
  const descending = Boolean(first && lastLine && first.date > lastLine.date);
  const last = withBalance.reduce((best, l) => {
    if (l.date > best.date) return l;
    if (l.date < best.date) return best;
    return descending ? (l.line < best.line ? l : best) : l.line > best.line ? l : best;
  });
  return { date: last.date, balance: last.balance as number };
}

/**
 * Las referencias de un grupo de líneas del MISMO sentido. La huella no lleva
 * el sentido: abonos y salidas se numeran por separado y el libro antepone
 * `d:` a las salidas.
 */
function assignSourceRefs(lines: StatementLine[]): Array<StatementLine & { sourceRef: string }> {
  const seen = new Map<string, number>();
  const seenTx = new Map<string, number>();
  return lines.map((line) => {
    const txid = line.txid ? normalizeHeader(line.txid).replace(/\s+/g, '') : '';
    if (txid && txid !== '0') {
      // Un id que se repite en el mismo día dentro del archivo no es un id: se
      // le suma el orden para no fundir dos abonos en uno.
      const key = `${line.date}:${txid}`;
      const n = (seenTx.get(key) ?? 0) + 1;
      seenTx.set(key, n);
      const ref = n === 1 ? `t:${key}` : `t:${key}#${n}`;
      return { ...line, sourceRef: ref.slice(0, 200) };
    }
    const key = [
      line.date,
      line.amount.toFixed(2),
      normalizeText(line.description),
      normalizeText(line.reference ?? ''),
      line.balance != null ? line.balance.toFixed(2) : '',
    ].join('\u0001');
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    return { ...line, sourceRef: statementFingerprint(line, ordinal) };
  });
}

export type { BankId, BankProfile, ColumnMap, ColumnRole };
