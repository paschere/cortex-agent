import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock('./auth', () => ({ pool: { query: mocks.query, connect: mocks.connect } }));
import { canManageWorkspaceVoice, findWorkspaceVoice, readWorkspaceVoice } from './workspace-voice';

beforeEach(() => vi.resetAllMocks());

describe('workspace voice storage boundary', () => {
  it('grants voice management from workspace membership roles only', () => {
    expect(canManageWorkspaceVoice('owner')).toBe(true);
    expect(canManageWorkspaceVoice('admin')).toBe(true);
    expect(canManageWorkspaceVoice('org_admin')).toBe(false);
    expect(canManageWorkspaceVoice('member')).toBe(false);
  });

  it('scopes provider-id lookup to the workspace and keeps the provider id server-side', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ provider_voice_id: 'voice_private' }] });
    await expect(readWorkspaceVoice('workspace-a')).resolves.toEqual({ id: 'voice_private' });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(['workspace-a']);

    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      findWorkspaceVoice('workspace-a', '11111111-1111-4111-a111-111111111111'),
    ).resolves.toBeNull();
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([
      'workspace-a',
      '11111111-1111-4111-a111-111111111111',
    ]);
  });
});
