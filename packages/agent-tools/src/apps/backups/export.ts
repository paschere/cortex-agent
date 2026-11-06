import type { BackupContent } from './shape';

/**
 * LA COPIA COMO EXCEL: una hoja por tabla (y una por tabla de la base propia),
 * más un «Resumen». Pensado para abrirla y mirar, no para volver a cargarla:
 * para restaurar se usa la pestaña «Copias».
 */

const cell = (v: unknown): string | number | boolean | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 32000 ? `${v.slice(0, 32000)}…` : v;
  return JSON.stringify(v).slice(0, 32000);
};

/** Nombre de hoja válido de Excel (≤ 31, sin \ / ? * [ ] :) y sin repetir. */
export function sheetName(raw: string, used: Set<string>): string {
  const base = raw.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'hoja';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)}_${i}`;
  used.add(name.toLowerCase());
  return name;
}

export async function backupToWorkbook(content: BackupContent): Promise<Buffer> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const used = new Set<string>();
  const summary = wb.addWorksheet(sheetName('Resumen', used));
  summary.addRow(['Aplicación', content.app.name]);
  summary.addRow(['Copia hecha', content.createdAt]);
  summary.addRow(['Tipo', content.kind]);
  if (content.reason) summary.addRow(['Motivo', content.reason]);
  summary.addRow([]);
  summary.addRow(['Tabla', 'Filas', 'Parcial']);
  for (const [slug, t] of Object.entries(content.tables))
    summary.addRow([slug, t.total, t.truncated ? 'sí' : '']);
  for (const [name, t] of Object.entries(content.appDb?.tables ?? {}))
    summary.addRow([`bd: ${name}`, t.total, t.truncated ? 'sí' : '']);
  for (const w of content.warnings) summary.addRow(['Aviso', w]);

  for (const [slug, t] of Object.entries(content.tables)) {
    const ws = wb.addWorksheet(sheetName(slug, used));
    const fields = Array.isArray(t.tracker.fields)
      ? (t.tracker.fields as Array<{ key: string; label?: string }>)
      : [];
    const keys = new Set(fields.map((f) => f.key));
    for (const r of t.rows) for (const k of Object.keys(r.values)) keys.add(k);
    const label = new Map(fields.map((f) => [f.key, f.label ?? f.key]));
    ws.addRow([
      'id',
      'nombre',
      'creada',
      'actualizada',
      ...[...keys].map((k) => label.get(k) ?? k),
    ]);
    for (const r of t.rows)
      ws.addRow([
        r.id,
        r.label,
        r.created_at,
        r.updated_at,
        ...[...keys].map((k) => cell(r.values[k])),
      ]);
    ws.getRow(1).font = { bold: true };
  }
  for (const [name, t] of Object.entries(content.appDb?.tables ?? {})) {
    const ws = wb.addWorksheet(sheetName(`bd_${name}`, used));
    const cols = [...new Set(t.rows.flatMap((r) => Object.keys(r)))];
    ws.addRow(cols);
    for (const r of t.rows) ws.addRow(cols.map((c) => cell(r[c])));
    ws.getRow(1).font = { bold: true };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
