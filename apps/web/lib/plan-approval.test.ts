import { describe, expect, it } from 'vitest';
import { isControlHandoffMessage } from './confirmation-notes';
import { planApprovalMessage, planApprovalModel, planNeedsApproval } from './plan-approval';
import { planFromInvocations, planToolIds } from './plan-state';

const plan = planFromInvocations([
  {
    toolCallId: 'p1',
    toolName: 'cortex_plan',
    state: 'result',
    result: {
      title: 'Armar clientes',
      steps: [
        {
          id: '1',
          label: 'Crear la tabla',
          what: 'Crea Clientes',
          tools: ['trackers.define'],
          status: 'done',
        },
        {
          id: '2',
          label: 'Cargar filas',
          tools: ['trackers.upsert', 'trackers.upsert'],
          status: 'pending',
        },
        { id: '3', label: 'Avisar', tools: ['gmail.send_message', 'x'], status: 'pending' },
        { id: '4', label: 'Leer', status: 'pending' },
      ],
    },
  },
]);

describe('el plan con herramientas', () => {
  it('conserva tools/what y sólo cuenta las de los pasos que faltan', () => {
    expect(plan?.steps[0]?.what).toBe('Crea Clientes');
    expect(plan && planToolIds(plan)).toEqual(['trackers.upsert', 'gmail.send_message']);
    expect(planNeedsApproval(plan)).toBe(true);
  });
  it('un plan sin herramientas no necesita aprobación', () => {
    const p = planFromInvocations([
      {
        toolCallId: 'a',
        toolName: 'cortex_plan',
        state: 'result',
        result: { title: 'Leer', steps: [{ id: '1', label: 'Leer' }] },
      },
    ]);
    expect(planNeedsApproval(p)).toBe(false);
  });
});

describe('planApprovalModel', () => {
  it('marca qué pasos seguirán preguntando según el alcance del servidor', () => {
    if (!plan) throw new Error('plan');
    const model = planApprovalModel(plan, {
      grantable: ['trackers.upsert'],
      alwaysAsk: ['gmail.send_message'],
    });
    expect(model.coveredCount).toBe(1);
    expect(model.askingCount).toBe(1);
    expect(model.steps.map((s) => s.asksAnyway)).toEqual([false, false, true, false]);
    expect(model.steps[2]?.tools[0]).toMatchObject({ covered: false });
    expect(model.steps[1]?.tools[0]).toMatchObject({ covered: true, label: 'Anotar en la tabla' });
  });
  it('mientras el servidor no responde nada se promete', () => {
    if (!plan) throw new Error('plan');
    const model = planApprovalModel(plan, null);
    expect(model.steps.flatMap((s) => s.tools).every((t) => t.covered === null)).toBe(true);
  });
});

describe('el mensaje de aprobación', () => {
  it('es una señal de control y dice lo que sigue preguntando', () => {
    const text = planApprovalMessage('Armar clientes', {
      grantable: ['trackers.upsert'],
      alwaysAsk: ['gmail.send_message'],
    });
    expect(isControlHandoffMessage(text)).toBe(true);
    expect(text).toContain('Anotar en la tabla');
    expect(text).toContain('sigues preguntando');
  });
});
