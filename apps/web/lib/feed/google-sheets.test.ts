import type { ToolContext } from '@cortex/agent-tools/src/types';
import { describe, expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('@cortex/agent-tools/src/gsheets/client', () => ({ sheetsFetch: read }));
import { googleSpreadsheetId, readGoogleSheetFeed } from './google-sheets';

describe('authorized Sheets snapshots', () => {
  it('recognizes only canonical Google hosts', () => {
    expect(
      googleSpreadsheetId(new URL('https://docs.google.com/spreadsheets/d/abc-123/edit#gid=1')),
    ).toBe('abc-123');
    expect(
      googleSpreadsheetId(new URL('https://docs.google.com.evil.test/spreadsheets/d/abc')),
    ).toBeNull();
  });
  it('reads each tab with the supplied tenant/user context and preserves numeric cells', async () => {
    read.mockReset();
    read
      .mockResolvedValueOnce({
        properties: { title: 'Empresa' },
        sheets: [
          { properties: { title: "O'Brien", gridProperties: { rowCount: 1200, columnCount: 26 } } },
        ],
      })
      .mockResolvedValueOnce({
        values: [
          ['Factura', 'Monto'],
          ['001', 20],
        ],
      });
    const ctx = { userId: 'owner' } as ToolContext;
    const result = await readGoogleSheetFeed(ctx, 'abc');
    expect(read.mock.calls.every((call) => call[0] === ctx)).toBe(true);
    expect(read.mock.calls[1]?.[1]).toContain(encodeURIComponent("'O''Brien'!A1:AZ1000"));
    expect(result.tables[0]?.rows[1]).toEqual(['001', 20]);
    expect(result.truncated).toBe(true);
  });
});
