import type { ComputedBlock } from './compute';
import { roundForFormat, sheetAggregate } from './sheet-math';

type Sheet = Extract<ComputedBlock, { type: 'sheet' }>;
type Cell = string | number | null;

export interface SheetMatrix {
  header: string[];
  rows: Cell[][];
  /** Índices de `rows` que son subtotales o el total (para ponerlos en negrita). */
  summary: number[];
}

/**
 * La hoja como matriz plana para Excel o CSV, RESPETANDO EL AGRUPADO: cada fila
 * lleva al frente el grupo y los campos del padre (así el archivo se puede
 * filtrar y hacer tabla dinámica), después de cada grupo va su subtotal y al
 * final el total. Las celdas numéricas salen como número. `rowIds` limita a las
 * filas que el filtro de pantalla deja ver.
 */
export function sheetMatrix(block: Sheet, rowIds?: ReadonlySet<string>): SheetMatrix {
  const rows = block.rows.filter((r) => !rowIds || rowIds.has(r.id));
  const grouped = Boolean(block.groups);
  const parentLabels = grouped
    ? [...new Set((block.groups ?? []).flatMap((g) => g.fields.map((f) => f.label)))]
    : [];
  const lead = grouped ? 1 + parentLabels.length : 0;
  const header = [
    ...(grouped ? ['Grupo', ...parentLabels] : []),
    ...block.columns.map((c) => c.label),
  ];
  const value = (r: Sheet['rows'][number], i: number): Cell => {
    const raw = r.sort[i];
    const col = block.columns[i];
    if (col?.kind === 'number' && raw !== null && raw !== undefined && Number.isFinite(Number(raw)))
      return Number(raw);
    const cell = r.cells[i];
    return cell === '—' || cell === undefined ? null : cell;
  };
  const out: Cell[][] = [];
  const summary: number[] = [];
  const blank = (n: number): Cell[] => Array.from({ length: n }, () => null);
  const sums = (list: Sheet['rows'], cols: number[], label: string): Cell[] => {
    const line = [...blank(lead), ...blank(block.columns.length)];
    if (lead) line[0] = label;
    else line[0] = label;
    for (const i of cols) {
      const col = block.columns[i];
      if (!col) continue;
      const total = block.totals.find((t) => t.col === i);
      const v = sheetAggregate(
        list.map((r) => r.sort[i]),
        total?.op ?? 'sum',
      );
      if (v !== null) line[lead + i] = roundForFormat(v, col.fmt);
    }
    return line;
  };
  if (block.groups) {
    block.groups.forEach((g, gi) => {
      const members = rows.filter((r) => r.group === gi);
      if (!members.length) return;
      const parentCells = parentLabels.map(
        (l) => g.fields.find((f) => f.label === l)?.value ?? null,
      );
      for (const r of members)
        out.push([
          g.label,
          ...parentCells,
          ...block.columns.map((_, i) => value(r, i)),
        ]);
      if (g.subtotals.length) {
        summary.push(out.length);
        out.push(sums(members, g.subtotals, `Subtotal ${g.label}`).map((c, i) => (i < lead && i > 0 ? null : c)));
      }
    });
  } else for (const r of rows) out.push(block.columns.map((_, i) => value(r, i)));
  if (block.totals.length) {
    summary.push(out.length);
    out.push(
      sums(
        rows,
        block.totals.map((t) => t.col),
        'Total',
      ),
    );
  }
  return { header, rows: out, summary };
}

/** CSV con «;» y BOM, como el resto de la plataforma (Excel en español lo abre bien). */
export function sheetCsv(matrix: SheetMatrix): string {
  const esc = (c: Cell) => {
    const s = c === null ? '' : String(c);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[matrix.header, ...matrix.rows].map((r) => r.map(esc).join(';')).join('\r\n')}`;
}
