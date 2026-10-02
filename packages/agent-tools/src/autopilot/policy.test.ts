import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW, fixtureSettings, fixtureTool, mandate } from './autopilot.fixtures';
import { type PolicyContext, decidePlan, effectiveEffect } from './policy';
import type { AutopilotSettings } from './settings';
import type { PlanItem } from './types';

/**
 * LA MATRIZ DE LA POLÍTICA. Cada caso es una fila de la tabla de reglas de
 * policy.ts; el orden de los `it` sigue el orden de las reglas.
 */

function item(over: Partial<PlanItem> = {}): PlanItem {
  return {
    area: 'finanzas',
    title: 'Categorizar 3 movimientos del libro',
    why: '3 movimientos sin categoría.',
    proposedAction: { toolId: 'ledger.categorize_pending', input: {} },
    effect: 'internal_write',
    risk: 'low',
    dedupeKey: `k:${Math.random()}`,
    ...over,
  };
}

const cobro = (over: Partial<PlanItem> = {}) =>
  item({
    area: 'cobro',
    title: 'Cobrar $ 1.000.000 a Coltrans',
    proposedAction: {
      toolId: 'gmail.send_message',
      input: { to: ['cartera@coltrans.co'], subject: 'Saldo pendiente', body: 'Buen día' },
    },
    effect: 'external_message',
    risk: 'medium',
    amount: 1_000_000,
    currency: 'COP',
    ...over,
  });

function ctx(over: Partial<PolicyContext> = {}, settings: Partial<AutopilotSettings> = {}) {
  const base = fixtureSettings();
  return {
    settings: {
      ...base,
      ...settings,
      areaLevels: {
        ...base.areaLevels,
        cobro: 'hacer' as const,
        equipo: 'hacer' as const,
        ...settings.areaLevels,
      },
    },
    mandates: [],
    tool: fixtureTool,
    now: FIXTURE_NOW,
    ...over,
  } satisfies PolicyContext;
}

const one = (i: PlanItem, c: PolicyContext) => {
  const [d] = decidePlan([i], c);
  if (!d) throw new Error('sin decisión');
  return d;
};

describe('política: hacer, preguntar o contar', () => {
  it('1. sin acción propuesta → contar', () => {
    const d = one(item({ proposedAction: null, effect: null }), ctx());
    expect(d.decision).toBe('tell');
  });

  it('1. área en «avisar» → contar, aunque haya acción', () => {
    const d = one(
      item(),
      ctx({}, { areaLevels: { ...fixtureSettings().areaLevels, finanzas: 'avisar' } }),
    );
    expect(d.decision).toBe('tell');
    expect(d.decisionReason).toContain('sólo avisar');
  });

  it('2. herramienta que no existe → contar', () => {
    const d = one(item({ proposedAction: { toolId: 'nadie.sabe', input: {} } }), ctx());
    expect(d.decision).toBe('tell');
  });

  it('3. mover plata → preguntar SIEMPRE: con «hacer», con riesgo bajo y con mandato', () => {
    const pay = item({
      proposedAction: { toolId: 'payments.pay', input: { amount: 1000, currency: 'COP' } },
      effect: 'internal_write',
    });
    const withMandate = ctx({
      mandates: [
        mandate({
          toolPatterns: ['payments.pay'],
          coveredToolIds: ['payments.pay'],
          appliesUnattended: true,
        }),
      ],
    });
    expect(effectiveEffect(pay)).toBe('money');
    expect(one(pay, withMandate).decision).toBe('ask');
    expect(one(pay, withMandate).decisionReason).toContain('nunca lo hago solo');
    // Aunque el recolector lo declare interno y la configuración diga hacer.
    const declared = item({ effect: 'money' });
    expect(one(declared, ctx()).decision).toBe('ask');
  });

  it('4. área en «proponer» → preguntar', () => {
    const d = one(
      item(),
      ctx({}, { areaLevels: { ...fixtureSettings().areaLevels, finanzas: 'proponer' } }),
    );
    expect(d.decision).toBe('ask');
  });

  it('5. riesgo alto → preguntar', () => {
    expect(one(item({ risk: 'high' }), ctx()).decision).toBe('ask');
  });

  it('6. correo a un cliente sin mandato → preguntar, con el correo listo', () => {
    const d = one(cobro(), ctx());
    expect(d.decision).toBe('ask');
    // gmail.send_message es un envío externo (security/policy.ts): la capa de
    // seguridad no lo deja salir sin nadie mirando, y eso se dice primero.
    expect(d.decisionReason).toContain('sin nadie mirando');
  });

  it('6. con mandato que sólo vale con alguien en la conversación → preguntar y nombrarlo', () => {
    const d = one(cobro(), ctx({ mandates: [mandate()] }));
    expect(d.decision).toBe('ask');
    expect(d.decisionReason).toContain('sin nadie mirando');
  });

  it('6. ni un mandato que vale sin nadie mirando saca un correo a un cliente: se pregunta', () => {
    // La promesa de 0099: ningún correo a un cliente sale desatendido. El
    // piloto sigue la misma regla que runTool, así que con el envío marcado
    // como externo, el mandato desatendido no alcanza.
    const grant = mandate({ appliesUnattended: true });
    const d = one(cobro(), ctx({ mandates: [grant] }));
    expect(d.decision).toBe('ask');
    expect(d.authority).toBeNull();
  });

  it('6. si la doctrina lo bloquea sin nadie mirando, ni un mandato desatendido lo hace', () => {
    const send = cobro({
      proposedAction: {
        toolId: 'outlook.send_draft',
        input: { draftId: 'd1', to: ['cartera@coltrans.co'] },
      },
    });
    const grant = mandate({
      toolPatterns: ['outlook.send_draft'],
      coveredToolIds: ['outlook.send_draft'],
      appliesUnattended: true,
    });
    const d = one(send, ctx({ mandates: [grant] }));
    expect(d.decision).toBe('ask');
    expect(d.authority).toBeNull();
  });

  it('6. tope de mensajes en cero → preguntar, con esa razón', () => {
    const d = one(cobro(), ctx({}, { maxExternalMessages: 0 }));
    expect(d.decision).toBe('ask');
    expect(d.decisionReason).toContain('no deja salir mensajes');
  });

  it('7. interna y rutinaria de riesgo bajo → hacer, por la regla de lo rutinario', () => {
    const d = one(item(), ctx());
    expect(d.decision).toBe('do');
    expect(d.authority).toBe('routine');
    expect(d.mandateId).toBeNull();
  });

  it('7. atar un pago (pide confirmación por sí misma) también es rutinario', () => {
    const d = one(
      item({
        area: 'conciliacion',
        proposedAction: {
          toolId: 'payments.apply_to_invoice',
          input: { paymentId: 'p', invoiceKind: 'document', invoiceId: 'i' },
        },
        amount: 500_000,
        currency: 'COP',
      }),
      ctx(),
    );
    expect(d.decision).toBe('do');
  });

  it('7. rutinaria pero de riesgo medio → preguntar', () => {
    expect(one(item({ risk: 'medium' }), ctx()).decision).toBe('ask');
  });

  it('7. interna NO rutinaria sin mandato → preguntar; con mandato desatendido → hacer', () => {
    const assign = item({
      area: 'equipo',
      proposedAction: { toolId: 'work.assign', input: { itemIds: ['a'], person: 'Andrés' } },
      risk: 'medium',
    });
    expect(one(assign, ctx()).decision).toBe('ask');
    const grant = mandate({
      id: '99999999-0000-4000-8000-000000000002',
      label: 'Repartir trabajo',
      toolPatterns: ['work.assign'],
      coveredToolIds: ['work.assign'],
      appliesUnattended: true,
    });
    const d = one(assign, ctx({ mandates: [grant] }));
    expect(d.decision).toBe('do');
    expect(d.authority).toBe('mandate');
    expect(d.mandateId).toBe(grant.id);
    expect(d.decisionReason).toContain('«Repartir trabajo»');
    // El mismo mandato sin `applies_unattended`: no cubre la mañana.
    expect(one(assign, ctx({ mandates: [{ ...grant, appliesUnattended: false }] })).decision).toBe(
      'ask',
    );
    // Sin presupuesto de usos del día: tampoco.
    expect(
      one(assign, ctx({ mandates: [{ ...grant, maxUsesPerDay: 1, usesToday: 1 }] })).decision,
    ).toBe('ask');
  });

  it('8. tope de acciones por corrida: lo que no cabe se pregunta', () => {
    const items = [item(), item(), item()];
    const out = decidePlan(items, ctx({}, { maxActionsPerRun: 2 }));
    expect(out.map((d) => d.decision)).toEqual(['do', 'do', 'ask']);
    expect(out[2]?.decisionReason).toContain('tope');
  });

  it('8. tope de plata mencionada: lo que lo pasaría se pregunta; las de más plata van primero', () => {
    const big = item({ amount: 15_000_000, currency: 'COP', dedupeKey: 'big' });
    const small = item({ amount: 6_000_000, currency: 'COP', dedupeKey: 'small' });
    const out = decidePlan([small, big], ctx({}, { maxAmountReferenced: 20_000_000 }));
    const byKey = new Map(out.map((d) => [d.dedupeKey, d.decision]));
    expect(byKey.get('big')).toBe('do');
    expect(byKey.get('small')).toBe('ask');
  });

  it('8. otra moneda que la del tope → preguntar (no se comparan monedas)', () => {
    const d = one(item({ amount: 100, currency: 'USD' }), ctx());
    expect(d.decision).toBe('ask');
    expect(d.decisionReason).toContain('monedas distintas');
  });

  it('lo ya gastado hoy cuenta contra los topes', () => {
    const d = one(item(), ctx({ spentToday: { actions: 25, externalMessages: 0, amount: 0 } }));
    expect(d.decision).toBe('ask');
  });
});
