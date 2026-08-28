import { z } from 'zod';
import { registerTool } from '../index';
import { sheetsFetch } from './client';

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
    const r = await sheetsFetch<R>(
      ctx,
      `/${input.spreadsheetId}/values/${encodeURIComponent(input.range)}`,
    );
    return { values: r.values ?? [] };
  },
});
