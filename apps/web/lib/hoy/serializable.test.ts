import { hoyFixture } from '@/app/v/hoy-showcase/data';
import { describe, expect, it } from 'vitest';

/**
 * Lo que «Hoy» arma en el servidor cruza al navegador: no puede llevar
 * funciones («Functions cannot be passed directly to Client Components»),
 * ni clases, fechas u otra cosa que no sea dato plano.
 */
function strays(v: unknown, path = 'view', out: string[] = []): string[] {
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') {
    out.push(`${path}: ${typeof v}`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => strays(x, `${path}[${i}]`, out));
  } else if (v && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null)
      out.push(`${path}: ${proto?.constructor?.name}`);
    for (const [k, x] of Object.entries(v)) strays(x, `${path}.${k}`, out);
  }
  return out;
}

describe('«Hoy» sólo lleva datos planos', () => {
  const variants = [
    {},
    { equipo: true },
    { sinPlata: true },
    { vacio: true, sinOperacion: true },
    { apuro: true },
  ];
  for (const opts of variants) {
    it(`sin funciones ni objetos raros (${JSON.stringify(opts)})`, () => {
      expect(strays(hoyFixture(opts))).toEqual([]);
    });
  }

  it('lo del dueño: el resultado del mes no viaja a quien no administra', () => {
    expect(hoyFixture({ equipo: true }).insights?.result).toBeNull();
    expect(hoyFixture().insights?.result?.months.length).toBeGreaterThan(2);
  });

  it('cada tarjeta de la semana trae su pantalla', () => {
    for (const c of hoyFixture().insights?.week ?? []) expect(c.href).toMatch(/^\//);
  });
});
