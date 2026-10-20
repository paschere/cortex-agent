import { ForbiddenError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager } from '../../directory/store';
import { registerTool } from '../../index';
import { mustGetApp } from '../store';
import { type ReportTable, formatCell } from './report';
import { buildReport } from './report-run';
import { reportSourceSchema } from './report-spec';

/**
 * `apps.report.preview`: lo que diría un reporte HOY, sin mandar nada. Sirve
 * para afinar la consulta (qué se agrupa, qué rango) antes de ponerla a salir
 * sola con la acción `report` de una automatización.
 */

async function requireAppAdmin(ctx: { db: SupabaseClient; userId: string }): Promise<void> {
  if (!(await isCompanyManager(ctx.db, ctx.userId)))
    throw new ForbiddenError(
      'Sólo quien administra la empresa o es su dueño puede armar reportes de una app.',
    );
}

function markdownTable(t: ReportTable, max = 25): string {
  const head = `| ${t.columns.map((c) => c.label).join(' | ')} |`;
  const sep = `| ${t.columns.map((c) => (c.kind === 'text' ? '---' : '---:')).join(' | ')} |`;
  const row = (cells: ReportTable['rows'][number], bold = false) =>
    `| ${cells.map((c, i) => (bold ? `**${formatCell(c, t.columns[i]?.kind ?? 'text')}**` : formatCell(c, t.columns[i]?.kind ?? 'text'))).join(' | ')} |`;
  const lines = [head, sep, ...t.rows.slice(0, max).map((r) => row(r))];
  if (t.rows.length > max) lines.push(`| … ${t.rows.length - max} filas más |`);
  if (t.totals) lines.push(row(t.totals, true));
  return lines.join('\n');
}

export const appsReportPreview = registerTool({
  id: 'apps.report.preview',
  description:
    'Preview a report exactly as the automation action `report` would build it TODAY (a query over one table grouped by a field with sum/count/avg/min/max and a relative date range in Bogota time, or a screen of the app), WITHOUT emailing anything. Returns the table with full pesos. Use it to tune the query before creating the automation with apps.automations.create (action type "report"). Read-only; company owners/admins only.',
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80).describe('App id or slug.'),
    source: reportSourceSchema,
  }),
  outputSchema: z.object({
    rowCount: z.number(),
    range: z.string().nullable(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    let built: Awaited<ReturnType<typeof buildReport>>;
    try {
      built = await buildReport(ctx.db, app.id, reportSourceSchema.parse(input.source), 'Vista previa', new Date());
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : 'No se pudo armar el reporte.');
    }
    const { result } = built;
    const body = result.tables.map((t) => `**${t.title}**${t.attachmentOnly ? ' (sólo en los adjuntos)' : ''}\n${markdownTable(t)}`).join('\n\n');
    return {
      rowCount: result.rowCount,
      range: built.rangeLabel,
      markdown: `Vista previa del reporte${built.rangeLabel ? ` · ${built.rangeLabel}` : ''} · ${result.rowCount} fila${result.rowCount === 1 ? '' : 's'} (no se mandó nada).\n\n${body}${result.notes.length ? `\n\n${result.notes.map((n) => `- ${n}`).join('\n')}` : ''}`,
    };
  },
});
