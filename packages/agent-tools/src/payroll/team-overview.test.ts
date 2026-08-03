import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationError } from '@cortex/core';
import { runTool } from '../index';
import { payrollTeamOverview } from './team-overview';
import type { ToolContext } from '../types';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const fromBuilder = {
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    }),
  };
  const db = { from: vi.fn().mockReturnValue(fromBuilder) };

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
    integrations: {} as unknown as ToolContext['integrations'],
    logger: logger as unknown as ToolContext['logger'],
    ...overrides,
  };
}

const mockOverview = {
  asOf: '2026-06-01T00:00:00.000Z',
  totals: {
    totalUsers: 552,
    active: 157,
    assignedToClients: 135,
    internal: 19,
    newHires: 6,
  },
  byDivision: [
    { division: 'Tech', count: 106 },
    { division: 'Non-tech', count: 29 },
    { division: 'Internal', count: 19 },
  ],
  byClient: [
    { client: 'PureCars', count: 18 },
    { client: 'Connectwise', count: 15 },
  ],
  byCurrency: [
    { currency: 'USD', count: 153 },
    { currency: 'MXN', count: 4 },
  ],
};

describe('payroll.team_overview', () => {
  beforeEach(() => {
    process.env.PAYROLL_API_URL = 'https://payroll.internal';
    process.env.PAYROLL_API_TOKEN = 'test-payroll-token';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAYROLL_API_URL;
    delete process.env.PAYROLL_API_TOKEN;
  });

  it('happy path: calls payroll internal API and returns validated overview', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockOverview,
    }));

    const ctx = makeCtx();
    const result = await runTool(payrollTeamOverview, {}, ctx);

    // toMatchObject, not toEqual: runTool attaches a `_security` notice to
    // results the guardrails flagged (payroll data is sensitive), and that
    // notice is deliberately part of what reaches the model.
    expect(result).toMatchObject(mockOverview);
    expect((result as unknown as { _security: { riskLevel: string } })._security.riskLevel).toBe(
      'medium',
    );
    expect(fetch).toHaveBeenCalledWith(
      'https://payroll.internal/api/internal/team-overview',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-payroll-token',
        }),
      }),
    );
  });

  it('throws IntegrationError when payroll returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    }));

    const ctx = makeCtx();
    await expect(runTool(payrollTeamOverview, {}, ctx)).rejects.toBeInstanceOf(IntegrationError);
  });

  it('throws IntegrationError when env is not configured', async () => {
    delete process.env.PAYROLL_API_URL;
    delete process.env.PAYROLL_API_TOKEN;
    vi.stubGlobal('fetch', vi.fn());

    const ctx = makeCtx();
    await expect(runTool(payrollTeamOverview, {}, ctx)).rejects.toBeInstanceOf(IntegrationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enforces rateLimit of 20 per minute', () => {
    expect(payrollTeamOverview.rateLimit).toEqual({ perMinute: 20 });
  });

  it('tool id is payroll.team_overview', () => {
    expect(payrollTeamOverview.id).toBe('payroll.team_overview');
  });
});
