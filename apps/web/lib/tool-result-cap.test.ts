import { describe, expect, it } from 'vitest';
import { capResultForModel, modelToolContent } from './tool-result-cap';

describe('lo que el modelo lee de un resultado', () => {
  it('lo pequeño pasa entero, como JSON', () => {
    expect(capResultForModel({ a: 1 })).toBe('{"a":1}');
  });
  it('una lista enorme se recorta con forma y dice cuántos faltan', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `fila ${i}`.repeat(5) }));
    const text = capResultForModel({ tables: rows }, 24_000);
    expect(text.length).toBeLessThan(24_200);
    expect(text).toMatch(/\+\d+ más/);
    expect(text).toContain('La persona ve el resultado completo');
    expect(() => JSON.parse(text.split('\n[Resultado')[0] as string)).not.toThrow();
  });
  it('sale como contenido de texto para el proveedor', () => {
    expect(modelToolContent('x')).toEqual([{ type: 'text', text: '"x"' }]);
  });
});
