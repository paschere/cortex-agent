import { describe, expect, it } from 'vitest';
import { resolveHref, resolveStepFor } from './resolve';

describe('«Que Cortex lo resuelva»', () => {
  it('cada clase de pendiente tiene un paso seguro que termina en «antes de»', () => {
    for (const kind of ['action', 'commitment', 'work_item', 'work_item_mine'] as const) {
      const step = resolveStepFor({ kind, title: 'Cobro FV-12 a Nexa', detail: 'Nexa' });
      expect(step?.prompt).toMatch(/antes de|listo para aprobar/);
    }
  });

  it('nombra el asunto entre comillas latinas, sin dejar que el título las rompa', () => {
    const step = resolveStepFor({ kind: 'commitment', title: 'SOAT «camión» 12', detail: null });
    expect(step?.prompt).toContain('«SOAT "camión" 12»');
  });

  it('sin título no hay botón', () => {
    expect(resolveStepFor({ kind: 'routine', title: '   ' })).toBeNull();
    expect(resolveHref(null)).toBeNull();
  });

  it('el enlace es el chat con la petición escrita', () => {
    const step = resolveStepFor({ kind: 'sync', title: 'Siigo' });
    expect(resolveHref(step)).toBe(`/chat?prompt=${encodeURIComponent(step?.prompt ?? '')}`);
    expect(step?.label).toBe('Que Cortex lo reintente');
  });
});
