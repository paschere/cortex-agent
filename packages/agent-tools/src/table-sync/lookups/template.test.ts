import { describe, expect, it } from 'vitest';
import {
  describeTemplateProblem,
  hostOfTemplate,
  renderInputTokens,
  renderLookupUrl,
  templateFields,
} from './template';
import { formatMoment, parseMoment } from './time';

// 2026-10-03 10:00 en Bogotá.
const NOW = Date.parse('2026-10-03T15:00:00Z');

describe('la URL de una consulta', () => {
  it('arma la dirección con los campos de la fila y fechas en el formato pedido', () => {
    const r = renderLookupUrl(
      'https://api.ejemplo.com/vuelos/{vuelo}/{fecha:YYYY-MM-DD}',
      { vuelo: 'AV9', fecha: '2026-10-03' },
      NOW,
    );
    expect(r).toEqual({ ok: true, url: 'https://api.ejemplo.com/vuelos/AV9/2026-10-03' });
  });

  it('formatos de fecha: día primero, compacto, hora de Bogotá, ISO y unix', () => {
    const values = { fecha: '2026-10-03', hora: '2026-10-03 14:30' };
    const url = (t: string) => {
      const r = renderLookupUrl(t, values, NOW);
      return r.ok ? r.url : r.missing.join(',');
    };
    expect(url('https://a.co/{fecha:DD/MM/YYYY}')).toBe('https://a.co/03%2F10%2F2026');
    expect(url('https://a.co/{fecha:YYYYMMDD}')).toBe('https://a.co/20261003');
    expect(url('https://a.co/{hora:HH:mm}')).toBe('https://a.co/14%3A30');
    // 14:30 de Bogotá = 19:30 UTC.
    expect(url('https://a.co/{hora:iso}')).toBe(
      `https://a.co/${encodeURIComponent('2026-10-03T19:30:00.000Z')}`,
    );
    expect(url('https://a.co/{hora:unix}')).toBe(
      `https://a.co/${Date.parse('2026-10-03T19:30:00Z') / 1000}`,
    );
  });

  it('una hora con zona se lleva a Bogotá', () => {
    const r = renderLookupUrl(
      'https://a.co/{h:YYYY-MM-DD}/{h:HH:mm}',
      { h: '2026-10-04T02:30:00Z' },
      NOW,
    );
    // 02:30Z del 4 = 21:30 del 3 en Bogotá.
    expect(r).toEqual({ ok: true, url: 'https://a.co/2026-10-03/21%3A30' });
  });

  it('codifica cada valor: no puede salirse de su tramo ni abrir parámetros', () => {
    const r = renderLookupUrl(
      'https://a.co/guias/{guia}?v={vuelo}',
      { guia: '../admin', vuelo: 'a&b=c#x' },
      NOW,
    );
    expect(r).toEqual({
      ok: true,
      url: 'https://a.co/guias/..%2Fadmin?v=a%26b%3Dc%23x',
    });
  });

  it('upper, lower, digits y compact', () => {
    const r = renderLookupUrl(
      'https://a.co/{a:upper}/{b:lower}/{c:digits}/{d:compact}',
      { a: 'av9', b: 'BOG', c: '045-1234', d: 'av 009' },
      NOW,
    );
    expect(r).toEqual({ ok: true, url: 'https://a.co/AV9/bog/0451234/AV009' });
  });

  it('una fila a la que le falta un campo no se consulta, y dice cuál', () => {
    expect(
      renderLookupUrl('https://a.co/{vuelo}/{fecha:YYYY-MM-DD}', { vuelo: 'AV9' }, NOW),
    ).toEqual({
      ok: false,
      missing: ['fecha'],
    });
    // Vacío o sólo espacios = falta.
    expect(renderLookupUrl('https://a.co/{vuelo}', { vuelo: '  ' }, NOW)).toEqual({
      ok: false,
      missing: ['vuelo'],
    });
  });

  it('una fecha que no es fecha cuenta como faltante, no se adivina', () => {
    expect(renderLookupUrl('https://a.co/{f:YYYY-MM-DD}', { f: 'pronto' }, NOW)).toEqual({
      ok: false,
      missing: ['f'],
    });
  });

  it('{hoy} y {ahora} son del día de Bogotá, y la columna con ese nombre gana', () => {
    const late = Date.parse('2026-10-04T03:00:00Z'); // 22:00 del 3 en Bogotá
    expect(renderLookupUrl('https://a.co/{hoy:YYYY-MM-DD}', {}, late)).toEqual({
      ok: true,
      url: 'https://a.co/2026-10-03',
    });
    expect(renderLookupUrl('https://a.co/{hoy}', {}, late)).toEqual({
      ok: true,
      url: 'https://a.co/2026-10-03',
    });
    expect(renderLookupUrl('https://a.co/{ahora}', {}, NOW)).toEqual({
      ok: true,
      url: `https://a.co/${encodeURIComponent('2026-10-03T10:00')}`,
    });
    expect(renderLookupUrl('https://a.co/{hoy}', { hoy: 'x' }, late)).toEqual({
      ok: true,
      url: 'https://a.co/x',
    });
  });

  it('lista los campos que pide, sin repetir', () => {
    expect(
      templateFields('https://a.co/{vuelo}/{fecha:YYYY-MM-DD}?v={vuelo}&d={fecha:DD/MM/YYYY}'),
    ).toEqual([
      { name: 'vuelo', format: null },
      { name: 'fecha', format: 'YYYY-MM-DD' },
      { name: 'fecha', format: 'DD/MM/YYYY' },
    ]);
    expect(hostOfTemplate('https://API.ejemplo.com/x/{a}')).toBe('api.ejemplo.com');
  });
});

describe('qué direcciones se aceptan', () => {
  it('buenas', () => {
    expect(
      describeTemplateProblem('https://api.ejemplo.com/vuelos/{vuelo}/{fecha:YYYY-MM-DD}'),
    ).toBeNull();
    expect(
      describeTemplateProblem('https://api.ejemplo.com/v?airport=BOG&date={hoy:YYYY-MM-DD}'),
    ).toBeNull();
  });
  it('rechaza http, campos en el servidor, usuario:clave, llaves sueltas y formatos que no existen', () => {
    expect(describeTemplateProblem('http://a.co/x')).toMatch(/https/);
    expect(describeTemplateProblem('https://{vuelo}.a.co/x')).toMatch(/servidor/);
    expect(describeTemplateProblem('https://user:pw@a.co/x')).toMatch(/usuario/);
    expect(describeTemplateProblem('https://a.co/{vuelo')).toMatch(/sin cerrar/);
    expect(describeTemplateProblem('https://a.co/{{vuelo}}')).toMatch(/un solo par/);
    expect(describeTemplateProblem('https://a.co/{vuelo:raro}')).toMatch(/formato/);
  });
  it('una llave en la dirección se rechaza: va en la credencial', () => {
    expect(describeTemplateProblem('https://a.co/x?api_key=abc')).toMatch(/llave/);
    expect(describeTemplateProblem('https://a.co/x?token={vuelo}')).toMatch(/llave/);
    expect(describeTemplateProblem('https://a.co/x?key=1')).toMatch(/llave/);
  });
});

describe('parámetros fijos de una fuente de lista', () => {
  it('resuelve {hoy} y {ahora} sólo donde están', () => {
    expect(
      renderInputTokens(
        {
          airport: 'BOG',
          date: '{hoy:YYYY-MM-DD}',
          page: 2,
          since: 'desde {ahora:HH:mm}',
          raw: '{otro}',
        },
        NOW,
      ),
    ).toEqual({
      airport: 'BOG',
      date: '2026-10-03',
      page: 2,
      since: 'desde 10:00',
      raw: '{otro}',
    });
  });
});

describe('el reloj de Bogotá', () => {
  it('lee fechas, horas sin zona (Bogotá) y con zona', () => {
    expect(parseMoment('2026-10-03')).toBe(Date.parse('2026-10-03T05:00:00Z'));
    expect(parseMoment('2026-10-03 10:00')).toBe(Date.parse('2026-10-03T15:00:00Z'));
    expect(parseMoment('2026-10-03T15:00:00Z')).toBe(Date.parse('2026-10-03T15:00:00Z'));
    expect(parseMoment('2026-10-03T10:00:00-05:00')).toBe(Date.parse('2026-10-03T15:00:00Z'));
    expect(parseMoment('03/10/2026')).toBe(Date.parse('2026-10-03T05:00:00Z'));
    expect(parseMoment('2026-02-31')).toBeNull();
    expect(parseMoment('mañana')).toBeNull();
  });
  it('formatea en Bogotá', () => {
    expect(formatMoment(Date.parse('2026-10-04T03:30:00Z'), 'YYYY-MM-DD HH:mm')).toBe(
      '2026-10-03 22:30',
    );
  });
});
