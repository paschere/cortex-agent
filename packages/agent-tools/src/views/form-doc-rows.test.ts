import { describe, expect, it } from 'vitest';
import { normalizeDocRows, parseDocRows } from './form-doc-rows';

const cfg = { key: 'guia', fields: ['guia', 'kilos'] };

describe('parseDocRows', () => {
  it('vacío es lista vacía; lo que no es lista no se entiende', () => {
    expect(parseDocRows('')).toEqual([]);
    expect(parseDocRows('{"a":1}')).toBeNull();
    expect(parseDocRows('no json')).toBeNull();
  });
  it('los números pasan a texto y lo demás se descarta', () => {
    expect(parseDocRows('[{"guia":"729-1","kilos":40,"x":{"y":1}}]')).toEqual([
      { guia: '729-1', kilos: '40' },
    ]);
  });
});

describe('normalizeDocRows', () => {
  it('quita los renglones sin guía y los campos que no están configurados', () => {
    expect(normalizeDocRows([{ kilos: '1' }, { guia: 'A', otro: 'x' }], cfg)).toEqual([{ guia: 'A' }]);
  });
  it('la misma guía repetida se junta: lo primero gana, lo nuevo llena huecos', () => {
    expect(
      normalizeDocRows([{ guia: 'A' }, { guia: 'a', kilos: '5' }, { guia: 'A', kilos: '9' }], cfg),
    ).toEqual([{ guia: 'A', kilos: '5' }]);
  });
});
