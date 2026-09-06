import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  model: vi.fn(),
  meter: vi.fn(),
  rate: vi.fn(),
  db: {},
}));
vi.mock('@/lib/session', () => ({ requireSession: mocks.session }));
vi.mock('@/lib/supabase/service', () => ({ getOrgScopedClient: () => mocks.db }));
vi.mock('@cortex/agent-tools', () => ({
  NO_THINKING: {},
  chatModel: () => 'configured-model',
  checkMeter: mocks.meter,
  isRefused: (v: boolean) => v,
  consumeToken: mocks.rate,
}));
vi.mock('ai', () => ({ generateObject: mocks.model }));
import { organizeCompany } from './profile-analysis';
const source = 'Somos una empresa distribuidora y necesitamos organizar el seguimiento de cobros.';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({
    id: 'person',
    role: 'org_admin',
    organization: { id: 'company' },
  });
  mocks.meter.mockResolvedValue(false);
  mocks.rate.mockResolvedValue(undefined);
  mocks.model.mockResolvedValue({
    object: {
      scope: 'Cartera',
      priorities: '',
      successMeasures: '',
      questions: ['¿Qué resultado esperas?'],
    },
  });
});
describe('company configuration proposal boundary', () => {
  it('rejects non administrators before invoking a model', async () => {
    mocks.session.mockResolvedValue({ role: 'member' });
    expect((await organizeCompany(source)).ok).toBe(false);
    expect(mocks.model).not.toHaveBeenCalled();
  });
  it('bounds narration size', async () => {
    expect((await organizeCompany('a'.repeat(18001))).ok).toBe(false);
    expect(mocks.rate).not.toHaveBeenCalled();
  });
  it('honors plan and rate limits', async () => {
    mocks.meter.mockResolvedValue(true);
    expect((await organizeCompany(source)).ok).toBe(false);
    expect(mocks.model).not.toHaveBeenCalled();
  });
  it('returns missing fields for human review without execution tools', async () => {
    const r = await organizeCompany(source);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.draft.priorities).toBe('');
    const call = mocks.model.mock.calls[0]?.[0];
    expect(JSON.parse(call.prompt)).toEqual({ narration: source });
    expect(call.tools).toBeUndefined();
  });
  it('rejects malformed model output', async () => {
    mocks.model.mockResolvedValue({ object: { scope: 'anything' } });
    expect((await organizeCompany(source)).ok).toBe(false);
  });
  it('does not expose provider errors', async () => {
    mocks.model.mockRejectedValue(new Error('secret-key'));
    const result = await organizeCompany(source);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });
});
