import { describe, expect, it } from 'vitest';
import { repairStructuredText, unwrapNesting } from '../structured';

/**
 * Las cargas de estas pruebas NO son inventadas: son la forma exacta que
 * devolvió `claude-sonnet-5` contra la API real el 17-08-2026, en las doce
 * llamadas que se hicieron para diagnosticar por qué la orquestación no llegaba
 * nunca a un plan. Importa que sean reales: un reparador probado contra la
 * equivocación que uno IMAGINA que comete el modelo es un reparador que no
 * repara nada el día que hace falta.
 */

/** Lo que de verdad llegó: el objeto entero, serializado, dentro de `tasks`. */
const REAL = JSON.stringify({
  tasks: JSON.stringify({
    tasks: [
      {
        title: 'Identificar competidores principales',
        agentLabel: 'Investigador',
        instruction: 'Busca en la web los tres operadores logísticos…',
        dependsOn: [],
        allowedTools: ['web.search'],
      },
      {
        title: 'Comparar contra nuestra operación',
        agentLabel: 'Analista',
        instruction: 'Contrasta lo anterior con lo que hay en el cerebro…',
        dependsOn: [1],
        allowedTools: ['kb.search'],
      },
    ],
  }),
});

describe('repairStructuredText — la equivocación medida', () => {
  it('saca el plan de la cadena y deja un objeto que el esquema acepta', () => {
    const out = repairStructuredText(REAL, ['tasks']);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    expect(Array.isArray(parsed.tasks)).toBe(true);
    expect(parsed.tasks).toHaveLength(2);
    // El contenido tiene que sobrevivir entero: lo que estaba mal era el
    // envoltorio, y un reparador que pierda una dependencia por el camino
    // cambia un fallo ruidoso por un plan sutilmente equivocado.
    expect(parsed.tasks[1].dependsOn).toEqual([1]);
    expect(parsed.tasks[0].allowedTools).toEqual(['web.search']);
  });

  it('aplana el anidamiento bajo la propia clave', () => {
    const out = repairStructuredText(JSON.stringify({ tasks: { tasks: [{ title: 'x' }] } }), [
      'tasks',
    ]);
    expect(JSON.parse(out as string).tasks).toEqual([{ title: 'x' }]);
  });

  it('desenvuelve una clave envolvente con otro nombre', () => {
    const out = repairStructuredText(JSON.stringify({ result: { tasks: [{ title: 'x' }] } }), [
      'tasks',
    ]);
    expect(JSON.parse(out as string).tasks).toEqual([{ title: 'x' }]);
  });

  it('repara varias claves de un esquema con más de un campo', () => {
    const raw = JSON.stringify({
      verdict: 'deliver',
      sources: JSON.stringify([{ title: 'a', url: '' }]),
    });
    const out = repairStructuredText(raw, ['verdict', 'deliverable', 'sources']);
    const parsed = JSON.parse(out as string);
    expect(parsed.verdict).toBe('deliver');
    expect(parsed.sources).toEqual([{ title: 'a', url: '' }]);
  });
});

describe('repairStructuredText — cuándo NO toca nada', () => {
  it('devuelve null si ya venía bien, para no gastar un reparo que no hace falta', () => {
    expect(repairStructuredText(JSON.stringify({ tasks: [{ title: 'x' }] }), ['tasks'])).toBeNull();
  });

  it('devuelve null ante prosa, que es un fallo distinto y merece su propio mensaje', () => {
    expect(
      repairStructuredText('Necesito saber quiénes son tus competidores antes de planear.', [
        'tasks',
      ]),
    ).toBeNull();
  });

  it('devuelve null ante un JSON cortado por el tope de tokens', () => {
    expect(repairStructuredText('{"tasks":"{\\"tasks\\":[{\\"title\\":\\"a', ['tasks'])).toBeNull();
  });

  /**
   * La guarda que evita que el reparador cause daño. Una instrucción que
   * EMPIEZA por una llave sigue siendo texto que el modelo escribió a propósito,
   * y parsearla la destruiría.
   */
  it('no destruye una cadena legítima que solo parece JSON', () => {
    const raw = JSON.stringify({ tasks: [{ instruction: '{no es json} haz esto' }] });
    expect(repairStructuredText(raw, ['tasks'])).toBeNull();
  });
});

describe('unwrapNesting — el freno', () => {
  it('no se cuelga con un envoltorio absurdamente profundo', () => {
    let v: unknown = [{ title: 'x' }];
    for (let i = 0; i < 12; i++) v = JSON.stringify({ tasks: v });
    // Se rinde por el tope en vez de girar para siempre sobre datos ajenos.
    expect(() => unwrapNesting(v, 'tasks')).not.toThrow();
  });

  it('deja en paz lo que ya es una lista', () => {
    const arr = [{ title: 'x' }];
    expect(unwrapNesting(arr, 'tasks')).toBe(arr);
  });
});
