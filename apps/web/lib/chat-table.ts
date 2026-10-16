/**
 * LAS TABLAS QUE ESCRIBE CORTEX EN EL CHAT, LEÍDAS ANTES DE DIBUJARLAS.
 *
 * Una tabla markdown llega como árbol (hast) sin saber qué columna es dinero ni
 * qué fila es el total. Aquí se lee una vez: qué columnas son numéricas (se
 * alinean a la derecha y llevan una barra proporcional), cuál es el máximo de
 * cada una y qué filas son totales (no entran en el máximo y van en negrita).
 * Puro: sin React ni DOM, para poder probarlo.
 */

export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

/** El texto de un nodo hast, recursivo. */
export function hastText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

/**
 * Un número escrito a la colombiana: «$1.147.232», «-$3.500», «12,5 %»,
 * «(1.200)». Devuelve null si la celda no es una cifra.
 */
export function parseCellNumber(raw: string): number | null {
  const t = raw.trim();
  if (!t || t.length > 32) return null;
  if (!/^[-−(]?\s*(?:US)?\$?\s*[-−]?\s*\d[\d.,\s]*\s*%?\)?\s*(?:COP|USD)?$/i.test(t)) return null;
  const negative = /^[-−(]/.test(t) || /\$\s*[-−]/.test(t);
  let digits = t.replace(/[^\d.,]/g, '');
  // «1.147.232» o «1.147.232,50»: el punto agrupa miles y la coma es decimal.
  if (/,\d{1,2}$/.test(digits)) digits = digits.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(digits)) digits = digits.replace(/\./g, '');
  else digits = digits.replace(/,/g, '');
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const TOTAL_ROW = /^\s*(total|subtotal|totales|suma|gran total)\b/i;

export interface TableModel {
  /** Por celda del cuerpo: su columna, su valor y si va con barra. */
  cells: Map<HastNode, { col: number; value: number | null; share: number | null; long: boolean }>;
  /** Columnas numéricas (alinear a la derecha). */
  numericCols: Set<number>;
  /** Filas de total. */
  totalRows: Set<HastNode>;
  /** La columna de cada celda del encabezado. */
  headCells: Map<HastNode, number>;
  /** Encabezados por columna, para exportar. */
  headers: string[];
  /** El cuerpo como texto, para copiar y exportar. */
  rows: string[][];
}

function rowsOf(section: HastNode | undefined): HastNode[] {
  return (section?.children ?? []).filter((n) => n.tagName === 'tr');
}

function cellsOf(row: HastNode): HastNode[] {
  return (row.children ?? []).filter((n) => n.tagName === 'td' || n.tagName === 'th');
}

export function analyzeTable(table: HastNode | undefined): TableModel {
  const model: TableModel = {
    cells: new Map(),
    numericCols: new Set(),
    totalRows: new Set(),
    headCells: new Map(),
    headers: [],
    rows: [],
  };
  if (!table) return model;
  const head = (table.children ?? []).find((n) => n.tagName === 'thead');
  const body = (table.children ?? []).find((n) => n.tagName === 'tbody');
  const headRow = rowsOf(head)[0];
  model.headers = headRow ? cellsOf(headRow).map((c) => hastText(c).trim()) : [];
  if (headRow) cellsOf(headRow).forEach((c, i) => model.headCells.set(c, i));
  const bodyRows = rowsOf(body);

  const values: Array<Array<number | null>> = [];
  for (const row of bodyRows) {
    const cells = cellsOf(row);
    const texts = cells.map((c) => hastText(c).trim());
    model.rows.push(texts);
    if (TOTAL_ROW.test(texts[0] ?? '')) model.totalRows.add(row);
    values.push(texts.map(parseCellNumber));
  }

  // Una columna es numérica si casi todas sus celdas con algo escrito son cifras.
  const cols = Math.max(model.headers.length, ...model.rows.map((r) => r.length), 0);
  const max: number[] = [];
  const min: number[] = [];
  for (let c = 0; c < cols; c++) {
    const filled = model.rows.filter((r) => (r[c] ?? '').trim() && (r[c] ?? '').trim() !== '—');
    const nums = values.filter((v) => v[c] !== null && v[c] !== undefined);
    if (c > 0 && filled.length > 0 && nums.length >= Math.ceil(filled.length * 0.8))
      model.numericCols.add(c);
    max[c] = 0;
    min[c] = Number.POSITIVE_INFINITY;
    bodyRows.forEach((row, i) => {
      if (model.totalRows.has(row)) return;
      const v = values[i]?.[c];
      if (typeof v === 'number') {
        max[c] = Math.max(max[c] ?? 0, Math.abs(v));
        min[c] = Math.min(min[c] ?? Number.POSITIVE_INFINITY, Math.abs(v));
      }
    });
  }

  // La barra sólo dice algo con varias filas para comparar.
  const comparable = bodyRows.filter((r) => !model.totalRows.has(r)).length >= 3;
  bodyRows.forEach((row, i) => {
    cellsOf(row).forEach((cell, c) => {
      const value = values[i]?.[c] ?? null;
      const top = max[c] ?? 0;
      const share =
        comparable &&
        model.numericCols.has(c) &&
        !model.totalRows.has(row) &&
        typeof value === 'number' &&
        top > 0 &&
        // Todas iguales: la barra no compara nada.
        (min[c] ?? 0) < top
          ? Math.abs(value) / top
          : null;
      const long = (model.rows[i]?.[c] ?? '').length > 28;
      model.cells.set(cell, { col: c, value, share, long });
    });
  });
  return model;
}

/** La tabla como CSV (separado por comas, comillas donde hace falta). */
export function tableToCsv(model: Pick<TableModel, 'headers' | 'rows'>): string {
  const esc = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [model.headers, ...model.rows].map((r) => r.map(esc).join(',')).join('\n');
}

/** La tabla con tabuladores: se pega tal cual en Excel o Sheets. */
export function tableToTsv(model: Pick<TableModel, 'headers' | 'rows'>): string {
  return [model.headers, ...model.rows].map((r) => r.join('\t')).join('\n');
}
