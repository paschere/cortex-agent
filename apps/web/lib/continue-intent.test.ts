import { describe, expect, it } from 'vitest';
import {
  continuationBlock,
  followOnBlock,
  isContinuationMessage,
  planFromStoredResults,
} from './continue-intent';

const plan = {
  toolCallId: 'p1',
  toolName: 'cortex_plan',
  result: {
    title: 'App de prealertas',
    steps: [
      { id: 's1', label: 'Crear tabla', status: 'done' },
      { id: 's2', label: 'Crear vista', status: 'pending' },
      { id: 's3', label: 'Diseñar la app', status: 'pending' },
    ],
  },
};

describe('palabras de «continúa»', () => {
  it('reconoce las del caso de producción y sus variantes', () => {
    for (const t of [
      'va',
      'Va!',
      'continua',
      'continúa',
      'sigue',
      'dale',
      'ok',
      'listo',
      'hágale',
      'adelante',
      'sí',
      'si',
      'dale sigue',
      'ok, continúa con eso',
      'sigue con lo que estabas haciendo',
      'daleee',
    ])
      expect(isContinuationMessage(t), t).toBe(true);
  });
  it('no confunde una pregunta o una instrucción con «continúa»', () => {
    for (const t of [
      'no',
      'con eso',
      'por favor',
      '¿cómo va Coltrans?',
      'sigue la tarifa de Nexa y cámbiala a 300',
      'gracias',
      '',
    ])
      expect(isContinuationMessage(t), t).toBe(false);
  });
});

describe('el bloque de continuación', () => {
  it('lleva el plan, lo que falta y lo último dicho; nunca «no tengo contexto»', () => {
    const block = continuationBlock({
      lastAssistantText: 'Confirmado: prealertas quedó ampliada.\n\n_Esta respuesta se cortó…_',
      toolResultsOldestFirst: [[plan]],
    });
    expect(block).toContain('App de prealertas');
    expect(block).toContain('[hecho] s1');
    expect(block).toContain('Falta: s2, s3');
    expect(block).toContain('Confirmado: prealertas quedó ampliada');
    expect(block).toContain('NO le preguntes');
  });
  it('sin plan ni texto, lo dice sin inventar', () => {
    expect(continuationBlock({ lastAssistantText: '', toolResultsOldestFirst: [] })).toContain(
      'No hay trabajo pendiente visible',
    );
  });
  it('el plan se reconstruye con sus actualizaciones a lo largo de varias respuestas', () => {
    const update = {
      toolCallId: 'p2',
      toolName: 'cortex_plan_update',
      result: { updates: [{ id: 's2', status: 'done' }] },
    };
    const state = planFromStoredResults([[plan], [update]]);
    expect(state?.steps.map((s) => s.status)).toEqual(['done', 'done', 'pending']);
  });
});

describe('qué se pega según el mensaje', () => {
  const rows = [
    {
      content: 'Confirmado.',
      tool_results: [
        { toolCallId: 't1', toolName: 'trackers_define', result: { slug: 'prealertas', id: 'x1' } },
      ],
    },
    { content: 'Voy a diseñar', tool_results: [plan] },
  ];
  it('tras una aprobación: lo ejecutado y el plan con pasos abiertos (plan continuo)', () => {
    const block = followOnBlock('Aprobé y ya se ejecutó. Sigue…', rows, true);
    expect(block).toContain('prealertas');
    expect(block).toContain('Falta: s2, s3');
  });
  it('tras un «va»: el bloque completo', () => {
    expect(followOnBlock('va', rows, false)).toContain('Falta: s2, s3');
  });
  it('un mensaje normal no recibe nada', () => {
    expect(followOnBlock('¿cuánto vendimos?', rows, false)).toBe('');
    expect(followOnBlock('va', [], false)).toBe('');
  });
});
