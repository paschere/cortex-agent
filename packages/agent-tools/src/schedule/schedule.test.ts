import { ValidationError } from '@cortex/core';
import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import { scheduleCreate } from './create';
import { computeNextRun, isValidCron } from './recurrence';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const db = { from: vi.fn() };
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
    organizationId: 'org-test',
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    db: db as unknown as ToolContext['db'],
    integrations: integrations as unknown as ToolContext['integrations'],
    logger: logger as unknown as ToolContext['logger'],
    ...overrides,
  };
}

describe('recurrence', () => {
  it('computes the next daily occurrence after `from`', () => {
    const from = new Date('2026-07-08T10:00:00Z');
    const next = computeNextRun('0 9 * * *', 'UTC', from);
    expect(next.toISOString()).toBe('2026-07-09T09:00:00.000Z');
  });

  it('respects the timezone', () => {
    const from = new Date('2026-07-08T10:00:00Z');
    // 09:00 in Mexico City (UTC-6 in July) = 15:00 UTC, still ahead on the same day.
    const next = computeNextRun('0 9 * * *', 'America/Mexico_City', from);
    expect(next.toISOString()).toBe('2026-07-08T15:00:00.000Z');
  });

  it('throws ValidationError on a bad expression', () => {
    expect(() => computeNextRun('not a cron', 'UTC')).toThrow(ValidationError);
  });

  it('isValidCron: true for valid, false for invalid', () => {
    expect(isValidCron('*/5 * * * *', 'UTC')).toBe(true);
    expect(isValidCron('99 99 * * *', 'UTC')).toBe(false);
  });
});

describe('schedule.create validation', () => {
  const base = {
    name: 'Test job',
    kind: 'agent' as const,
    instruction: 'do the thing',
  };

  it('rejects a one-off in the past', async () => {
    await expect(
      scheduleCreate.handler(
        {
          ...base,
          scheduleKind: 'once',
          runAt: '2020-01-01T00:00:00Z',
        } as Parameters<typeof scheduleCreate.handler>[0],
        makeCtx(),
      ),
    ).rejects.toThrow(/future/);
  });

  it('rejects cron kind without a cron expression', async () => {
    await expect(
      scheduleCreate.handler(
        { ...base, scheduleKind: 'cron' } as Parameters<typeof scheduleCreate.handler>[0],
        makeCtx(),
      ),
    ).rejects.toThrow(/requires cron/);
  });

  it('rejects an unknown tool for kind=tool', async () => {
    await expect(
      scheduleCreate.handler(
        {
          name: 'Test',
          kind: 'tool',
          toolId: 'nope.missing',
          toolInput: {},
          scheduleKind: 'cron',
          cron: '0 9 * * *',
        } as Parameters<typeof scheduleCreate.handler>[0],
        makeCtx(),
      ),
    ).rejects.toThrow(/Unknown tool/);
  });

  it('rejects a confirmation-gated tool without allowUnattendedWrites', async () => {
    // schedule.create itself is confirmation-gated and registered — use it as the target.
    await expect(
      scheduleCreate.handler(
        {
          name: 'Meta',
          kind: 'tool',
          toolId: 'schedule.create',
          toolInput: {
            name: 'inner',
            kind: 'agent',
            instruction: 'x',
            scheduleKind: 'cron',
            cron: '0 9 * * *',
          },
          scheduleKind: 'cron',
          cron: '0 9 * * *',
        } as Parameters<typeof scheduleCreate.handler>[0],
        makeCtx(),
      ),
    ).rejects.toThrow(/requires confirmation/);
  });

  it('rejects kind=agent without instruction', async () => {
    await expect(
      scheduleCreate.handler(
        {
          name: 'Test',
          kind: 'agent',
          scheduleKind: 'cron',
          cron: '0 9 * * *',
        } as Parameters<typeof scheduleCreate.handler>[0],
        makeCtx(),
      ),
    ).rejects.toThrow(/requires instruction/);
  });
});
