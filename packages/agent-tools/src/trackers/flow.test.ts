import { describe, expect, it } from 'vitest';
import {
  buildFlowView,
  checkTransition,
  flowAutomationDrafts,
  flowOf,
  flowProblems,
  flowSchema,
  linearTransitions,
  missingRequirements,
  normalizeFlow,
  transitionHistory,
} from './flow';
import { guardFlowWrite, withFlowActor } from './flow-guard';
import { trackerFieldsSchema } from './schema';

const STATES = ['Recibido', 'En bodega', 'Despachado', 'Entregado'];

const def = flowSchema.parse({
  states: STATES,
  transitions: linearTransitions(STATES).map((t) =>
    t.to === 'Despachado' ? { ...t, roles: ['supervisor'] } : t,
  ),
  requirements: {
    Entregado: [
      { kind: 'photo', field: 'foto' },
      { kind: 'comment', field: 'nota' },
    ],
  },
  notify: { Despachado: { roles: ['cliente'], message: '{{nombre}} salió' } },
});
const flow = normalizeFlow(def);

const FIELDS = [
  { key: 'nombre', label: 'Nombre', type: 'text' },
  { key: 'estado', label: 'Estado', type: 'select', options: STATES, flow: def },
  { key: 'foto', label: 'Foto', type: 'file' },
  { key: 'nota', label: 'Nota', type: 'longtext' },
] as const;
const field = FIELDS[1];

const supervisor = { roles: ['supervisor'], admin: false };
const operario = { roles: ['operario'], admin: false };

function check(
  from: string | null,
  to: string,
  actor = supervisor,
  values: Record<string, unknown> = {},
) {
  return checkTransition({ flow, field, fields: FIELDS, from, to, values, actor });
}

describe('flowSchema', () => {
  it('acepta un flujo lineal con roles y requisitos', () => {
    expect(flow.states).toHaveLength(4);
    expect(flow.transitions.find((t) => t.to === 'Despachado')?.roles).toEqual(['supervisor']);
  });
  it('rechaza saltos a estados que no existen, repetidos o a sí mismos', () => {
    expect(
      flowSchema.safeParse({ states: ['a', 'b'], transitions: [{ from: 'a', to: 'z' }] }).success,
    ).toBe(false);
    expect(
      flowSchema.safeParse({
        states: ['a', 'b'],
        transitions: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'b' },
        ],
      }).success,
    ).toBe(false);
    expect(
      flowSchema.safeParse({ states: ['a', 'b'], transitions: [{ from: 'a', to: 'a' }] }).success,
    ).toBe(false);
    expect(flowSchema.safeParse({ states: ['a', 'a'] }).success).toBe(false);
    expect(flowSchema.safeParse({ states: ['a'] }).success).toBe(false);
  });
  it('rechaza reglas de un estado que no está en el flujo', () => {
    expect(
      flowSchema.safeParse({
        states: ['a', 'b'],
        requirements: { c: [{ kind: 'photo', field: 'foto' }] },
      }).success,
    ).toBe(false);
  });
});

describe('flowProblems / esquema de la tabla', () => {
  it('pide que los estados sean opciones y que los campos de requisito existan con el tipo justo', () => {
    expect(flowProblems(field, flow, FIELDS)).toEqual([]);
    const sinOpciones = { ...field, options: ['Recibido'] };
    expect(flowProblems(sinOpciones, flow, FIELDS).join(' ')).toContain('no es una opción');
    const roto = normalizeFlow(
      flowSchema.parse({
        states: STATES,
        requirements: {
          Entregado: [
            { kind: 'photo', field: 'nota' },
            { kind: 'field', field: 'nada' },
          ],
        },
      }),
    );
    const out = flowProblems(field, roto, FIELDS).join(' ');
    expect(out).toContain('campo de archivo');
    expect(out).toContain('«nada»');
  });
  it('trackerFieldsSchema valida el flujo y descarta `flow` en campos que no son select', () => {
    const ok = trackerFieldsSchema.safeParse([
      { key: 'estado', label: 'Estado', type: 'select', options: STATES, flow: def },
      { key: 'foto', label: 'Foto', type: 'file' },
      { key: 'nota', label: 'Nota', type: 'longtext' },
    ]);
    expect(ok.success).toBe(true);
    const sinOpcion = trackerFieldsSchema.safeParse([
      { key: 'estado', label: 'Estado', type: 'select', options: ['Recibido'], flow: def },
    ]);
    expect(sinOpcion.success).toBe(false);
    const texto = trackerFieldsSchema.parse([{ key: 'a', label: 'A', type: 'text', flow: def }]);
    expect(texto[0]?.flow).toBeUndefined();
  });
});

describe('checkTransition (la guarda)', () => {
  it('quedarse en el mismo estado vale', () => {
    expect(check('Recibido', 'Recibido').ok).toBe(true);
  });
  it('un salto permitido pasa', () => {
    expect(check('Recibido', 'En bodega', operario).ok).toBe(true);
  });
  it('un salto que no existe se rechaza aunque el rol sea el correcto', () => {
    const r = check('Recibido', 'Entregado', supervisor, { foto: 'x', nota: 'y' });
    expect(r.ok).toBe(false);
    expect(r.rule).toBe('not_allowed');
  });
  it('sólo el rol del salto lo hace; el admin pasa siempre', () => {
    const no = check('En bodega', 'Despachado', operario);
    expect(no.ok).toBe(false);
    expect(no.rule).toBe('role');
    expect(check('En bodega', 'Despachado', supervisor).ok).toBe(true);
    expect(check('En bodega', 'Despachado', { roles: [], admin: true }).ok).toBe(true);
  });
  it('fuera de una app (sin roles) no se juzga quién, sí el salto', () => {
    const chat = { roles: [], admin: false, unscoped: true };
    expect(check('En bodega', 'Despachado', chat).ok).toBe(true);
    expect(check('Recibido', 'Despachado', chat).ok).toBe(false);
  });
  it('los requisitos de entrar a un estado se piden y se nombran', () => {
    const r = check('Despachado', 'Entregado', supervisor, {});
    expect(r.ok).toBe(false);
    expect(r.rule).toBe('requirements');
    expect(r.missing).toHaveLength(2);
    expect(r.message).toContain('una foto');
    expect(r.message).toContain('Foto');
    expect(
      check('Despachado', 'Entregado', supervisor, { foto: '[{"url":"/a"}]', nota: 'ok' }).ok,
    ).toBe(true);
  });
  it('una fila nueva sólo nace en el primer estado (el admin, en cualquiera)', () => {
    expect(check(null, 'Recibido').ok).toBe(true);
    expect(check(null, 'Entregado').rule).toBe('initial');
    expect(check(null, 'Entregado', { roles: [], admin: true }, { foto: 'x', nota: 'y' }).ok).toBe(
      true,
    );
  });
  it('un valor viejo fuera del flujo puede entrar a un estado del flujo', () => {
    expect(check('Antiguo', 'En bodega').ok).toBe(true);
  });
  it('un estado inventado se rechaza', () => {
    expect(check('Recibido', 'Volando').rule).toBe('unknown_state');
  });
});

describe('missingRequirements', () => {
  it('lista lo que falta', () => {
    expect(missingRequirements(flow, 'Entregado', { foto: 'x' }).map((r) => r.field)).toEqual([
      'nota',
    ]);
    expect(missingRequirements(flow, 'Recibido', {})).toEqual([]);
  });
});

describe('buildFlowView', () => {
  it('marca hechos, actual y por venir, y ofrece sólo los saltos de la fila', () => {
    const v = buildFlowView({
      flow,
      field,
      fields: FIELDS,
      current: 'En bodega',
      values: {},
      actor: operario,
      writable: true,
    });
    expect(v.steps.map((s) => s.status)).toEqual(['done', 'current', 'todo', 'todo']);
    expect(v.next).toHaveLength(1);
    expect(v.next[0]).toMatchObject({ to: 'Despachado', allowed: false });
    expect(v.next[0]?.reason).toContain('supervisor');
  });
  it('lleva los requisitos con lo que ya está lleno', () => {
    const v = buildFlowView({
      flow,
      field,
      fields: FIELDS,
      current: 'Despachado',
      values: { foto: 'x' },
      actor: supervisor,
      writable: true,
    });
    expect(v.next[0]?.requires.map((r) => [r.field, r.filled])).toEqual([
      ['foto', true],
      ['nota', false],
    ]);
  });
});

describe('transitionHistory / avisos', () => {
  it('saca los saltos de los eventos, del más nuevo al más viejo', () => {
    const h = transitionHistory(
      [
        {
          at: '2026-10-01T10:00:00Z',
          by: 'Ana',
          changes: { estado: { from: 'Recibido', to: 'En bodega' } },
        },
        {
          at: '2026-10-02T10:00:00Z',
          by: 'Luis',
          changes: { estado: { from: 'En bodega', to: 'Despachado' } },
        },
        { at: '2026-10-03T10:00:00Z', by: 'Ana', changes: { nota: { from: null, to: 'x' } } },
      ],
      'estado',
    );
    expect(h.map((e) => e.to)).toEqual(['Despachado', 'En bodega']);
    expect(h[0]).toMatchObject({ by: 'Luis', from: 'En bodega' });
  });
  it('los avisos se arman como automatizaciones de la campana, no como envíos propios', () => {
    const d = flowAutomationDrafts({ tracker: 'envios', trackerName: 'Envíos', field, flow });
    expect(d).toHaveLength(1);
    expect(d[0]?.trigger).toMatchObject({ type: 'row_updated', field: 'estado', to: 'Despachado' });
    expect(d[0]?.actions[0]).toMatchObject({ type: 'notify_member', roles: ['cliente'] });
  });
});

describe('guardFlowWrite (servidor)', () => {
  const tracker = { fields: FIELDS };
  it('una tabla sin flujo no se toca', () => {
    expect(guardFlowWrite({ fields: [FIELDS[0]] }, null, { nombre: 'x' })).toEqual({ nombre: 'x' });
  });
  it('una fila nueva sin estado nace en el primero', () => {
    expect(guardFlowWrite(tracker, null, { nombre: 'x' }).estado).toBe('Recibido');
  });
  it('rechaza un salto prohibido aunque el cliente lo mande', () => {
    expect(() => guardFlowWrite(tracker, { estado: 'Recibido' }, { estado: 'Entregado' })).toThrow(
      /no se puede pasar/,
    );
  });
  it('usa el rol del contexto de la app', async () => {
    await expect(
      withFlowActor(operario, async () =>
        guardFlowWrite(tracker, { estado: 'En bodega' }, { estado: 'Despachado' }),
      ),
    ).rejects.toThrow(/Tu rol/);
    await expect(
      withFlowActor(supervisor, async () =>
        guardFlowWrite(tracker, { estado: 'En bodega' }, { estado: 'Despachado' }),
      ),
    ).resolves.toMatchObject({ estado: 'Despachado' });
  });
  it('flowOf encuentra el campo con flujo', () => {
    expect(flowOf(FIELDS)?.field.key).toBe('estado');
    expect(flowOf([FIELDS[0]])).toBeNull();
  });
});
