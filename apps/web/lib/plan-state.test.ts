import { describe, expect, it } from 'vitest';
import { planFromInvocations, planProgress } from './plan-state';

const plan = (id: string, steps: unknown[], title = 'Armar la tabla') => ({
  toolCallId: id,
  toolName: 'cortex_plan',
  state: 'result',
  result: { title, steps },
});
const update = (id: string, body: Record<string, unknown>) => ({
  toolCallId: id,
  toolName: 'cortex.plan_update',
  state: 'result',
  result: body,
});
const S = (id: string, label: string, status = 'pending') => ({ id, label, status });

describe('planFromInvocations', () => {
  it('sin llamadas de plan no hay plan', () => {
    expect(planFromInvocations([])).toBeNull();
    expect(
      planFromInvocations([
        { toolCallId: 'a', toolName: 'kb_search', state: 'result', result: {} },
      ]),
    ).toBeNull();
  });

  it('el plan trae los pasos futuros como pendientes', () => {
    const out = planFromInvocations([
      plan('p1', [S('1', 'Leer'), S('2', 'Crear'), S('3', 'Avisar')]),
    ]);
    expect(out?.title).toBe('Armar la tabla');
    expect(out?.steps.map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
    expect(out?.lastCallId).toBe('p1');
  });

  it('las actualizaciones se pliegan en orden y guardan la nota', () => {
    const out = planFromInvocations([
      plan('p1', [S('1', 'Leer'), S('2', 'Crear'), S('3', 'Avisar')]),
      update('u1', {
        updates: [
          { id: '1', status: 'done' },
          { id: '2', status: 'in_progress' },
        ],
      }),
      update('u2', { updates: [{ id: '2', status: 'failed', note: 'Falta el NIT' }] }),
    ]);
    expect(out?.steps.map((s) => s.status)).toEqual(['done', 'failed', 'pending']);
    expect(out?.steps[1]?.note).toBe('Falta el NIT');
    expect(out?.lastCallId).toBe('u2');
  });

  it('ignora actualizaciones sin plan o sobre ids inexistentes, y agrega pasos nuevos al final', () => {
    expect(
      planFromInvocations([update('u0', { updates: [{ id: '1', status: 'done' }] })]),
    ).toBeNull();
    const out = planFromInvocations([
      plan('p1', [S('1', 'Leer')]),
      update('u1', {
        updates: [{ id: 'zzz', status: 'done' }],
        added: [S('1', 'Repetido'), S('4', 'Extra')],
      }),
    ]);
    expect(out?.steps.map((s) => s.id)).toEqual(['1', '4']);
    expect(out?.steps[0]?.status).toBe('pending');
  });

  it('un plan nuevo reemplaza al anterior', () => {
    const out = planFromInvocations([
      plan('p1', [S('1', 'Viejo')], 'Uno'),
      plan('p2', [S('a', 'Nuevo 1'), S('b', 'Nuevo 2')], 'Dos'),
    ]);
    expect(out?.title).toBe('Dos');
    expect(out?.steps).toHaveLength(2);
  });

  it('descarta resultados con error, en espera de aprobación o sin terminar', () => {
    expect(
      planFromInvocations([
        { ...plan('p1', [S('1', 'Leer')]), result: { __error: 'x' } },
        { ...plan('p2', [S('1', 'Leer')]), state: 'call' },
      ]),
    ).toBeNull();
  });

  it('un estado inválido conserva el anterior', () => {
    const out = planFromInvocations([
      plan('p1', [S('1', 'Leer', 'done')]),
      update('u1', { updates: [{ id: '1', status: 'volando' }] }),
    ]);
    expect(out?.steps[0]?.status).toBe('done');
  });
});

describe('planProgress', () => {
  it('cuenta hechos y detecta el plan cerrado', () => {
    const base = { title: 't', lastCallId: 'x' };
    expect(
      planProgress({
        ...base,
        steps: [
          { id: '1', label: 'a', status: 'done' },
          { id: '2', label: 'b', status: 'in_progress' },
        ],
      }),
    ).toEqual({ done: 1, total: 2, finished: false });
    expect(
      planProgress({
        ...base,
        steps: [
          { id: '1', label: 'a', status: 'done' },
          { id: '2', label: 'b', status: 'skipped' },
        ],
      }),
    ).toEqual({ done: 1, total: 2, finished: true });
  });
});
