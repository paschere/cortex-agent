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

describe('textos más largos que el esquema (ask_choice en producción)', () => {
  const schema = {
    type: 'object',
    properties: {
      question: { type: 'string', maxLength: 180 },
      options: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', maxLength: 64 },
            detail: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
  };

  it('recorta la pregunta y las opciones en vez de tumbar el turno', () => {
    const question = `La carpeta mezcla formularios DIAN de descargue con manifiestos de aerolínea y prealertas sueltas, y el vuelo/fecha están en el nombre de la subcarpeta más que en cada documento. ¿Cómo prefieres que arme la propuesta?`;
    const raw = JSON.stringify({
      question,
      options: Array.from({ length: 7 }, (_, i) => ({ label: `Opción ${i} ${'x'.repeat(80)}` })),
    });
    const fixed = repairArgs(raw, schema) as {
      question: string;
      options: Array<{ label: string }>;
    };
    expect(fixed.question.length).toBeLessThanOrEqual(180);
    expect(fixed.question.endsWith('…')).toBe(true);
    expect(fixed.options).toHaveLength(5);
    for (const o of fixed.options) expect(o.label.length).toBeLessThanOrEqual(64);
  });

  it('lo que ya cabe no se toca', () => {
    expect(repairArgs(JSON.stringify({ question: '¿Cuál?', options: [] }), schema)).toBeNull();
  });
});
