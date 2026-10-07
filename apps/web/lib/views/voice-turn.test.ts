import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  meter: vi.fn(),
  refused: vi.fn(),
  generate: vi.fn(),
  transcribe: vi.fn(),
}));
vi.mock('@cortex/agent-tools', () => ({
  NO_THINKING: {},
  chatModel: () => 'm',
  checkMeter: mocks.meter,
  consumeToken: mocks.consume,
  isRefused: mocks.refused,
  transcribeAudio: mocks.transcribe,
}));
vi.mock('ai', () => ({ generateObject: mocks.generate }));
vi.mock('./dictate', async () => {
  const actual = await vi.importActual<typeof import('./dictate')>('./dictate');
  return {
    ...actual,
    formFields: async () => [
      { key: 'guia', label: 'Guía', type: 'text' },
      { key: 'piezas', label: 'Piezas', type: 'number' },
    ],
  };
});

import { DictationLimitError } from './dictate';
import { voiceTurn } from './voice-turn';

const view = { id: 'v1' } as never;
const run = (over: Record<string, unknown> = {}) =>
  voiceTurn(
    {} as never,
    view,
    { blockId: 'f', input: { text: 'cuatro piezas' }, values: {}, ...over },
    {},
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.consume.mockResolvedValue(undefined);
  mocks.meter.mockResolvedValue({});
  mocks.refused.mockReturnValue(false);
  mocks.generate.mockResolvedValue({ object: { values: { piezas: '4', guia: ' ' } } });
});

describe('voiceTurn', () => {
  it('devuelve los valores ya con el formato del campo', async () => {
    const r = await run();
    expect(r).toMatchObject({ heard: 'cuatro piezas', values: { piezas: '4' }, command: null });
  });

  it('respeta el tope por vista', async () => {
    mocks.consume.mockRejectedValue(new Error('rate'));
    await expect(run()).rejects.toBeInstanceOf(DictationLimitError);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('respeta el plan: sin respuestas no llama al modelo', async () => {
    mocks.refused.mockReturnValue(true);
    await expect(run()).rejects.toBeInstanceOf(DictationLimitError);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('sólo transcribir no llama al modelo ni gasta del plan', async () => {
    mocks.transcribe.mockResolvedValue({ ok: true, data: { turns: [{ text: 'hola mundo' }] } });
    const r = await run({
      input: { bytes: new Uint8Array([1]), mime: 'audio/webm' },
      transcribeOnly: true,
    });
    expect(r.heard).toBe('hola mundo');
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.meter).not.toHaveBeenCalled();
  });

  it('si era un comando no devuelve valores y sólo acepta un campo que existe', async () => {
    mocks.generate.mockResolvedValue({
      object: { command: 'correct', commandField: 'piezas', values: { piezas: '9' } },
    });
    expect(await run()).toMatchObject({ command: 'correct', commandField: 'piezas', values: {} });
    mocks.generate.mockResolvedValue({
      object: { command: 'correct', commandField: 'inventado', values: {} },
    });
    expect((await run()).commandField).toBeNull();
  });
});
