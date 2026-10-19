import { describe, expect, it } from 'vitest';
import { applyPrefill, buildPrefill, decodePrefill, encodePrefill, thenHref } from './after-submit';

const ROW = { id: '11111111-1111-4111-8111-111111111111', label: 'AV204' };

describe('encadenar pantallas: valores prellenados', () => {
  it('{{fila}} sola es la fila como relación; con texto alrededor, su nombre', () => {
    const out = buildPrefill(
      { screen: 'nueva_atencion', prefill: { vuelo: '{{fila}}', nota: 'Vuelo {{fila}} listo' } },
      { values: {}, row: ROW },
    );
    expect(JSON.parse(out.vuelo as string)).toEqual({ id: ROW.id, label: 'AV204' });
    expect(out.nota).toBe('Vuelo AV204 listo');
  });
  it('{{campo}} trae lo que se envió; fijos y números se conservan; lo vacío no viaja', () => {
    const out = buildPrefill(
      {
        screen: 'x1',
        prefill: { origen: '{{destino}}', tipo: 'Rápida', cantidad: 3, vacio: '{{nada}}' },
      },
      { values: { destino: 'BOG' }, row: ROW },
    );
    expect(out).toEqual({ origen: 'BOG', tipo: 'Rápida', cantidad: '3' });
  });
  it('{{nombre}} e {{id}} son los de la fila; sin fila quedan vacíos', () => {
    expect(
      buildPrefill({ screen: 'x1', prefill: { a: '{{nombre}}', b: '{{id}}' } }, { row: ROW }),
    ).toEqual({ a: 'AV204', b: ROW.id });
    expect(buildPrefill({ screen: 'x1', prefill: { a: '{{fila}}' } }, {})).toEqual({});
  });
  it('sin prefill no hay nada que llevar', () => {
    expect(buildPrefill({ screen: 'x1' }, { row: ROW })).toEqual({});
  });
});

describe('la dirección lleva los valores y la pantalla destino los lee', () => {
  it('ida y vuelta, también con tildes y emojis', () => {
    const values = { vuelo: JSON.stringify(ROW), nota: 'Operación ñandú ✈️ «urgente»' };
    expect(decodePrefill(encodePrefill(values))).toEqual(values);
  });
  it('una dirección mala, enorme o con tipos raros se ignora sin romper', () => {
    expect(decodePrefill('###')).toEqual({});
    expect(decodePrefill(null)).toEqual({});
    expect(decodePrefill('x'.repeat(5000))).toEqual({});
    const raro = encodePrefill({ ok: 'sí' });
    expect(decodePrefill(raro)).toEqual({ ok: 'sí' });
    const arr = btoa(JSON.stringify(['a'])).replace(/=+$/, '');
    expect(decodePrefill(arr)).toEqual({});
    const mixed = btoa(JSON.stringify({ ok: 'a', n: 5, 'Mala Llave': 'x' })).replace(/=+$/, '');
    expect(decodePrefill(mixed)).toEqual({ ok: 'a' });
  });
  it('demasiado grande no viaja (queda vacío)', () => {
    expect(encodePrefill({ a: 'x'.repeat(4000) })).toBe('');
  });
  it('thenHref arma la ruta con ?pre=, respeta «Ver como…» y sin valores no agrega nada', () => {
    const then = { screen: 'nueva_atencion', prefill: { vuelo: '{{fila}}' } };
    const href = thenHref('/apps/rampa', then, { row: ROW });
    expect(href.startsWith('/apps/rampa/nueva_atencion?pre=')).toBe(true);
    const como = thenHref('/a/abc', then, { row: ROW }, '?como=operario');
    expect(como.startsWith('/a/abc/nueva_atencion?como=operario&pre=')).toBe(true);
    expect(thenHref('/apps/rampa', { screen: 'inicio' }, {})).toBe('/apps/rampa/inicio');
    expect(thenHref('/apps/rampa', { screen: 'inicio' }, {}, '?como=x')).toBe(
      '/apps/rampa/inicio?como=x',
    );
  });
});

describe('applyPrefill', () => {
  it('sólo pone campos que el formulario tiene y que no se calculan', () => {
    const fields = [{ key: 'vuelo' }, { key: 'total', formula: true }, { key: 'nota' }];
    const out = applyPrefill(
      fields,
      { nota: 'a mano' },
      { vuelo: 'V', total: '99', desconocido: 'z', nota: 'B' },
    );
    expect(out).toEqual({ vuelo: 'V', nota: 'B' });
  });
});
