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

  it('la investigación en paralelo se abre al lado con su CSV (columnas del resultado + fuentes)', () => {
    const meta = artifactMeta('research.parallel', {
      goal: 'Comparar proveedores',
      columns: [
        { key: 'label', label: 'Elemento' },
        { key: 'values.precio', label: 'Precio' },
      ],
      rows: [{ label: 'Acme', values: { precio: 1200 }, sources: 'https://acme.co' }],
    });
    expect(meta?.kind).toBe('table');
    expect(meta?.title).toBe('Comparar proveedores');
    expect(meta?.csv?.headers).toEqual(['Elemento', 'Precio', 'Fuentes']);
    expect(meta?.csv?.rows).toEqual([['Acme', '1200', 'https://acme.co']]);
  });

  it('da nombres de archivo seguros', () => {
    expect(csvFileName('¿Quién me debe? Ñandú')).toBe('quien-me-debe-nandu.csv');
    expect(csvFileName('###')).toBe('cortex.csv');
  });
});
