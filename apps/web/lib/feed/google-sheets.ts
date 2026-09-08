import { sheetsFetch } from '@cortex/agent-tools/src/gsheets/client';
import type { SheetData } from '@cortex/agent-tools/src/kb/spreadsheets';
import type { ToolContext } from '@cortex/agent-tools/src/types';

export function googleSpreadsheetId(url: URL): string | null {
  if (url.hostname !== 'docs.google.com') return null;
  return /^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
}

/** Bounded snapshot through the current user's workspace Google connection. */
export async function readGoogleSheetFeed(ctx: ToolContext, id: string) {
  const meta = await sheetsFetch<{
    properties: { title: string };
    sheets: Array<{
      properties: { title: string; gridProperties?: { rowCount: number; columnCount: number } };
    }>;
  }>(ctx, `/${id}?fields=properties(title),sheets(properties(title,gridProperties))`);
  if (!meta.sheets?.length || meta.sheets.length > 20)
    throw new Error('Usa un spreadsheet de 1 a 20 pestañas.');
  const tables: SheetData[] = [];
  let cells = 0;
  let truncated = false;
  for (const sheet of meta.sheets) {
    const { title, gridProperties: grid } = sheet.properties;
    const range = `'${title.replace(/'/g, "''")}'!A1:AZ1000`;
    const result = await sheetsFetch<{ values?: Array<Array<string | number | boolean | null>> }>(
      ctx,
      `/${id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    );
    const rows = result.values ?? [];
    cells += rows.reduce((n, row) => n + row.length, 0);
    if (cells > 50_000) throw new Error('La captura supera 50.000 celdas. Divide el spreadsheet.');
    truncated ||= !grid || grid.rowCount > 1000 || grid.columnCount > 52;
    tables.push({ name: title, rows });
  }
  const text = tables
    .map(
      (sheet) =>
        `## ${sheet.name}\n${sheet.rows.map((row) => row.map((v) => v ?? '').join('\t')).join('\n')}`,
    )
    .join('\n\n');
  return { name: meta.properties.title, text, tables, truncated };
}
