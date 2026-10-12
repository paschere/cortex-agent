import { describe, expect, it } from 'vitest';
import { artifactMeta, csvFileName, declaredCsv, toCsv } from './chat-artifact';

describe('chat-artifact', () => {
  it('arma el CSV de una tabla declarada con las etiquetas como encabezado', () => {
    const csv = declaredCsv(
      {
        rows: 'items',
        columns: [
          { key: 'client', label: 'Cliente' },
          { key: 'amount', label: 'Valor' },
        ],
      },
      { items: [{ client: 'Frigoandes, S.A.', amount: 4800000 }] },
    );
    expect(csv?.headers).toEqual(['Cliente', 'Valor']);
    expect(toCsv(csv as NonNullable<typeof csv>)).toBe(
      '﻿Cliente,Valor\r\n"Frigoandes, S.A.",4800000\r\n',
    );
  });

  it('escapa comillas y no inventa tablas vacías', () => {
    expect(toCsv({ headers: ['a'], rows: [['di "hola"']] })).toContain('"di ""hola"""');
    expect(declaredCsv({ rows: 'x', columns: [] }, { x: [] })).toBeUndefined();
  });

  it('decide qué se abre al lado', () => {
    expect(artifactMeta('browser.open_page', {})).toBeNull();
    expect(artifactMeta('reports.chart', { chartId: 'c', heading: 'Ventas' })?.title).toBe(
      'Ventas',
    );
    const t = artifactMeta('trackers.query', {
      tracker: { name: 'Clientes', fields: [{ key: 'n', label: 'Nombre' }] },
      rows: [{ values: { n: 'Ana' } }],
    });
    expect(t?.kind).toBe('table');
    expect(t?.csv?.rows).toEqual([['Ana']]);
  });

  it('da nombres de archivo seguros', () => {
    expect(csvFileName('¿Quién me debe? Ñandú')).toBe('quien-me-debe-nandu.csv');
    expect(csvFileName('###')).toBe('cortex.csv');
  });
});
