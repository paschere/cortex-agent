import { describe, expect, it } from 'vitest';
import { recommendFeedUse } from './intelligence';

describe('recommendFeedUse', () => {
  it('routes each sheet independently and identifies missing financial fields', () => {
    const result = recommendFeedUse({
      name: 'Operación agosto.xlsx',
      text: 'Cierre mensual de la operación.',
      tables: [
        {
          name: 'Facturas',
          rows: [
            ['N° factura', 'Fecha emisión', 'Cliente', 'Total'],
            ['FV-104', '2026-08-01', 'Acme', 125000],
          ],
        },
        {
          name: 'Directorio',
          rows: [
            ['Nombre', 'Correo', 'Celular', 'Empresa'],
            ['Ana', 'ana@example.com', '3000000000', 'Acme'],
          ],
        },
        {
          name: 'Seguimiento',
          rows: [
            ['Tarea', 'Fecha límite', 'Estado'],
            ['Llamar', '2026-08-04', 'Pendiente'],
          ],
        },
      ],
    });

    expect(result.tables.map(({ name, kind }) => [name, kind])).toEqual([
      ['Facturas', 'invoice'],
      ['Directorio', 'contacts'],
      ['Seguimiento', 'tasks'],
    ]);
    expect(result.destinations.map((item) => item.area)).toEqual([
      'financial',
      'administrative',
      'commercial',
      'operations',
    ]);
    expect(result.tables[0]?.missingRequiredFields).toEqual([]);
    expect(result).toMatchObject({
      temporary: true,
      promotionPerformed: false,
      reviewRequired: true,
    });
    expect(result.consultationInstruction).toContain('no calculan totales ni promueven');
  });

  it('reports absent required payment fields without inventing values', () => {
    const result = recommendFeedUse({
      name: 'Pagos.csv',
      text: '',
      tables: [
        {
          name: 'Pagos',
          rows: [
            ['Referencia', 'Monto', 'Estado'],
            ['TRX-1', 50000, 'Pagado'],
          ],
        },
      ],
    });

    expect(result.tables[0]).toMatchObject({
      kind: 'payments',
      areas: ['financial', 'administrative'],
      missingRequiredFields: ['fecha', 'contraparte'],
    });
    expect(JSON.stringify(result)).not.toContain('50000');
  });

  it('leaves unknown sheets without a forced destination', () => {
    const result = recommendFeedUse({
      name: 'Notas.xlsx',
      text: 'facturas ventas pagos contactos tareas',
      tables: [{ name: 'Hoja 1', rows: [['Dato'], ['uno']] }],
    });

    expect(result.tables[0]).toMatchObject({
      kind: 'general',
      confidence: 'low',
      areas: [],
      ambiguous: false,
    });
    expect(result.destinations).toEqual([]);
  });

  it('marks tied structural evidence as ambiguous for human review', () => {
    const result = recommendFeedUse({
      name: 'Mixto.xlsx',
      text: '',
      tables: [
        {
          name: 'Sin separar',
          rows: [['Nombre', 'Correo', 'Tarea', 'Vencimiento']],
        },
      ],
    });

    expect(result.tables[0]).toMatchObject({
      kind: 'general',
      areas: [],
      ambiguous: true,
    });
    expect(result.tables[0]?.reasons[0]).toContain('coinciden por igual');
  });
});
