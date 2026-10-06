import { checkFormExtras, formBlockSchema } from '@cortex/agent-tools/src/views/spec';
import { describe, expect, it } from 'vitest';
import {
  addStep,
  approvalFieldCandidates,
  approvalStateField,
  askedKeys,
  assignField,
  guessApproval,
  moveKey,
  pruneSteps,
  removeStep,
  startSteps,
  unassigned,
} from './form-options';

const f = (key: string, type = 'text', options?: string[]) =>
  ({ key, label: key, type, required: false, options }) as never;

describe('orden de los campos', () => {
  it('vacío = todos; mover no muta', () => {
    expect(askedKeys([], [{ key: 'a' }, { key: 'b' }])).toEqual(['a', 'b']);
    const l = ['a', 'b', 'c'];
    expect(moveKey(l, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(l).toEqual(['a', 'b', 'c']);
  });
});

describe('pasos', () => {
  const asked = ['a', 'b', 'c', 'd'];
  it('arranca con todo en un paso y se parte', () => {
    const s = addStep(startSteps(asked), 'c');
    expect(s).toEqual([
      { title: 'Paso 1', fields: ['a', 'b', 'd'] },
      { title: 'Paso 2', fields: ['c'] },
    ]);
  });
  it('un campo en un solo paso; un paso no queda vacío', () => {
    let s = addStep(startSteps(['a', 'b']), 'b');
    s = assignField(s, 'a', 1);
    expect(s).toEqual([{ title: 'Paso 2', fields: ['b', 'a'] }]);
  });
  it('quitar un paso deja sus campos sin paso (van a «Otros datos»)', () => {
    const s = removeStep(addStep(startSteps(asked), 'c'), 1);
    expect(unassigned(s, asked)).toEqual(['c']);
  });
  it('quitar un campo del formulario lo saca de los pasos', () => {
    const s = pruneSteps(
      [
        { title: 'x', fields: ['a'] },
        { title: 'y', fields: ['b', 'c'] },
      ],
      ['b', 'c'],
    );
    expect(s).toEqual([{ title: 'y', fields: ['b', 'c'] }]);
  });
  it('lo que arma pasa el contrato (checkFormExtras)', () => {
    const block = formBlockSchema.parse({
      id: 'f',
      type: 'form',
      tracker: 'tabla',
      title: 'F',
      fields: ['a', 'b', 'c'],
      steps: addStep(startSteps(['a', 'b', 'c']), 'c'),
    });
    const problems: string[] = [];
    checkFormExtras(
      block,
      { slug: 'tabla', name: 'T', fields: [f('a'), f('b'), f('c')] },
      problems,
      'B',
    );
    expect(problems).toEqual([]);
  });
});

describe('aprobación', () => {
  it('sólo sirven selects con tres o más opciones', () => {
    const fields = [f('a'), f('s', 'select', ['x', 'y']), f('e', 'select', ['x', 'y', 'z'])];
    expect(approvalFieldCandidates(fields).map((x) => x.key)).toEqual(['e']);
  });
  it('adivina los tres estados y siempre da tres distintos', () => {
    expect(guessApproval(f('e', 'select', ['Por revisar', 'Aprobado', 'Rechazado']))).toEqual({
      pending: 'Por revisar',
      approved: 'Aprobado',
      rejected: 'Rechazado',
    });
    const g = guessApproval(f('e', 'select', ['uno', 'dos', 'tres']));
    expect(new Set(Object.values(g ?? {})).size).toBe(3);
    expect(guessApproval(f('e', 'select', ['uno', 'dos']))).toBeNull();
  });
  it('el campo Estado que se ofrece crear cumple el contrato', () => {
    const state = approvalStateField(['estado']);
    expect(state.key).toBe('estado_2');
    const block = formBlockSchema.parse({
      id: 'f',
      type: 'form',
      tracker: 'tabla',
      title: 'F',
      approval: {
        field: state.key,
        pending: 'Por revisar',
        approved: 'Aprobado',
        rejected: 'Rechazado',
      },
    });
    const problems: string[] = [];
    checkFormExtras(block, { slug: 'tabla', name: 'T', fields: [state] }, problems, 'B');
    expect(problems).toEqual([]);
  });
});
