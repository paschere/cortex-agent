import { describe, expect, it } from 'vitest';
import {
  TransientActionError,
  backoffMs,
  evaluateConditions,
  isTransient,
  renderTemplate,
  renderValues,
  scheduleDue,
  scheduleSlotStart,
  simulateRule,
} from '../engine';
import {
  AUTOMATION_MAX_DEPTH,
  type AutomationEvent,
  automationIdempotencyKey,
  fieldChanged,
  matchesTrigger,
  mayFire,
} from '../match';
import { type AutomationInput, automationInputSchema, structuralProblems } from '../spec';
import { AUTOMATION_TEMPLATES } from '../templates';

const tracker = {
  slug: 'guias',
  name: 'Guías',
  fields: [
    { key: 'numero_guia', label: 'Número de guía', type: 'text', required: true },
    { key: 'estado', label: 'Estado', type: 'text', required: false },
    { key: 'peso', label: 'Peso', type: 'number', required: false },
  ],
} as never;

function ev(partial: Partial<AutomationEvent> = {}): AutomationEvent {
  return {
    kind: 'row_updated',
    rowId: 'r1',
    before: { numero_guia: '045', estado: 'Pendiente', peso: 10 },
    after: { numero_guia: '045', estado: 'Aprobada', peso: 12 },
    label: '045',
    version: '2026-10-07T10:00:00.000Z',
    actor: { kind: 'member', id: 'u1' },
    chain: [],
    depth: 0,
    ...partial,
  };
}

describe('variables {{campo}}', () => {
  const ctx = {
    after: { numero_guia: '045', estado: 'Aprobada' },
    before: { estado: 'Pendiente' },
    label: 'Guía 045',
    appName: 'Planta',
    link: 'https://x.co/a/1',
    reason: 'Foto borrosa',
    labels: { numero_guia: 'Número de guía' },
  };
  it('pinta campos, antes.campo, nombre, app, enlace y motivo', () => {
    expect(
      renderTemplate(
        '{{nombre}}: {{estado}} (antes {{antes.estado}}) en {{app}} {{enlace}} — {{motivo}}',
        ctx,
      ),
    ).toBe('Guía 045: Aprobada (antes Pendiente) en Planta https://x.co/a/1 — Foto borrosa');
  });
  it('acepta la etiqueta del campo y deja vacío lo desconocido', () => {
    expect(renderTemplate('{{Número de guía}}|{{no_existe}}|{{antes.nada}}', ctx)).toBe('045||');
  });
  it('renderValues conserva números y convierte una sola variable numérica', () => {
    expect(
      renderValues(
        { n: 5, peso: '{{peso}}', t: 'Guía {{numero_guia}}' },
        { after: { peso: 12, numero_guia: 'A' } },
      ),
    ).toEqual({ n: 5, peso: 12, t: 'Guía A' });
  });
});

describe('disparadores', () => {
  it('row_updated con campo y «pasó a»', () => {
    const t = { type: 'row_updated', tracker: 'guias', field: 'estado', to: 'aprobada' } as const;
    expect(matchesTrigger(t, ev(), 'guias')).toBe(true);
    expect(matchesTrigger({ ...t, to: 'Rechazada' }, ev(), 'guias')).toBe(false);
    // el campo no cambió
    expect(
      matchesTrigger(
        t,
        ev({ after: { numero_guia: '045', estado: 'Pendiente', peso: 99 } }),
        'guias',
      ),
    ).toBe(false);
  });
  it('otra tabla o otro tipo no disparan', () => {
    expect(matchesTrigger({ type: 'row_updated', tracker: 'otra' }, ev(), 'guias')).toBe(false);
    expect(matchesTrigger({ type: 'row_created', tracker: 'guias' }, ev(), 'guias')).toBe(false);
  });
  it('approval_decided respeta aprobado/rechazado', () => {
    const e = ev({ kind: 'approval_decided', decision: 'rejected' });
    expect(
      matchesTrigger(
        { type: 'approval_decided', tracker: 'guias', decision: 'rejected' },
        e,
        'guias',
      ),
    ).toBe(true);
    expect(
      matchesTrigger(
        { type: 'approval_decided', tracker: 'guias', decision: 'approved' },
        e,
        'guias',
      ),
    ).toBe(false);
    expect(
      matchesTrigger({ type: 'approval_decided', tracker: 'guias', decision: 'any' }, e, 'guias'),
    ).toBe(true);
  });
  it('form_submitted por pantalla y bloque; button por pantalla e id', () => {
    const f = ev({ kind: 'form_submitted', screen: 'registrar', blockId: 'form1' });
    expect(
      matchesTrigger({ type: 'form_submitted', tracker: 'guias', screen: 'registrar' }, f, 'guias'),
    ).toBe(true);
    expect(
      matchesTrigger({ type: 'form_submitted', tracker: 'guias', screen: 'otra' }, f, 'guias'),
    ).toBe(false);
    expect(
      matchesTrigger({ type: 'form_submitted', tracker: 'guias', block: 'form2' }, f, 'guias'),
    ).toBe(false);
    const b = ev({ kind: 'button', screen: 'tablero', buttonId: 'enviar' });
    expect(
      matchesTrigger({ type: 'button', screen: 'tablero', id: 'enviar', label: 'x' }, b, null),
    ).toBe(true);
    expect(
      matchesTrigger({ type: 'button', screen: 'tablero', id: 'otro', label: 'x' }, b, null),
    ).toBe(false);
  });
  it('fieldChanged compara antes y después', () => {
    expect(fieldChanged(ev(), 'estado')).toBe(true);
    expect(fieldChanged(ev(), 'numero_guia')).toBe(false);
  });
});

describe('condiciones', () => {
  const now = new Date('2026-10-07T15:00:00Z');
  it('usa los filtros de las vistas', () => {
    expect(
      evaluateConditions([{ field: 'peso', op: 'gt', value: 10 }], ev(), tracker, now).ok,
    ).toBe(true);
    const r = evaluateConditions([{ field: 'peso', op: 'gt', value: 50 }], ev(), tracker, now);
    expect(r.ok).toBe(false);
    expect(r.failed).toContain('peso');
  });
  it('«cambió de X a Y»', () => {
    const ok = [{ type: 'changed', field: 'estado', from: 'pendiente', to: 'Aprobada' }] as const;
    expect(evaluateConditions([...ok], ev(), tracker, now).ok).toBe(true);
    expect(
      evaluateConditions(
        [{ type: 'changed', field: 'estado', from: 'Rechazada' }],
        ev(),
        tracker,
        now,
      ).ok,
    ).toBe(false);
    expect(
      evaluateConditions([{ type: 'changed', field: 'numero_guia' }], ev(), tracker, now).ok,
    ).toBe(false);
  });
});

describe('sin bucles, idempotencia', () => {
  it('una regla no entra dos veces en la cadena y la profundidad tiene tope', () => {
    expect(mayFire('a', { chain: [], depth: 0 })).toBe(true);
    expect(mayFire('a', { chain: ['a'], depth: 1 })).toBe(false);
    expect(mayFire('a', { chain: ['b', 'c'], depth: AUTOMATION_MAX_DEPTH })).toBe(false);
    expect(mayFire('a', { chain: ['b'], depth: AUTOMATION_MAX_DEPTH - 1 })).toBe(true);
  });
  it('la clave es regla + tipo + fila + versión', () => {
    const k = automationIdempotencyKey('auto1', ev());
    expect(k).toBe('auto1:row_updated:r1:2026-10-07T10:00:00.000Z');
    expect(automationIdempotencyKey('auto1', ev({ version: 'otra' }))).not.toBe(k);
    expect(automationIdempotencyKey('auto2', ev())).not.toBe(k);
  });
});

describe('horarios en hora de Bogotá', () => {
  const daily = { type: 'schedule', cadence: 'daily', hour: 7 } as const;
  it('la franja diaria de las 7:00 Bogotá es 12:00 UTC', () => {
    expect(scheduleSlotStart(daily, new Date('2026-10-07T12:30:00Z')).toISOString()).toBe(
      '2026-10-07T12:00:00.000Z',
    );
    // antes de la hora: la franja es la de ayer
    expect(scheduleSlotStart(daily, new Date('2026-10-07T11:59:00Z')).toISOString()).toBe(
      '2026-10-06T12:00:00.000Z',
    );
  });
  it('toca una vez por franja', () => {
    const now = new Date('2026-10-07T12:01:00Z');
    const slot = scheduleDue(daily, null, now);
    expect(slot?.toISOString()).toBe('2026-10-07T12:00:00.000Z');
    expect(scheduleDue(daily, slot, new Date('2026-10-07T12:02:00Z'))).toBeNull();
    // una franja de hace días no se recupera
    expect(scheduleDue(daily, null, new Date('2026-10-07T20:00:00Z'))).toBeNull();
  });
  it('semanal: el último lunes a la hora', () => {
    const weekly = { type: 'schedule', cadence: 'weekly', hour: 8, weekday: 1 } as const;
    // 2026-10-07 es miércoles; el lunes fue el 5 (8:00 Bogotá = 13:00 UTC)
    expect(scheduleSlotStart(weekly, new Date('2026-10-07T12:00:00Z')).toISOString()).toBe(
      '2026-10-05T13:00:00.000Z',
    );
    // lunes 12 a las 7:59 Bogotá: todavía la del lunes anterior
    expect(scheduleSlotStart(weekly, new Date('2026-10-12T12:59:00Z')).toISOString()).toBe(
      '2026-10-05T13:00:00.000Z',
    );
    expect(scheduleSlotStart(weekly, new Date('2026-10-12T13:00:00Z')).toISOString()).toBe(
      '2026-10-12T13:00:00.000Z',
    );
  });
});

describe('reintentos', () => {
  it('espera creciente y clasifica lo transitorio', () => {
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
    expect(backoffMs(2)).toBeLessThan(backoffMs(3));
    expect(isTransient(new TransientActionError('x'))).toBe(true);
    expect(isTransient(new Error('fetch failed'))).toBe(true);
    expect(isTransient(new Error('El destino contestó 503.'))).toBe(true);
    expect(isTransient(new Error('La tabla ya no existe.'))).toBe(false);
  });
});

describe('validación estructural y plantillas', () => {
  const base = (over: Partial<AutomationInput>): AutomationInput =>
    automationInputSchema.parse({
      name: 'x',
      trigger: { type: 'row_created', tracker: 'guias' },
      actions: [{ type: 'email', to: ['a@b.co'], subject: 's', body: 'b' }],
      ...over,
    });
  it('un horario no tiene fila: ni condiciones ni set_field ni «creador»', () => {
    const p = structuralProblems(
      base({
        trigger: { type: 'schedule', cadence: 'daily', hour: 7 },
        conditions: [{ field: 'estado', op: 'eq', value: 'x' }],
        actions: [
          { type: 'set_field', field: 'estado', value: 'x' },
          { type: 'notify_app_user', to: 'creator', title: 't' },
        ],
      }),
    );
    expect(p.length).toBeGreaterThanOrEqual(3);
  });
  it('webhook sólo https y correo con destinatario', () => {
    expect(() =>
      automationInputSchema.parse({
        name: 'x',
        trigger: { type: 'row_created', tracker: 'guias' },
        actions: [{ type: 'webhook', url: 'nope' }],
      }),
    ).toThrow();
    expect(
      structuralProblems(
        base({ actions: [{ type: 'webhook', url: 'http://ejemplo.com/hook' }] }),
      ).join(' '),
    ).toContain('https');
    expect(
      structuralProblems(
        base({ actions: [{ type: 'email', to: [], roles: [], subject: 's', body: 'b' }] }),
      ).join(' '),
    ).toContain('al menos');
  });
  it('las cuatro plantillas producen reglas válidas', () => {
    const params = { tracker: 'guias', role: 'supervisor', field: 'estado', value: 'Despachada' };
    for (const t of AUTOMATION_TEMPLATES) {
      const input = automationInputSchema.parse(t.build(params));
      expect(structuralProblems(input)).toEqual([]);
    }
    expect(() => AUTOMATION_TEMPLATES[0]?.build({})).toThrow();
  });
});

describe('simulación sin efectos', () => {
  it('dice qué haría con variables ya pintadas', () => {
    const input = automationInputSchema.parse({
      name: 'x',
      trigger: { type: 'row_updated', tracker: 'guias', field: 'estado', to: 'Aprobada' },
      conditions: [{ field: 'peso', op: 'gt', value: 5 }],
      actions: [{ type: 'notify_app_user', to: 'creator', title: 'Aprobaron {{nombre}}' }],
    });
    const e = ev();
    const sim = simulateRule(
      input,
      e,
      { after: e.after ?? {}, label: '045' },
      tracker,
      new Date(),
      true,
    );
    expect(sim.triggers).toBe(true);
    expect(sim.conditions.ok).toBe(true);
    expect(sim.actions[0]?.summary).toContain('Aprobaron 045');
  });
});
