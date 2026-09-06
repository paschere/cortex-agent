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
  isRefused: (value: boolean) => value,
  consumeToken: mocks.rate,
  repairStructured: () => undefined,
}));
vi.mock('ai', () => ({ generateObject: mocks.model }));
import { organizeManual } from './manual-actions';
const draft = {
  name: 'Cobros',
  purpose: 'Revisar cartera',
  trigger: 'Los lunes',
  inputs: 'Hoja de cartera',
  steps: 'Ana revisa los saldos.',
  successCriteria: '',
  exceptions: '',
  authority: '',
  browserUrl: null,
};
const source =
  'Los lunes Ana revisa la hoja de cartera y cruza los pagos confirmados antes de preparar un cobro.';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({
    id: 'person',
    role: 'org_admin',
    organization: { id: 'acme' },
  });
  mocks.meter.mockResolvedValue(false);
  mocks.rate.mockResolvedValue(undefined);
  mocks.model.mockResolvedValue({ object: { manual: draft, questions: ['¿Quién aprueba?'] } });
});
describe('manual organization boundary', () => {
  it('refuses a member before calling the model', async () => {
    mocks.session.mockResolvedValue({ role: 'member' });
    expect((await organizeManual(source)).ok).toBe(false);
    expect(mocks.model).not.toHaveBeenCalled();
  });
  it('rejects oversized input before consuming a model call', async () => {
    expect((await organizeManual('a'.repeat(18001))).ok).toBe(false);
    expect(mocks.model).not.toHaveBeenCalled();
  });
  it('honors plan limits', async () => {
    mocks.meter.mockResolvedValue(true);
    expect((await organizeManual(source)).ok).toBe(false);
    expect(mocks.model).not.toHaveBeenCalled();
  });
  it('returns missing fields for review and sends narration as data without execution tools', async () => {
    const result = await organizeManual(source);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manual.authority).toBe('');
    expect(mocks.rate).toHaveBeenCalledWith(mocks.db, 'person', 'management.organize_manual', 4);
    const call = mocks.model.mock.calls[0]?.[0];
    expect(JSON.parse(call.prompt)).toEqual({ narration: source });
    expect(call.tools).toBeUndefined();
  });
  it('removes a link not actually supplied by the person', async () => {
    mocks.model.mockResolvedValue({
      object: { manual: { ...draft, browserUrl: 'https://example.com/fabricado' }, questions: [] },
    });
    const result = await organizeManual(source);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manual.browserUrl).toBeNull();
  });
  it('returns an actionable failure without exposing provider errors', async () => {
    mocks.model.mockRejectedValue(new Error('provider-secret'));
    const result = await organizeManual(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('provider-secret');
  });
});
