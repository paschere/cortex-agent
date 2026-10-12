import { describe, expect, it } from 'vitest';
import { shotUrl } from '../shot-ref';

describe('shotUrl', () => {
  it('arma la ruta propia de la foto con ids válidos', () => {
    expect(shotUrl('s_abc123', 'Zk3_-aBcD0eF')).toBe(
      '/api/browser/live/s_abc123/shot/Zk3_-aBcD0eF',
    );
  });

  it('sin id de foto no hay referencia (el paso queda sin foto)', () => {
    expect(shotUrl('s_abc123', undefined)).toBeUndefined();
    expect(shotUrl(undefined, 'Zk3_-aBcD0eF')).toBeUndefined();
    expect(shotUrl('s_abc123', '')).toBeUndefined();
  });

  it('nunca arma una ruta con ids que traen separadores, puntos o es demasiado largo', () => {
    expect(shotUrl('../x', 'Zk3_-aBcD0eF')).toBeUndefined();
    expect(shotUrl('s_abc123', 'a/../b123456')).toBeUndefined();
    expect(shotUrl('s_abc123', 'abc')).toBeUndefined();
    expect(shotUrl('s_abc123', 'x'.repeat(40))).toBeUndefined();
  });

  it('es corta: cabe en el resultado de la herramienta sin pesar en el contexto', () => {
    expect(shotUrl('s_abc123', 'Zk3_-aBcD0eF')?.length).toBeLessThan(80);
  });
});
