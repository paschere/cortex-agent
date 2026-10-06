import { describe, expect, it } from 'vitest';
import { proposalMarkdown, proposeTableFromSheet } from './propose';
import { approvedFields } from './sync';

const sheet = (rows: unknown[][]) => ({ name: 'Hoja 1', rows }) as never;

describe('proponer la tabla desde una hoja', () => {
  const guias = sheet([
    [
      'Número de guía',
      'Fecha',
      'Hora',
      'Cliente',
      'Correo',
      'Piezas',
      'Estado',
      'Revisado',
      'Observaciones',
    ],
    ...Array.from({ length: 12 }, (_, i) => [
      `045-1234567${i % 10}`,
      `2026-10-0${(i % 9) + 1}`,
      `0${i % 10}:30`,
      i % 2 ? 'Andina' : 'Pacífico',
      `ops${i}@empresa.co`,
      i + 1,
      i % 3 ? 'Recibida' : 'Despachada',
      i % 2 ? 'Sí' : 'No',
      i === 3
        ? ''
        : 'Llegó con la caja un poco golpeada en una esquina, se tomó foto y se dejó constancia con el transportador.',
    ]),
  ]);
  const p = proposeTableFromSheet(guias);
  const byLabel = (l: string) => p.fields.find((f) => f.label === l);

  it('infiere los tipos que la hoja permite creer', () => {
    expect(byLabel('Fecha')?.type).toBe('date');
    expect(byLabel('Hora')?.type).toBe('time');
    expect(byLabel('Piezas')?.type).toBe('number');
    expect(byLabel('Estado')?.type).toBe('select');
    expect(byLabel('Revisado')?.type).toBe('checkbox');
    expect(byLabel('Observaciones')?.type).toBe('longtext');
    expect(byLabel('Correo')?.format).toBe('email');
  });

  it('obligatorio sólo lo que nunca vino vacío', () => {
    expect(byLabel('Cliente')?.required).toBe(true);
    expect(byLabel('Observaciones')?.required).toBe(false);
  });

  it('la guía se repite con otra fecha: clave guía + fecha y regla de duplicados', () => {
    expect(p.keyColumns).toEqual(['Número de guía', 'Fecha']);
    expect(p.duplicates).toMatchObject({
      distinctBy: byLabel('Fecha')?.key,
      flagValue: 'Duplicado',
    });
    expect(byLabel('Estado')?.options).toContain('Duplicado');
    expect(proposalMarkdown(p, 'Guías')).toContain('¿La creo así');
  });

  it('un identificador que no se repite es la clave y queda único', () => {
    const q = proposeTableFromSheet(
      sheet([['Factura', 'Valor'], ...Array.from({ length: 6 }, (_, i) => [`FV-${i}`, i * 1000])]),
    );
    expect(q.keyColumns).toEqual(['Factura']);
    expect(q.fields[0]?.unique).toBe(true);
    expect(q.duplicates).toBeNull();
  });

  it('sin identificador, pide decidir en vez de inventar', () => {
    const q = proposeTableFromSheet(sheet([['Nombre'], ['a'], ['a'], ['b']]));
    expect(q.keyColumns).toEqual([]);
    expect(q.notes.join(' ')).toMatch(/pregúntale/);
  });
});

describe('los campos aprobados', () => {
  it('arma el mapeo y rechaza una columna que no está en la hoja', () => {
    const ok = approvedFields(
      [
        {
          key: 'guia',
          label: 'Guía',
          type: 'text',
          required: true,
          sourceColumn: 'Número de guía',
        },
        { key: 'estado', label: 'Estado', type: 'select', required: false, options: ['Duplicado'] },
      ],
      ['Número de guía'],
    );
    expect(ok.mapping).toEqual({ guia: 'Número de guía' });
    expect(ok.fields[0]).not.toHaveProperty('sourceColumn');
    expect(() =>
      approvedFields(
        [{ key: 'x', label: 'X', type: 'text', required: false, sourceColumn: 'Nada' }],
        ['Número de guía'],
      ),
    ).toThrow(/no es una columna/);
  });
});
