import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getView: vi.fn(),
  voiceTurn: vi.fn(),
  sameOrigin: vi.fn(),
  openPublic: vi.fn(),
  unlocked: vi.fn(),
}));
vi.mock('@/lib/activations/request', () => ({ isSameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/session', () => ({
  requireSession: async () => ({ id: 'person', organization: { id: 'company' } }),
}));
vi.mock('@/lib/supabase/service', () => ({ getOrgScopedClient: () => ({}) }));
vi.mock('@cortex/agent-tools', () => ({ getView: mocks.getView }));
vi.mock('@/lib/views/voice-turn', () => ({ voiceTurn: mocks.voiceTurn }));
vi.mock('@/lib/views/dictate-request', async () => {
  const actual = await vi.importActual<typeof import('@/lib/views/dictate-request')>(
    '@/lib/views/dictate-request',
  );
  return actual;
});
vi.mock('@/lib/views/dictate', () => ({
  DICTATION_MAX_BYTES: 1000,
  DICTATION_MAX_CHARS: 1500,
  DictationLimitError: class extends Error {},
  isDictationAudio: () => true,
}));
vi.mock('@/lib/views/public', () => ({
  openPublicView: mocks.openPublic,
  isUnlocked: mocks.unlocked,
  unlockCookieName: (id: string) => `unlock-${id}`,
}));

import { POST as publicPost } from '../../public/voice-turn/route';
import { POST as appPost } from './route';

const body = (extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set('blockId', 'form1');
  f.set('text', 'cuatro piezas');
  f.set('current', 'piezas');
  f.set('values', JSON.stringify({ guia: '1' }));
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
};
const req = (form: FormData | string) =>
  new NextRequest('http://localhost/api/x', { method: 'POST', body: form });
const ctxParams = { params: Promise.resolve({ id: 'view-1' }) };
const TOKEN = 'a'.repeat(40);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.getView.mockResolvedValue({ id: 'view-1' });
  mocks.voiceTurn.mockResolvedValue({ heard: 'x', values: {}, command: null, commandField: null });
});

describe('POST /api/views/[id]/voice-turn', () => {
  it('rechaza otro origen', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await appPost(req(body()), ctxParams)).status).toBe(403);
    expect(mocks.voiceTurn).not.toHaveBeenCalled();
  });

  it('una vista de otra empresa (o borrada) es un 404', async () => {
    mocks.getView.mockResolvedValue(null);
    expect((await appPost(req(body()), ctxParams)).status).toBe(404);
    expect(mocks.voiceTurn).not.toHaveBeenCalled();
  });

  it('un cuerpo roto es un 400', async () => {
    const bad = body({ values: '{no es json' });
    expect((await appPost(req(bad), ctxParams)).status).toBe(400);
  });

  it('pasa el turno con el campo y los valores', async () => {
    const res = await appPost(req(body()), ctxParams);
    expect(res.status).toBe(200);
    expect(mocks.voiceTurn).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'view-1' },
      expect.objectContaining({
        blockId: 'form1',
        current: 'piezas',
        values: { guia: '1' },
        transcribeOnly: false,
      }),
      expect.anything(),
    );
  });
});

describe('POST /api/views/public/voice-turn', () => {
  it('sin token válido es un 404', async () => {
    expect((await publicPost(req(body({ token: 'corto' })))).status).toBe(404);
    expect(mocks.openPublic).not.toHaveBeenCalled();
  });

  it('un enlace que ya no existe es un 404', async () => {
    mocks.openPublic.mockResolvedValue(null);
    expect((await publicPost(req(body({ token: TOKEN })))).status).toBe(404);
  });

  it('con contraseña y sin la cookie de desbloqueo es un 401', async () => {
    mocks.openPublic.mockResolvedValue({ view: { id: 'v', visibility: 'password' }, db: {} });
    mocks.unlocked.mockResolvedValue(false);
    expect((await publicPost(req(body({ token: TOKEN })))).status).toBe(401);
    expect(mocks.voiceTurn).not.toHaveBeenCalled();
  });

  it('con enlace abierto, atiende el turno', async () => {
    mocks.openPublic.mockResolvedValue({ view: { id: 'v', visibility: 'link' }, db: {} });
    expect((await publicPost(req(body({ token: TOKEN })))).status).toBe(200);
    expect(mocks.voiceTurn).toHaveBeenCalledOnce();
  });
});
