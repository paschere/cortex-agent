import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  serviceFrom: vi.fn(),
  refresh: vi.fn(),
  readSources: vi.fn(),
  readViews: vi.fn(),
  createSimulation: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/inngest', () => ({
  inngest: { createFunction: vi.fn((_config, _trigger, handler) => handler) },
}));
vi.mock('@/lib/supabase/service', () => ({
  getOrgScopedClient: vi.fn(() => ({ rpc: mocks.rpc, from: mocks.from })),
  getSupabaseServiceClient: vi.fn(() => ({ from: mocks.serviceFrom })),
}));
vi.mock('@/lib/feed/api-source', () => ({ refreshFeedSource: mocks.refresh }));
vi.mock('@/lib/activations/prepare', () => ({ prepareSourceView: mocks.prepare }));
vi.mock('@/lib/activations/request', () => ({
  activationDefinitionSchema: { parse: (value: unknown) => value },
}));
vi.mock('@/lib/activations/service', async () => {
  class ActivationError extends Error {}
  return {
    ActivationError,
    createSimulation: mocks.createSimulation,
    readOwnedPreparedViews: mocks.readViews,
    readOwnedTableSources: mocks.readSources,
    sourceSnapshot: vi.fn(() => 'derived-fingerprint'),
  };
});
vi.mock('@cortex/agent-tools', () => ({
  checkMeter: vi.fn(),
  isRefused: vi.fn(() => false),
}));

import { activationDispatchJob, activationRunJob } from './activation-followup';

const automation = {
  id: '11111111-1111-4111-8111-111111111111',
  actor_id: '22222222-2222-4222-8222-222222222222',
  source_connection_id: '33333333-3333-4333-8333-333333333333',
  lease_token: '44444444-4444-4444-8444-444444444444',
  trigger: 'on_change',
  last_fingerprint: 'fingerprint',
  approved_schema: { headers: ['Cliente', 'Estado'], sheetIndex: 0, prompt: null },
  definition: { version: 1, kind: 'table_rule', name: 'Seguimiento', conditions: [] },
};
const source = {
  id: '55555555-5555-4555-8555-555555555555',
  feed_content_hash: 'fingerprint',
  feed_truncated: false,
  feed_tables: [
    {
      name: 'Datos',
      rows: [
        ['Cliente', 'Estado'],
        ['Acme', 'Pendiente'],
      ],
    },
  ],
};
const event = {
  event: { data: { automationId: automation.id, organizationId: 'org-a' } },
} as never;

function query(result: unknown) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({ data: result, error: null }));
  return chain;
}

function arrange(options?: {
  trigger?: 'on_change' | 'scheduled';
  headers?: string[];
  kind?: string;
  refreshError?: Error;
  truncated?: boolean;
}) {
  const currentAutomation = {
    ...automation,
    trigger: options?.trigger ?? automation.trigger,
    approved_schema: {
      ...automation.approved_schema,
      headers: options?.headers ?? automation.approved_schema.headers,
    },
  };
  const finishes: Record<string, unknown>[] = [];
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'activation_automation_claim') return { data: currentAutomation, error: null };
    finishes.push(args);
    return { data: args.p_result, error: null };
  });
  mocks.from
    .mockReturnValueOnce(
      query({
        id: automation.source_connection_id,
        kind: options?.kind ?? 'file',
        latest_attachment_id: source.id,
      }),
    )
    .mockReturnValueOnce(query({ latest_attachment_id: source.id }));
  mocks.readSources.mockResolvedValue([{ ...source, feed_truncated: options?.truncated ?? false }]);
  mocks.readViews.mockResolvedValue([]);
  mocks.createSimulation.mockResolvedValue({ id: 'run-1', candidates: [] });
  if (options?.refreshError) mocks.refresh.mockRejectedValue(options.refreshError);
  else mocks.refresh.mockResolvedValue({ changed: true });
  return { finishes };
}

describe('activation follow-up worker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips evaluation for an unchanged on-change source', async () => {
    const { finishes } = arrange();
    await activationRunJob(event);
    expect(mocks.createSimulation).not.toHaveBeenCalled();
    expect(finishes[0]?.p_result).toMatchObject({ outcome: 'unchanged' });
  });

  it('evaluates a scheduled source even with the same fingerprint', async () => {
    arrange({ trigger: 'scheduled' });
    await activationRunJob(event);
    expect(mocks.createSimulation).toHaveBeenCalledOnce();
  });

  it('moves a reordered schema to needs review', async () => {
    const { finishes } = arrange({ headers: ['Estado', 'Cliente'] });
    await activationRunJob(event);
    expect(mocks.createSimulation).not.toHaveBeenCalled();
    expect(finishes[0]).toMatchObject({
      p_needs_review: true,
      p_result: { outcome: 'error' },
    });
  });

  it('uses a stable automation namespace instead of the capture identity', async () => {
    arrange({ trigger: 'scheduled' });
    await activationRunJob(event);
    expect(mocks.createSimulation).toHaveBeenCalledWith(
      expect.anything(),
      automation.actor_id,
      expect.objectContaining(source),
      0,
      expect.anything(),
      { preparedView: undefined, sourceIdentityOverride: `automation:${automation.id}` },
    );
  });

  it('does not simulate or publish when refreshing the source fails', async () => {
    const { finishes } = arrange({ kind: 'api', refreshError: new Error('provider down') });
    await activationRunJob(event);
    expect(mocks.createSimulation).not.toHaveBeenCalled();
    expect(finishes[0]).toMatchObject({ p_run_id: null, p_result: { outcome: 'error' } });
  });

  it('moves a partial refreshed capture to needs review without publication', async () => {
    const { finishes } = arrange({ kind: 'api', truncated: true });
    await activationRunJob(event);
    expect(mocks.createSimulation).not.toHaveBeenCalled();
    expect(finishes[0]).toMatchObject({
      p_run_id: null,
      p_needs_review: true,
      p_result: { outcome: 'error' },
    });
  });

  it('surfaces dispatcher enqueue failures', async () => {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.lte = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(async () => ({
      data: [{ id: automation.id, organization_id: 'org-a' }],
      error: null,
    }));
    mocks.serviceFrom.mockReturnValue(chain);
    const sendEventStrict = vi.fn().mockRejectedValue(new Error('queue unavailable'));
    await expect(
      activationDispatchJob({ step: { sendEventStrict, sendEvent: vi.fn() } } as never),
    ).rejects.toThrow('queue unavailable');
  });
});
