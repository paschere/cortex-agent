import { describe, expect, it } from 'vitest';
import { previewOf } from './computer-view';

describe('previewOf', () => {
  it('toma la primera lista de registros y recorta filas y columnas', () => {
    const p = previewOf({
      guidance: 'x',
      invoices: Array.from({ length: 18 }, (_, i) => ({
        number: `FE-${i}`,
        client: 'Frigoandes',
        amount: 1000 + i,
        due: '2026-10-01',
        extra: 'no entra',
      })),
    });
    expect(p?.count).toBe(18);
    expect(p?.headers).toEqual(['number', 'client', 'amount', 'due']);
    expect(p?.rows).toHaveLength(4);
    expect(p?.rows[0]).toEqual(['FE-0', 'Frigoandes', '1000', '2026-10-01']);
  });

  it('no inventa nada con errores, confirmaciones o resultados sin lista', () => {
    expect(previewOf({ __error: 'x', items: [{ a: 1 }] })).toBeNull();
    expect(previewOf({ __requires_confirmation: true })).toBeNull();
    expect(previewOf({ files: 12 })).toBeNull();
    expect(previewOf(null)).toBeNull();
  });

  it('acepta un arreglo directo y recorta textos largos', () => {
    const p = previewOf([{ name: 'a'.repeat(80) }]);
    expect(p?.rows[0]?.[0]?.length).toBe(48);
  });
});
