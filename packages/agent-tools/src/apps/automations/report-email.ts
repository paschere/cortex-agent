import { type ReportTable, formatCell } from './report';

/**
 * EL CUERPO DE UN REPORTE POR CORREO: la tabla en HTML con estilos en línea
 * (los clientes de correo no leen hojas de estilo) y su versión en texto.
 * Puro. Todo lo que viene de datos se escapa.
 */

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ReportEmailInput {
  title: string;
  /** «La semana pasada (12 al 18 oct 2026)». */
  rangeLabel?: string | null;
  intro?: string | null;
  tables: ReportTable[];
  appName: string;
  notes?: string[];
  /** Nombres de los adjuntos, para decir qué viene adjunto. */
  attachments?: string[];
  rowCount?: number;
}

const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const BRAND = '#4338ca';

/** Tope de filas por tabla dentro del correo (el resto va en los adjuntos). */
export const EMAIL_MAX_ROWS = 40;

function tableHtml(t: ReportTable): string {
  const align = (k: string) => (k === 'text' ? 'left' : 'right');
  const head = t.columns
    .map(
      (c) =>
        `<th style="text-align:${align(c.kind)};padding:8px 10px;font-size:12px;color:${MUTED};font-weight:600;border-bottom:2px solid ${LINE};white-space:nowrap">${escapeHtml(c.label)}</th>`,
    )
    .join('');
  const shown = t.rows.slice(0, EMAIL_MAX_ROWS);
  const body = shown
    .map(
      (r, i) =>
        `<tr style="background:${i % 2 ? '#f9fafb' : '#ffffff'}">${r
          .map(
            (cell, j) =>
              `<td style="text-align:${align(t.columns[j]?.kind ?? 'text')};padding:7px 10px;font-size:13px;color:${INK};border-bottom:1px solid ${LINE};${t.columns[j]?.kind !== 'text' ? 'font-variant-numeric:tabular-nums;white-space:nowrap' : ''}">${escapeHtml(formatCell(cell, t.columns[j]?.kind ?? 'text'))}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  const total = t.totals
    ? `<tr>${t.totals
        .map(
          (cell, j) =>
            `<td style="text-align:${align(t.columns[j]?.kind ?? 'text')};padding:9px 10px;font-size:13px;font-weight:700;color:${INK};border-top:2px solid ${INK};white-space:nowrap">${escapeHtml(formatCell(cell, t.columns[j]?.kind ?? 'text'))}</td>`,
        )
        .join('')}</tr>`
    : '';
  const more =
    t.rows.length > EMAIL_MAX_ROWS
      ? `<p style="margin:6px 0 0;font-size:12px;color:${MUTED}">Se muestran ${EMAIL_MAX_ROWS} de ${t.rows.length} filas; el resto va en el adjunto.</p>`
      : '';
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:8px 0 4px"><thead><tr>${head}</tr></thead><tbody>${body}${total}</tbody></table>${more}`;
}

export function renderReportEmail(input: ReportEmailInput): { html: string; text: string } {
  const visible = input.tables.filter((t) => !t.attachmentOnly);
  const empty = visible.every((t) => !t.rows.length || input.rowCount === 0);
  const sections = visible
    .map(
      (t, i) =>
        `${visible.length > 1 || i > 0 ? `<h3 style="margin:22px 0 4px;font-size:14px;color:${INK}">${escapeHtml(t.title)}</h3>` : ''}${tableHtml(t)}`,
    )
    .join('');
  const notes = (input.notes ?? [])
    .map((n) => `<p style="margin:8px 0 0;font-size:12px;color:#92400e">${escapeHtml(n)}</p>`)
    .join('');
  const attach = input.attachments?.length
    ? `<p style="margin:16px 0 0;font-size:13px;color:${INK}">Adjunto: ${input.attachments.map((a) => `<strong>${escapeHtml(a)}</strong>`).join(' y ')}.</p>`
    : '';
  const html = `<!doctype html><html lang="es"><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${LINE}">
<div style="height:6px;background:${BRAND}"></div>
<div style="padding:24px 28px">
<p style="margin:0;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${MUTED}">Reporte automático · ${escapeHtml(input.appName)}</p>
<h1 style="margin:6px 0 0;font-size:22px;color:${INK}">${escapeHtml(input.title)}</h1>
${input.rangeLabel ? `<p style="margin:4px 0 0;font-size:14px;color:${MUTED}">${escapeHtml(input.rangeLabel)}</p>` : ''}
${input.intro ? `<p style="margin:14px 0 0;font-size:14px;line-height:1.5;color:${INK}">${escapeHtml(input.intro)}</p>` : ''}
${empty ? `<p style="margin:18px 0 0;font-size:14px;color:${INK}">No hubo movimiento en este período.</p>` : sections}
${notes}${attach}
</div>
<div style="padding:14px 28px;background:#f9fafb;border-top:1px solid ${LINE};font-size:12px;color:${MUTED}">Lo envía Cortex a partir de una regla de «${escapeHtml(input.appName)}». Para cambiar quién lo recibe o cuándo sale, edita la automatización.</div>
</div></body></html>`;

  const lines: string[] = [input.title];
  if (input.rangeLabel) lines.push(input.rangeLabel);
  if (input.intro) lines.push('', input.intro);
  if (empty) lines.push('', 'No hubo movimiento en este período.');
  else
    for (const t of visible) {
      lines.push('', t.title);
      lines.push(t.columns.map((c) => c.label).join(' | '));
      for (const r of t.rows.slice(0, EMAIL_MAX_ROWS))
        lines.push(r.map((c, j) => formatCell(c, t.columns[j]?.kind ?? 'text')).join(' | '));
      if (t.totals) lines.push(t.totals.map((c, j) => formatCell(c, t.columns[j]?.kind ?? 'text')).join(' | '));
    }
  for (const n of input.notes ?? []) lines.push('', n);
  if (input.attachments?.length) lines.push('', `Adjunto: ${input.attachments.join(' y ')}.`);
  lines.push('', `—\nReporte automático de «${input.appName}».`);
  return { html, text: lines.join('\n') };
}
