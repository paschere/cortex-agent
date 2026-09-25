import { describe, expect, it } from 'vitest';
import { repairArgs } from './tool-call-repair';

const askChoice = {
  properties: {
    question: { type: 'string' },
    options: { type: 'array' },
  },
};

describe('argumentos rotos que no deben tumbar el turno', () => {
  it('el caso visto en producción: parámetros XML filtrados dentro de options', () => {
    const raw = JSON.stringify({
      question: '¿Qué campos debe tener cada factura en la tabla?',
      options: '\n<parameter name="label">Básico: número, cliente, monto, fecha, estado',
      detail: 'Estado: pendiente/pagada/vencida',
    });
    expect(repairArgs(raw, askChoice)).toEqual({
      question: '¿Qué campos debe tener cada factura en la tabla?',
      options: [
        {
          label: 'Básico: número, cliente, monto, fecha, estado',
          detail: 'Estado: pendiente/pagada/vencida',
        },
      ],
    });
  });

  it('un arreglo que llegó como string JSON se parsea', () => {
    const raw = JSON.stringify({
      question: '¿Cuál?',
      options: '[{"label":"A"},{"label":"B"}]',
    });
    expect(repairArgs(raw, askChoice)?.options).toEqual([{ label: 'A' }, { label: 'B' }]);
  });

  it('números y booleanos en texto se convierten', () => {
    const out = repairArgs(JSON.stringify({ limit: '20', rotate: 'true' }), {
      properties: { limit: { type: 'integer' }, rotate: { type: 'boolean' } },
    });
    expect(out).toEqual({ limit: 20, rotate: true });
  });

  it('si no hay nada que arreglar, devuelve null y no inventa', () => {
    expect(repairArgs(JSON.stringify({ question: '¿Cuál?', options: [] }), askChoice)).toBeNull();
    expect(repairArgs('esto no es json', askChoice)).toBeNull();
  });
});
