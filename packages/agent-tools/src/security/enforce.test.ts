import { ConfirmationRequiredError, SecurityBlockedError } from '@cortex/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runTool } from '../registry';
import type { ToolContext, ToolDef } from '../types';
import { resetFrequencyCache } from './frequency';
import { resetPolicyCache } from './store';

/**
 * These prove the point of the whole layer: enforcement happens inside
 * runTool, so it applies whether or not the model asks for it. No DB — every
 * lookup fails open against a stub client.
 */

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const inserts: { table: string; row: unknown }[] = [];
  const fromBuilder = (table: string) => ({
    insert: vi.fn((row: unknown) => {
      inserts.push({ table, row });
      return Promise.resolve({ data: null, error: null });
    }),
    // security_policies read: returns nothing -> loadPolicy falls back to defaults
    select: vi.fn().mockResolvedValue({ data: null, error: null }),
  });

  const db = {
    from: vi.fn((table: string) => fromBuilder(table)),
    __inserts: inserts,
  };

  return {
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    conversationId: '00000000-0000-0000-0000-000000000003',
    db: db as unknown as ToolContext['db'],
    integrations: {
      getAccessToken: vi.fn(),
      hasScopes: vi.fn().mockResolvedValue(true),
    } as unknown as ToolContext['integrations'],
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as ToolContext['logger'],
    ...overrides,
  };
}

type Row = Record<string, unknown>;

function insertsInto(ctx: ToolContext, table: string): Row[] {
  const all = (ctx.db as unknown as { __inserts: { table: string; row: Row }[] }).__inserts;
  return all.filter((i) => i.table === table).map((i) => i.row);
}

/** Last row written to `table` — the outcome row for a completed call. */
function lastInsert(ctx: ToolContext, table: string): Row {
  const rows = insertsInto(ctx, table);
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1] as Row;
}

/** First row written to `table` — the row for the attempt itself. */
function firstInsert(ctx: ToolContext, table: string): Row {
  const rows = insertsInto(ctx, table);
  expect(rows.length).toBeGreaterThan(0);
  return rows[0] as Row;
}

type TestInput = Record<string, unknown>;
type TestOutput = { ok: boolean };

const handler = vi.fn(async () => ({ ok: true }));

function tool(
  id: string,
  extra: Partial<ToolDef<TestInput, TestOutput>> = {},
): ToolDef<TestInput, TestOutput> {
  return {
    id,
    description: id,
    inputSchema: z.record(z.unknown()),
    outputSchema: z.object({ ok: z.boolean() }),
    handler,
    ...extra,
  };
}

// The workspace's own domains decide what counts as leaving the company, so
// these cases only mean anything against a configured deployment. The
// unconfigured posture (nobody internal) is covered in policy.test.ts.
const INTERNAL = 'acme.test';

beforeEach(() => {
  process.env.INTERNAL_EMAIL_DOMAINS = INTERNAL;
  resetPolicyCache();
  resetFrequencyCache();
  handler.mockClear();
});

afterEach(() => {
  process.env.INTERNAL_EMAIL_DOMAINS = '';
});

describe('runTool security gate', () => {
  it('blocks compensation leaving the company and never calls the handler', async () => {
    const ctx = makeCtx();
    await expect(
      runTool(
        tool('gmail.send_draft'),
        { to: 'cfo@acme-client.com', body: 'salary breakdown attached' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(SecurityBlockedError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('the block message is plain language with no policy internals', async () => {
    const ctx = makeCtx();
    try {
      await runTool(
        tool('gmail.send_draft'),
        { to: 'cfo@acme-client.com', body: 'salary breakdown' },
        ctx,
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as SecurityBlockedError;
      expect(err.code).toBe('SECURITY_BLOCKED');
      expect(err.message).toMatch(/outside the company/i);
      expect(err.message).toMatch(/org admin/i);
      // no thresholds, policy keys, signal names or stack traces
      expect(err.message).not.toMatch(/block_critical|sensitive_reads|external_send|at Object/);
    }
  });

  it('records a security_events row and an audit row when it blocks', async () => {
    const ctx = makeCtx();
    await expect(
      runTool(tool('gmail.send_draft'), { to: 'x@acme.com', body: 'hourly rate list' }, ctx),
    ).rejects.toBeInstanceOf(SecurityBlockedError);

    const sec = firstInsert(ctx, 'security_events');
    expect(sec.decision).toBe('blocked');
    expect(sec.risk_level).toBe('critical');
    expect(sec.signals).toContain('external-recipient');
    expect(sec.input_digest).toBeTruthy();

    const audit = firstInsert(ctx, 'audit_events');
    expect(audit.status).toBe('error');
    expect(audit.decision).toBe('blocked');
    expect(audit.risk_level).toBe('critical');
    expect(audit.risk_reason).toBeTruthy();
    expect(audit.surface).toBe('web');
  });

  it('gates a high-risk call even though the tool never declared requiresConfirmation', async () => {
    const bulk = tool('payroll.expenses_report');
    expect(bulk.requiresConfirmation).toBeUndefined();

    const ctx = makeCtx();
    await expect(runTool(bulk, { limit: 5000 }, ctx)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(insertsInto(ctx, 'security_events')[0]?.decision).toBe('confirm_required');
  });

  it('runs the gated call once confirmed and records decision "confirmed"', async () => {
    const ctx = makeCtx();
    const result = await runTool(tool('payroll.expenses_report'), { limit: 5000 }, ctx, {
      confirmed: true,
    });
    expect(result).toMatchObject({ ok: true });
    expect(insertsInto(ctx, 'security_events')[0]?.decision).toBe('confirmed');
    const audit = lastInsert(ctx, 'audit_events');
    expect(audit.status).toBe('ok');
    expect(audit.decision).toBe('confirmed');
  });

  it('allows a medium-risk call but flags it', async () => {
    const ctx = makeCtx();
    await runTool(tool('payroll.team_overview'), {}, ctx);
    expect(handler).toHaveBeenCalled();
    expect(insertsInto(ctx, 'security_events')[0]?.decision).toBe('flagged');
    expect(lastInsert(ctx, 'audit_events').decision).toBe('flagged');
  });

  it('a high-risk non-bulk call runs, is flagged, and tells the model why', async () => {
    // Compensation to an INTERNAL recipient is high-risk but allowed. With no
    // INTERNAL_EMAIL_DOMAINS configured every address counts as external and the
    // same call is blocked instead — which is the safe default, not this case.
    const previous = process.env.INTERNAL_EMAIL_DOMAINS;
    process.env.INTERNAL_EMAIL_DOMAINS = 'acme.test';
    const ctx = makeCtx();
    const result = await runTool(
      tool('gmail.send_draft'),
      { to: 'ceo@acme.test', body: 'the salary breakdown you asked for' },
      ctx,
    );
    if (previous === undefined) delete process.env.INTERNAL_EMAIL_DOMAINS;
    else process.env.INTERNAL_EMAIL_DOMAINS = previous;
    // Flag-first: no confirmation prompt, no block — it just runs.
    expect(handler).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true });

    const notice = (result as unknown as { _security?: Record<string, unknown> })._security;
    expect(notice).toBeDefined();
    expect(notice?.riskLevel).toBe('high');
    expect(String(notice?.notice)).toMatch(/audit log/i);
    expect(notice?.signals).toContain('compensation-in-payload');

    // and it must survive JSON serialization, or the model never sees it
    expect(JSON.parse(JSON.stringify(result))._security.riskLevel).toBe('high');

    expect(lastInsert(ctx, 'audit_events').decision).toBe('flagged');
    expect(firstInsert(ctx, 'security_events').decision).toBe('flagged');
  });

  it('blocks a bulk sensitive export when it runs unattended', async () => {
    const ctx = makeCtx({ surface: 'schedule' });
    await expect(
      runTool(tool('payroll.expenses_report'), { limit: 5000 }, ctx),
    ).rejects.toBeInstanceOf(SecurityBlockedError);
    expect(handler).not.toHaveBeenCalled();
    expect(firstInsert(ctx, 'security_events').risk_level).toBe('critical');
  });

  it('blocks identity documents leaving the company', async () => {
    const ctx = makeCtx();
    await expect(
      runTool(
        tool('gmail.send_draft'),
        {
          to: 'vendor@payments.io',
          body: 'passport number and bank account below',
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(SecurityBlockedError);
  });

  it('gates an ordinary client email rather than blocking it', async () => {
    const mail = {
      to: 'hiring@acme-client.com',
      body: 'Two candidates are ready to interview.',
    };
    const ctx = makeCtx();
    // Anything addressed outside the company gets one confirmation…
    await expect(runTool(tool('gmail.send_draft'), mail, ctx)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    // …and then goes out. Emailing clients is the business; it is never refused.
    const ctx2 = makeCtx();
    await expect(
      runTool(tool('gmail.send_draft'), mail, ctx2, { confirmed: true }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('a low-risk call writes no security_events row at all', async () => {
    const ctx = makeCtx();
    await runTool(tool('web.search'), { query: 'hiring trends' }, ctx);
    expect(insertsInto(ctx, 'security_events')).toHaveLength(0);
    const audit = lastInsert(ctx, 'audit_events');
    expect(audit.decision).toBe('allowed');
    expect(audit.risk_level).toBe('low');
  });

  it('escalates an unattended scheduled external write to a block', async () => {
    const ctx = makeCtx({ surface: 'schedule' });
    await expect(
      runTool(tool('slack.post_message'), { channel: '#acme', text: 'update' }, ctx),
    ).rejects.toBeInstanceOf(SecurityBlockedError);
    expect(insertsInto(ctx, 'audit_events')[0]?.surface).toBe('schedule');
  });

  it('the same call from the web surface just runs', async () => {
    const ctx = makeCtx({ surface: 'web' });
    await expect(
      runTool(tool('slack.post_message'), { channel: '#acme', text: 'update' }, ctx),
    ).resolves.toMatchObject({ ok: true });
  });

  it('fails open when the policy and frequency lookups throw', async () => {
    const ctx = makeCtx();
    (ctx.db as unknown as { from: ReturnType<typeof vi.fn> }).from = vi.fn(() => {
      throw new Error('db down');
    });
    // Enforcement still runs on defaults; a benign call is unaffected.
    await expect(runTool(tool('web.search'), { query: 'x' }, ctx)).resolves.toEqual({ ok: true });
  });
});
