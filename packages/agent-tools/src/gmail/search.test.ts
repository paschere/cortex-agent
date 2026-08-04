import { ValidationError } from '@cortex/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTool } from '../index';
import type { ToolContext } from '../types';
import { gmailSearch } from './search';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const insertResult = { data: null, error: null };
  const upsertResult = { data: null, error: null };
  const noRow = { data: null, error: null };

  const fromBuilder = {
    insert: vi.fn().mockResolvedValue(insertResult),
    upsert: vi.fn().mockResolvedValue(upsertResult),
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
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };

  return {
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    conversationId: '00000000-0000-0000-0000-000000000003',
    db: db as unknown as ToolContext['db'],
    integrations: integrations as unknown as ToolContext['integrations'],
    logger: logger as unknown as ToolContext['logger'],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const thread1Meta = {
  id: 't1',
  snippet: 'First thread snippet',
  messages: [
    {
      payload: {
        headers: [
          { name: 'Subject', value: 'Subject One' },
          { name: 'From', value: 'sender1@example.com' },
          { name: 'Date', value: 'Mon, 1 Jan 2026 10:00:00 +0000' },
        ],
      },
    },
  ],
};

const thread2Meta = {
  id: 't2',
  snippet: 'Second thread snippet',
  messages: [
    {
      payload: {
        headers: [
          { name: 'Subject', value: 'Subject Two' },
          { name: 'From', value: 'sender2@example.com' },
          { name: 'Date', value: 'Tue, 2 Jan 2026 10:00:00 +0000' },
        ],
      },
    },
  ],
};

describe('gmail.search', () => {
  it('happy path with 2 threads: returns subject, from, snippet, date', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (callCount === 1) {
          // First call: list threads
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              threads: [
                { id: 't1', snippet: 'First thread snippet' },
                { id: 't2', snippet: 'Second thread snippet' },
              ],
            }),
          });
        }
        // Subsequent calls: fetch individual thread metadata
        if ((url as string).includes('/threads/t1')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => thread1Meta });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => thread2Meta });
      }),
    );

    const ctx = makeCtx();
    const result = await runTool(gmailSearch, { query: 'from:foo', maxResults: 5 }, ctx);

    expect(result.threads).toHaveLength(2);

    const first = result.threads[0];
    expect(first?.id).toBe('t1');
    expect(first?.subject).toBe('Subject One');
    expect(first?.from).toBe('sender1@example.com');
    expect(first?.snippet).toBe('First thread snippet');
    expect(first?.date).toBe('Mon, 1 Jan 2026 10:00:00 +0000');

    const second = result.threads[1];
    expect(second?.id).toBe('t2');
    expect(second?.subject).toBe('Subject Two');
    expect(second?.from).toBe('sender2@example.com');
  });

  it('empty query → ValidationError', async () => {
    const ctx = makeCtx();
    await expect(runTool(gmailSearch, { query: '', maxResults: 10 }, ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('no threads returned → empty array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ threads: [] }),
      }),
    );

    const ctx = makeCtx();
    const result = await runTool(gmailSearch, { query: 'label:nothing', maxResults: 5 }, ctx);
    expect(result.threads).toHaveLength(0);
  });

  it('uses default maxResults of 10 when not specified', () => {
    expect(gmailSearch.inputSchema.parse({ query: 'test' })).toMatchObject({
      query: 'test',
      maxResults: 10,
    });
  });
});
