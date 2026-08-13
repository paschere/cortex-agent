import { proposalSchema } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import type { ProposedStep } from './browser-shape';
import {
  type ProposedVariable,
  canBeOptional,
  canMoveDown,
  canMoveUp,
  canRemove,
  checkProposal,
  checkSteps,
  holesIn,
  isAnchor,
  markStepAsFixed,
  markStepAsVariable,
  moveStep,
  pruneVariables,
  removeStep,
  renameStep,
  setStepOptional,
  variableNameFrom,
  whyPinned,
  withoutNulls,
} from './browser-steps';

/**
 * Las reglas de la edición de pasos, que son las mismas en la pantalla y en la
 * ruta que guarda.
 *
 * The two that earn their keep here are the anchor and the null. The anchor
 * because every rule about it is a rule about something that cannot be seen
 * failing until a run opens a blank page and clicks on nothing; the null
 * because `JSON.stringify` keeps it and `.optional()` rejects it, which is a
 * 400 with no field named in it and a screen that looks broken for no reason.
 */

function step(over: Partial<ProposedStep> = {}): ProposedStep {
  return { action: 'click', label: 'Hacer algo', targets: [], landmarks: [], ...over };
}

const goto = step({ action: 'goto', label: 'Abrir el portal', url: 'https://runt.gov.co' });

function variable(over: Partial<ProposedVariable> = {}): ProposedVariable {
  return { name: 'placa', label: 'Placa del vehículo', example: 'ABC123', required: true, ...over };
}

describe('el arranque', () => {
  const steps = [goto, step({ label: 'Escribir la placa' }), step({ label: 'Consultar' })];

  it('es un goto en la primera posición y nada más', () => {
    expect(isAnchor(steps, 0)).toBe(true);
    expect(isAnchor(steps, 1)).toBe(false);
    expect(isAnchor([step(), goto], 1)).toBe(false);
  });

  it('no se mueve, no se borra y no puede ser opcional', () => {
    expect(canMoveUp(steps, 0)).toBe(false);
    expect(canMoveDown(steps, 0)).toBe(false);
    expect(canRemove(steps, 0)).toBe(false);
    expect(canBeOptional(steps, 0)).toBe(false);
    expect(moveStep(steps, 0, 'down')).toBe(steps);
    expect(removeStep(steps, 0)).toBe(steps);
    expect(setStepOptional(steps, 0, true)[0]?.optional).toBeUndefined();
  });

  it('no deja que nada se le suba encima', () => {
    expect(canMoveUp(steps, 1)).toBe(false);
    expect(moveStep(steps, 1, 'up')).toBe(steps);
    // El resto sí se reordena entre sí.
    expect(canMoveUp(steps, 2)).toBe(true);
    expect(moveStep(steps, 2, 'up').map((s) => s.label)).toEqual([
      'Abrir el portal',
      'Consultar',
      'Escribir la placa',
    ]);
  });

  it('explica por qué la flecha está apagada, y no dice lo mismo en los dos sentidos', () => {
    expect(whyPinned(steps, 0, 'up')).toContain('arranque');
    expect(whyPinned(steps, 1, 'up')).toContain('Nada puede ir antes');
    // Bajar el segundo paso no tiene nada que ver con el arranque.
    expect(whyPinned(steps, 2, 'down')).toBe('Ya es el último.');
  });

  it('sin arranque, el primer paso sí se puede mover y borrar', () => {
    const sinGoto = [step({ label: 'Uno' }), step({ label: 'Dos' })];
    expect(canMoveUp(sinGoto, 1)).toBe(true);
    expect(canRemove(sinGoto, 0)).toBe(true);
    expect(canBeOptional(sinGoto, 0)).toBe(true);
  });
});

describe('quitar y reordenar', () => {
  it('quita el paso que sobra y deja el resto en orden', () => {
    const steps = [goto, step({ label: 'Cookies' }), step({ label: 'Consultar' })];
    expect(removeStep(steps, 1).map((s) => s.label)).toEqual(['Abrir el portal', 'Consultar']);
  });

  it('nunca deja la lista vacía', () => {
    const solo = [step({ label: 'Único' })];
    expect(canRemove(solo, 0)).toBe(false);
    expect(removeStep(solo, 0)).toBe(solo);
  });

  it('baja un paso y no se sale del final', () => {
    const steps = [step({ label: 'Uno' }), step({ label: 'Dos' })];
    expect(moveStep(steps, 0, 'down').map((s) => s.label)).toEqual(['Dos', 'Uno']);
    expect(canMoveDown(steps, 1)).toBe(false);
    expect(moveStep(steps, 1, 'down')).toBe(steps);
  });
});

describe('el nombre del paso', () => {
  it('se puede reescribir y se corta en el máximo del esquema', () => {
    const steps = [step({ label: 'Escribir «wikipedia» en el buscador' })];
    expect(renameStep(steps, 0, 'Buscar la placa')[0]?.label).toBe('Buscar la placa');
    expect(renameStep(steps, 0, 'x'.repeat(400))[0]?.label).toHaveLength(200);
  });

  it('un paso sin nombre no se puede guardar', () => {
    const problems = checkSteps([step({ label: '   ' })], []);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.index).toBe(0);
    expect(problems[0]?.message).toContain('sin nombre');
  });
});

describe('marcar el dato que cambia', () => {
  it('reutiliza plantillas y {{huecos}}, y no inventa otro mecanismo', () => {
    const before = {
      steps: [
        goto,
        step({
          action: 'fill',
          label: 'Placa',
          value: { kind: 'literal' as const, text: 'ABC123' },
        }),
      ],
      variables: [] as ProposedVariable[],
      sample: {} as Record<string, string>,
    };
    const after = markStepAsVariable(before, 1, { name: 'placa', label: 'Placa del vehículo' });

    expect(after.steps[1]?.value).toEqual({ kind: 'template', text: '{{placa}}' });
    expect(after.variables).toEqual([
      { name: 'placa', label: 'Placa del vehículo', example: 'ABC123', required: true },
    ]);
    // Lo que se escribió al grabar es lo que se prueba: si no, la corrida de
    // verificación teclea «{{placa}}» dentro del campo.
    expect(after.sample.placa).toBe('ABC123');
  });

  it('nunca toca una credencial', () => {
    const secret = {
      steps: [
        step({
          action: 'fill',
          label: 'Clave',
          value: { kind: 'secret' as const, field: 'clave' },
        }),
      ],
      variables: [],
      sample: {},
    };
    expect(markStepAsVariable(secret, 0, { name: 'clave', label: 'Clave' })).toBe(secret);
  });

  it('volver a fijo devuelve el valor de prueba y deja de declarar el dato', () => {
    const before = {
      steps: [
        step({
          action: 'fill',
          label: 'Placa',
          value: { kind: 'template' as const, text: '{{placa}}' },
        }),
      ],
      variables: [variable()],
      sample: { placa: 'XYZ789' },
    };
    const after = markStepAsFixed(before, 0);
    expect(after.steps[0]?.value).toEqual({ kind: 'literal', text: 'XYZ789' });
    expect(after.variables).toEqual([]);
  });

  it('lee los huecos del valor y también de la dirección', () => {
    expect(holesIn(step({ value: { kind: 'template', text: '{{mes}}/{{anio}}' } }))).toEqual([
      'mes',
      'anio',
    ]);
    expect(holesIn(step({ action: 'goto', url: 'https://x.co/{{nit}}' }))).toEqual(['nit']);
  });

  it('un dato que ya no usa nadie deja de pedirse', () => {
    expect(pruneVariables([variable()], [step()])).toEqual([]);
    expect(
      pruneVariables([variable()], [step({ value: { kind: 'template', text: '{{placa}}' } })]),
    ).toHaveLength(1);
  });

  it('convierte lo que escribió la persona en un nombre que el motor acepta', () => {
    expect(variableNameFrom('Número de placa')).toBe('numero_de_placa');
    expect(variableNameFrom('  ')).toBe('dato');
    expect(variableNameFrom('2024')).toBe('d2024');
    expect(variableNameFrom('Placa', ['placa'])).toBe('placa_2');
  });
});

describe('lo que la ruta rechaza', () => {
  it('un goto que no es el primero', () => {
    const problems = checkSteps([step({ label: 'Uno' }), goto], []);
    expect(problems.map((p) => p.message).join(' ')).toContain(
      'sólo lo puede hacer el primer paso',
    );
  });

  it('un goto marcado como opcional', () => {
    const problems = checkSteps([{ ...goto, optional: true }], []);
    expect(problems.map((p) => p.message).join(' ')).toContain('no puede ser opcional');
  });

  it('un hueco que no corresponde a ningún dato declarado', () => {
    const problems = checkSteps(
      [step({ action: 'fill', label: 'Placa', value: { kind: 'template', text: '{{placa}}' } })],
      [],
    );
    expect(problems[0]?.message).toContain('{{placa}}');
  });

  it('una lista vacía', () => {
    expect(checkSteps([], [])[0]?.message).toContain('al menos un paso');
  });

  it('deja pasar una propuesta bien editada', () => {
    expect(
      checkProposal({
        steps: [
          goto,
          step({
            action: 'fill',
            label: 'Escribir la placa',
            value: { kind: 'template', text: '{{placa}}' },
          }),
          step({ label: 'Cerrar el aviso de cookies', optional: true }),
        ],
        variables: [variable()],
      }),
    ).toEqual([]);
  });
});

describe('null no es «no viene»', () => {
  it('quita los nulos antes de que el esquema los vea', () => {
    const edited = {
      name: 'Consultar placa',
      description: 'Estado del vehículo',
      startUrl: 'https://runt.gov.co',
      effect: 'read',
      variables: [variable()],
      steps: [
        { ...goto, value: null, expect: null, optional: null, extractAs: null },
        {
          action: 'fill',
          label: 'Escribir la placa',
          targets: [{ kind: 'label', value: 'Placa', name: null }],
          landmarks: [],
          value: { kind: 'template', text: '{{placa}}' },
          url: null,
        },
      ],
      notes: [],
    };

    // Sin la limpieza, esto es un 400 que no nombra ningún campo.
    expect(proposalSchema.safeParse(edited).success).toBe(false);

    const cleaned = proposalSchema.safeParse(withoutNulls(edited));
    expect(cleaned.success).toBe(true);
    expect(cleaned.success && cleaned.data.steps[0]).not.toHaveProperty('value');
  });
});
