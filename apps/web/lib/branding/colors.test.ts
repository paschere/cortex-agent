import { describe, expect, it } from 'vitest';
import {
  brandCssVars,
  brandTokens,
  contrast,
  dominantColors,
  hexToRgb,
  hueDistance,
  hueOf,
  normalizeHex,
} from './colors';
import { parseBrandInput, sniffLogo } from './shape';

const WHITE = [255, 255, 255] as const;
const DARK = [29, 28, 25] as const;

describe('normalizeHex', () => {
  it('acepta las formas comunes y las deja en #rrggbb minúsculas', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('0F766E')).toBe('#0f766e');
    expect(normalizeHex('  #0f766e ')).toBe('#0f766e');
  });
  it('rechaza lo que no es un color', () => {
    expect(normalizeHex('rojo')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('url(javascript:1)')).toBeNull();
    expect(normalizeHex(null)).toBeNull();
  });
});

describe('brandTokens: el contraste se resuelve, la marca se respeta', () => {
  // Un amarillo de taxi, un menta, un azul casi negro, un blanco: las marcas difíciles.
  const brands = ['#facc15', '#5eead4', '#0b1f3a', '#ffffff', '#0f766e', '#e11d48'];

  for (const hex of brands) {
    it(`${hex}: textos ≥ 4.5:1 y 7:1, dibujo visible, botón legible`, () => {
      const t = brandTokens(hex);
      if (!t) throw new Error('sin tokens');
      expect(contrast(t.light.primary, WHITE)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.light.strong, WHITE)).toBeGreaterThanOrEqual(7);
      expect(contrast(t.light.ink, t.light.soft)).toBeGreaterThanOrEqual(7);
      expect(contrast(t.light.fill, WHITE)).toBeGreaterThanOrEqual(1.4);
      expect(contrast(t.dark.primary, DARK)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.dark.ink, t.dark.soft)).toBeGreaterThanOrEqual(7);
      expect(contrast(t.dark.fill, DARK)).toBeGreaterThanOrEqual(1.4);
      expect(contrast(t.button, t.buttonInk)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('un color que ya pasa no se toca', () => {
    const t = brandTokens('#0f766e');
    expect(t?.light.primary).toEqual(hexToRgb('#0f766e'));
    expect(t?.button).toEqual(hexToRgb('#0f766e'));
  });

  it('el amarillo conserva su botón y su dibujo amarillos, con texto oscuro', () => {
    const t = brandTokens('#facc15');
    expect(t?.light.fill).toEqual(hexToRgb('#facc15'));
    expect(t?.button).toEqual(hexToRgb('#facc15'));
    expect(t?.buttonInk).toEqual([23, 23, 31]);
  });

  it('sin color no hay variables: la vista se ve con Cortex', () => {
    expect(brandCssVars(null)).toEqual({});
    expect(brandCssVars('no-es-un-color')).toEqual({});
    expect(brandCssVars('#0f766e')['--bl-primary']).toBe('15 118 110');
  });
});

describe('dominantColors', () => {
  function pixels(list: Array<[number, number, number, number, number]>): number[] {
    // [r, g, b, a, veces]
    return list.flatMap(([r, g, b, a, n]) => Array.from({ length: n }, () => [r, g, b, a]).flat());
  }

  it('propone el color del logo, no su fondo blanco ni lo transparente', () => {
    const data = pixels([
      [255, 255, 255, 255, 600],
      [0, 0, 0, 0, 900],
      [15, 118, 110, 255, 200],
      [245, 158, 11, 255, 80],
    ]);
    const colors = dominantColors(data, 3);
    expect(colors[0]).toBe('#0f766e');
    expect(colors[1]).toBe('#f59e0b');
  });

  it('un logo en blanco y negro aún propone algo', () => {
    expect(dominantColors(pixels([[20, 20, 20, 255, 50]]), 2)).toEqual(['#141414']);
  });
});

describe('hueOf', () => {
  it('reconoce el tono y descarta los grises', () => {
    expect(Math.round(hueOf('#ff0000') ?? -1)).toBe(0);
    expect(Math.round(hueOf('#0f766e') ?? -1)).toBe(175);
    expect(hueOf('#777777')).toBeNull();
    expect(hueDistance(350, 10)).toBe(20);
  });
});

describe('sniffLogo', () => {
  it('lee el tipo por los primeros bytes', () => {
    expect(sniffLogo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png');
    expect(sniffLogo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(
      sniffLogo(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe('image/webp');
  });
  it('un SVG o un HTML no son un logo', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/>');
    expect(sniffLogo(svg)).toBeNull();
    expect(sniffLogo(new TextEncoder().encode('<html>'))).toBeNull();
  });
});

describe('parseBrandInput', () => {
  it('limpia y valida lo que llega del formulario', () => {
    expect(
      parseBrandInput({ displayName: '  Andinos ', primary: '0F766E', secondary: '' }),
    ).toEqual({ ok: true, value: { displayName: 'Andinos', primary: '#0f766e', secondary: null } });
    expect(parseBrandInput({ primary: 'azul' }).ok).toBe(false);
    expect(parseBrandInput({ displayName: 'x'.repeat(81) }).ok).toBe(false);
  });
});
