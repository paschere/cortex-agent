import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  ConfirmationRequiredError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '@zipdev/core';
import { runTool } from './index';
import type { ToolContext, ToolDef } from './types';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  // Stub Supabase chain: from().insert/upsert/update/select all return resolved promises.
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

  const db = {
    from: vi.fn().mockReturnValue(fromBuilder),
  };

  const integrations = {
    getAccessToken: vi.fn(),
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

const echoTool: ToolDef<{ msg: string }, { echo: string }> = {
  id: 'test.echo',
  description: 'echo',
  inputSchema: z.object({ msg: z.string() }),
  outputSchema: z.object({ echo: z.string() }),
  handler: async (input) => ({ echo: input.msg }),
};

describe('runTool', () => {
  it('happy path: validates, calls handler, validates output', async () => {
    const ctx = makeCtx();
    const result = await runTool(echoTool, { msg: 'hi' }, ctx);
    expect(result).toEqual({ echo: 'hi' });
  });

  it('throws ValidationError when input is invalid', async () => {
    const ctx = makeCtx();
    await expect(runTool(echoTool, { msg: 123 }, ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ConfirmationRequiredError for unconfirmed destructive tool', async () => {
    const destructive: ToolDef<{ msg: string }, { echo: string }> = {
      ...echoTool,
      id: 'test.destructive',
      requiresConfirmation: true,
    };
    const ctx = makeCtx();
    await expect(runTool(destructive, { msg: 'hi' }, ctx)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
  });

  it('proceeds when confirmed: true is passed', async () => {
    const destructive: ToolDef<{ msg: string }, { echo: string }> = {
      ...echoTool,
      id: 'test.destructive2',
      requiresConfirmation: true,
    };
    const ctx = makeCtx();
    const result = await runTool(destructive, { msg: 'hi' }, ctx, { confirmed: true });
    expect(result).toEqual({ echo: 'hi' });
  });

  it('throws ValidationError when handler returns invalid output (no leak)', async () => {
    const bad: ToolDef<{ msg: string }, { echo: string }> = {
      ...echoTool,
      id: 'test.bad',
      handler: async () => ({ echo: 123 } as unknown as { echo: string }),
    };
    const ctx = makeCtx();
    await expect(runTool(bad, { msg: 'hi' }, ctx)).rejects.toThrow(
      /Invalid output from test\.bad/,
    );
    // Confirm the thrown error message does NOT contain the rejected value (123)
    try {
      await runTool(bad, { msg: 'hi' }, ctx);
    } catch (e) {
      expect((e as Error).message).not.toContain('123');
    }
  });

  it('throws ValidationError when required scopes are missing', async () => {
    const scoped: ToolDef<{ msg: string }, { echo: string }> = {
      ...echoTool,
      id: 'test.scoped',
      requiredScopes: [{ provider: 'google', scopes: ['gmail.readonly'] }],
    };
    const ctx = makeCtx();
    (ctx.integrations.hasScopes as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    await expect(runTool(scoped, { msg: 'hi' }, ctx)).rejects.toBeInstanceOf(ValidationError);
  });
});
