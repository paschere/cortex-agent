import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { sheetsReadRange } from '../read-range';
import { sheetsAppendRow } from '../append-row';
import { runTool } from '../../index';
import { ConfirmationRequiredError } from '@cortex/core';
import type { ToolContext } from '../../types';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const noRow = { data: null, error: null };
  const fromBuilder = {
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(noRow),
        }),
        maybeSingle: vi.fn().mockResolvedValue(noRow),
      }),
    }),
  };
  const db = { from: vi.fn().mockReturnValue(fromBuilder) };
  const integrations = {
    getAccessToken: vi.fn().mockResolvedValue({ token: 'test-token', scopes: [] }),
    hasScopes: vi.fn().mockResolvedValue(true),
  };
  const logger = {
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(),
  };
  return {
    organizationId: 'org-test',
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    conversationId: '00000000-0000-0000-0000-000000000003',
    db: db as unknown as ToolContext['db'],
    integrations: integrations as unknown as ToolContext['integrations'],
    logger: logger as unknown as ToolContext['logger'],
    ...overrides,
  };
}

const SPREADSHEET_ID = 'sheet-abc123';

const server = setupServer(
  http.get(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/:range`, () =>
    HttpResponse.json({ range: 'Sheet1!A1:B2', values: [['a', 'b'], ['c', 'd']] }),
  ),
  http.post(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/:range`,
    () => HttpResponse.json({ updates: { updatedRange: 'Sheet1!A3:B3', updatedRows: 1 } }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

describe('gsheets', () => {
  it('reads a range', async () => {
    const ctx = makeCtx();
    const out = await sheetsReadRange.handler({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A1:B2' }, ctx);
    expect(out.values).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('append_row requires confirmation', async () => {
    const ctx = makeCtx();
    await expect(
      runTool(sheetsAppendRow, { spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A1', values: ['x', 'y'] }, ctx),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it('append_row runs with confirmed: true', async () => {
    const ctx = makeCtx();
    const out = await runTool(
      sheetsAppendRow,
      { spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A1', values: ['x', 'y'] },
      ctx,
      { confirmed: true },
    );
    expect((out as { updatedRange: string }).updatedRange).toBe('Sheet1!A3:B3');
  });
});
