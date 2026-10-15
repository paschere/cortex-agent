import { describe, expect, it } from 'vitest';
import {
  STALL_MS,
  TOOL_STALL_MS,
  activitySignature,
  endsWithoutAnswer,
  isStalled,
  toolIsRunning,
} from './turn-watchdog';

describe('el vigilante del turno', () => {
  it('avisa a los 45 s sin datos, y más tarde si una herramienta corre', () => {
    expect(isStalled({ now: STALL_MS - 1, lastActivityAt: 0, toolRunning: false })).toBe(false);
    expect(isStalled({ now: STALL_MS, lastActivityAt: 0, toolRunning: false })).toBe(true);
    expect(isStalled({ now: STALL_MS + 1, lastActivityAt: 0, toolRunning: true })).toBe(false);
    expect(isStalled({ now: TOOL_STALL_MS, lastActivityAt: 0, toolRunning: true })).toBe(true);
  });
  it('detecta la herramienta corriendo y la huella cambia con cada dato nuevo', () => {
    const running = {
      role: 'assistant',
      content: '',
      parts: [{ type: 'tool-invocation', toolInvocation: { state: 'call' } }],
    };
    expect(toolIsRunning(running)).toBe(true);
    expect(
      toolIsRunning({
        ...running,
        parts: [{ type: 'tool-invocation', toolInvocation: { state: 'result' } }],
      }),
    ).toBe(false);
    const a = activitySignature([
      { role: 'user', content: 'x' },
      { ...running, content: 'ho' },
    ]);
    const b = activitySignature([
      { role: 'user', content: 'x' },
      { ...running, content: 'hola' },
    ]);
    expect(a).not.toBe(b);
  });
  it('un cierre sin respuesta: pregunta sin contestar o burbuja vacía', () => {
    expect(endsWithoutAnswer([{ role: 'user', content: 'continua' }])).toBe(true);
    expect(
      endsWithoutAnswer([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: '  ' },
      ]),
    ).toBe(true);
    expect(
      endsWithoutAnswer([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'listo' },
      ]),
    ).toBe(false);
    // Una propuesta con tarjeta (sólo herramientas) es una respuesta.
    expect(
      endsWithoutAnswer([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: '', toolInvocations: [{ state: 'result' }] },
      ]),
    ).toBe(false);
  });
});
