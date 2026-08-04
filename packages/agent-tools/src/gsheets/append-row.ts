import { z } from 'zod';
import { registerTool } from '../index';
import { sheetsFetch } from './client';

export const sheetsAppendRow = registerTool({
  id: 'gsheets.append_row',
  description: 'Append a row to a Google Sheet range. Requires user confirmation.',
  inputSchema: z.object({
    spreadsheetId: z.string(),
    range: z.string(),
    values: z.array(z.string()),
  }),
  outputSchema: z.object({
    updatedRange: z.string(),
  }),
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/spreadsheets'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type R = { updates: { updatedRange: string; updatedRows: number } };
    const r = await sheetsFetch<R>(
      ctx,
      `/${input.spreadsheetId}/values/${encodeURIComponent(input.range)}:append?valueInputOption=USER_ENTERED`,
      {
        method: 'POST',
        body: JSON.stringify({ values: [input.values] }),
      },
    );
    return { updatedRange: r.updates.updatedRange };
  },
});
