import type { ComputedBlock, ComputedView } from './compute';

/**
 * EXPORTAR UNA VISTA A EXCEL.
 *
 * Parte SIEMPRE de lo ya calculado (`ComputedView`), nunca de las tablas: lo
 * que sale en el archivo es exactamente lo que esa persona ve en pantalla —
 * mismos filtros de la barra, mismas fuentes permitidas (una vista compartida
 * por enlace nunca lee las internas: sus bloques llegan como `problem` y aquí
 * no generan hoja). No hay un segundo camino de lectura que pueda abrir lo que
 * el primero cierra.
 *
 * Una hoja por tabla, tablero o plano, una «Cifras» con las métricas y una por
 * gráfico de barras/línea/dona/embudo. Las celdas numéricas salen como número
 * para que Excel pueda sumarlas.
 */

export interface ExportSheet {
  name: string;
  header: string[];
  rows: Array<Array<string | number | null>>;
}

/** Excel: máx. 31 caracteres, sin []:*?/\ , y sin repetir. */
function sheetName(raw: string, used: Set<string>): string {
  const base =
    raw
      .replace(/[[\]:*?/\\]/g, ' ')
      .trim()
      .slice(0, 31) || 'Hoja';
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

type Board = Extract<ComputedBlock, { type: 'board' | 'zones' }>;

function boardSheet(block: Board): Omit<ExportSheet, 'name'> {
  const labels: string[] = [];
  for (const col of block.columns)
    for (const card of col.cards)
      for (const d of card.details) if (!labels.includes(d.label)) labels.push(d.label);
  const rows: ExportSheet['rows'] = [];
  for (const col of block.columns)
    for (const card of col.cards)
      rows.push([
        col.label,
        card.label,
        ...labels.map((l) => card.details.find((d) => d.label === l)?.value ?? null),
      ]);
  return { header: ['Columna', 'Nombre', ...labels], rows };
}

const GOAL_TEXT = { good: 'En meta', warn: 'Cerca', bad: 'Lejos' } as const;

/** Las hojas de una vista calculada. Vacío si no hay nada exportable. */
export function viewExportSheets(view: ComputedView): ExportSheet[] {
  const used = new Set<string>();
  const sheets: ExportSheet[] = [];
  const metrics: ExportSheet['rows'] = [];
  for (const block of view.blocks) {
    switch (block.type) {
      case 'metric':
        metrics.push([
          block.title,
          block.value,
          block.display,
          block.goal?.display ?? null,
          block.goal?.status ? GOAL_TEXT[block.goal.status] : null,
          block.source,
        ]);
        break;
      case 'table':
        sheets.push({
          name: block.title,
          header: block.columns.map((c) => c.label),
          rows: block.rows.map((r) =>
            r.cells.map((cell, i) => {
              const raw = r.sort[i];
              if (block.columns[i]?.kind === 'number' && typeof raw === 'number') return raw;
              return cell === '—' ? null : cell;
            }),
          ),
        });
        break;
      case 'board':
      case 'zones':
        sheets.push({ name: block.title, ...boardSheet(block) });
        break;
      case 'chart':
        if (block.chart === 'heatmap' || block.points.length === 0) break;
        sheets.push({
          name: block.title,
          header: [block.chart === 'funnel' ? 'Etapa' : 'Grupo', 'Valor', 'Valor (texto)'],
          rows: block.points.map((p) => [p.label, p.value, p.display]),
        });
        break;
      default:
        break;
    }
  }
  const out: ExportSheet[] = [];
  if (metrics.length)
    out.push({
      name: 'Cifras',
      header: ['Cifra', 'Valor', 'Valor (texto)', 'Meta', 'Estado de la meta', 'Fuente'],
      rows: metrics,
    });
  out.push(...sheets);
  return out.map((s) => ({ ...s, name: sheetName(s.name, used) }));
}

/** Nombre de archivo seguro: «Ventas del mes» → ventas-del-mes-2026-10-05.xlsx */
export function viewExportFilename(title: string, day: string, ext: string): string {
  const slug =
    title
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'vista';
  return `${slug}-${day}.${ext}`;
}

/** El .xlsx en bytes. Null si la vista no tiene nada que exportar. */
export async function buildViewWorkbook(
  view: ComputedView,
  title: string,
): Promise<Uint8Array | null> {
  const sheets = viewExportSheets(view);
  if (!sheets.length) return null;
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Cortex';
  workbook.title = title.slice(0, 120);
  workbook.created = new Date(view.computedAt);
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(sheet.header).font = { bold: true };
    for (const row of sheet.rows) ws.addRow(row);
    sheet.header.forEach((h, i) => {
      const widest = Math.max(h.length, ...sheet.rows.map((r) => String(r[i] ?? '').length));
      ws.getColumn(i + 1).width = Math.min(Math.max(widest + 2, 10), 48);
    });
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
