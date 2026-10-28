import { z } from 'zod';
import { registerTool } from '../index';
import { loadDriveWorkbook, sliceA1 } from '../table-sync/drive-excel';
import { sheetsFetch } from './client';
import { isExcelRejection } from './errors';

export const sheetsReadRange = registerTool({
  id: 'gsheets.read_range',
  description: 'Read a range from a Google Sheet (A1 notation, e.g., "Sheet1!A1:D100").',
  inputSchema: z.object({
    spreadsheetId: z.string(),
    range: z.string(),
  }),
  outputSchema: z.object({
    values: z.array(z.array(z.string())),
  }),
  requiredScopes: [
    { provider: 'google', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] },
  ],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type R = { range: string; values?: string[][] };
    try {
      const r = await sheetsFetch<R>(
        ctx,
        `/${input.spreadsheetId}/values/${encodeURIComponent(input.range)}`,
      );
      return { values: r.values ?? [] };
    } catch (err) {
      // Un Excel de Drive abierto como hoja: la API de Sheets lo rechaza, se lee por Drive.
      if (!isExcelRejection(err)) throw err;
      const { sheets } = await loadDriveWorkbook(ctx, input.spreadsheetId);
      return { values: sliceA1(sheets, input.range) };
    }
  },
});
