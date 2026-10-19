import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../tenancy/scoped-client';
import { getTrackerBySlug, removeRows, upsertRow } from '../../../trackers/store';
import type { ViewRow } from '../../../views/compute';
import { formBlockSchema, rowActionSchema, thenSchema } from '../../../views/spec';
import { emitAutomationEvent, forgetAutomationWatch, withAutomationOrigin } from '../emit';
import {
  type TemplateContext,
  branchDecision,
  evaluateConditions,
  newBranchState,
  previewActions,
  renderRaw,
  renderTemplate,
  renderValues,
  simulateRule,
  waitText,
} from '../engine';
import {
  AUTOMATION_MAX_DEPTH,
  type AutomationEvent,
  automationIdempotencyKey,
  matchesTrigger,
  mayFire,
} from '../match';
import {
  adaptSet,
  applyRelatedPlan,
  applyRollupPlan,
  describeRelatedPlan,
  describeRollupPlan,
  diffValues,
  parentIdsToRecompute,
  planRollup,
  planUpdateRelated,
  planUpdateRows,
  relatedId,
  rollupValue,
  rowMatchesWhere,
  toNumber,
} from '../related';
import { type AutomationDeps, WAIT_PENDING, executeRun } from '../run';
import { simulateAutomation } from '../simulate';
import {
  type AutomationInput,
  automationActionSchema,
  automationInputSchema,
  structuralProblems,
} from '../spec';
import { adaptAutomation, validateAutomation } from '../store';

/**
 * CONEXIÓN DE EVENTOS DENTRO DE LA MISMA APP: filas relacionadas, acumulados,
 * «si» / «si no» por acción, esperas y «se borra una fila». Primero lo puro
 * (aritmética, filtros, ramas, plantillas, anti-bucles) y luego contra una base
 * falsa con las tablas «vuelos» y «equipos» (un vuelo tiene muchos equipos).
 */

const ORG = 'org-a';
const NOW = new Date('2026-10-19T15:00:00.000Z');

// ---------------------------------------------------------------------------
// Puro
// ---------------------------------------------------------------------------

describe('acumulados: rollupValue y toNumber', () => {
  it('suma, conteo, promedio, mínimo y máximo', () => {
    const v = [100, 250, '50', null, '', 'abc'];
    expect(rollupValue('sum', v)).toBe(400);
    expect(rollupValue('count', v)).toBe(6);
    expect(rollupValue('count', v, { hasField: true })).toBe(4);
    expect(rollupValue('avg', [10, 20, 60])).toBe(30);
    expect(rollupValue('min', [5, 2, 9])).toBe(2);
    expect(rollupValue('max', [5, 2, 9])).toBe(9);
  });
  it('sin hijas: la suma es 0 y lo demás queda vacío; el conteo es 0', () => {
    expect(rollupValue('sum', [])).toBe(0);
    expect(rollupValue('count', [])).toBe(0);
    expect(rollupValue('avg', [])).toBeNull();
    expect(rollupValue('min', [])).toBeNull();
    expect(rollupValue('max', [null, ''])).toBeNull();
  });
  it('entiende pesos con símbolos y separadores', () => {
    expect(toNumber('$ 1.500.000')).toBe(1500000);
    expect(toNumber('1.500,25')).toBe(1500.25);
    expect(toNumber('1,500.25')).toBe(1500.25);
    expect(toNumber('12,5')).toBe(12.5);
    expect(toNumber(7)).toBe(7);
    expect(toNumber('')).toBeNull();
    expect(toNumber('-')).toBeNull();
    expect(toNumber('hola')).toBeNull();
  });
  it('rollupValue suma pesos escritos como texto', () => {
    expect(rollupValue('sum', ['$ 1.000', '2.500', 500])).toBe(4000);
  });
});

describe('diffValues y adaptSet', () => {
  it('sólo lo que cambia; igual con 12 y «12»', () => {
    expect(diffValues({ a: 'x', n: 12 }, { a: 'x', n: '12' })).toEqual([]);
    expect(diffValues({ a: 'x' }, { a: 'y' })).toEqual([{ field: 'a', from: 'x', to: 'y' }]);
    expect(diffValues({}, { a: '' })).toEqual([]);
    expect(diffValues({ a: 'x' }, { a: '' })).toEqual([{ field: 'a', from: 'x', to: '' }]);
  });
  it('un número va como texto a un campo de texto; un texto numérico va como número a dinero', () => {
    const fields = [
      { key: 'nota', type: 'text' },
      { key: 'costo', type: 'money' },
      { key: 'ok', type: 'checkbox' },
    ];
    expect(adaptSet(fields, { nota: 5, costo: '1.500', ok: 1 })).toEqual({
      nota: '5',
      costo: 1500,
      ok: 1,
    });
  });
});

describe('filtros con relaciones y plantillas', () => {
  const V1 = '11111111-1111-4111-8111-111111111111';
  const V2 = '22222222-2222-4222-8222-222222222222';
  const tracker = {
    slug: 'equipos',
    name: 'Equipos',
    fields: [
      { key: 'vuelo', label: 'Vuelo', type: 'relation', tracker: 'vuelos', required: false },
      { key: 'estado', label: 'Estado', type: 'text', required: false },
      { key: 'costo', label: 'Costo', type: 'money', required: false },
    ],
  } as never;
  const row = (values: Record<string, string | number>): ViewRow => ({
    id: 'r',
    label: 'Equipo',
    values,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
  const rel = (id: string, label: string) => JSON.stringify({ id, label });
  const ctx: TemplateContext = { after: { vuelo: rel(V1, 'AV204'), estado: 'Listo' } };

  it('compara una relación por ID: acepta el JSON, el id suelto o el nombre', () => {
    const r = row({ vuelo: rel(V1, 'AV204') });
    const f = (value: string) => [{ field: 'vuelo', op: 'eq' as const, value }];
    expect(rowMatchesWhere(tracker, r, f('{{vuelo}}'), ctx, '2026-10-19')).toBe(true);
    expect(rowMatchesWhere(tracker, r, f(V1), ctx, '2026-10-19')).toBe(true);
    expect(rowMatchesWhere(tracker, r, f('av204'), ctx, '2026-10-19')).toBe(true);
    expect(rowMatchesWhere(tracker, r, f(V2), ctx, '2026-10-19')).toBe(false);
    expect(
      rowMatchesWhere(tracker, row({ vuelo: rel(V2, 'LA300') }), f('{{vuelo}}'), ctx, '2026-10-19'),
    ).toBe(false);
  });
  it('filtros normales, con número y con plantilla de texto', () => {
    const r = row({ estado: 'Listo', costo: 2000 });
    expect(
      rowMatchesWhere(tracker, r, [{ field: 'costo', op: 'gt', value: 1000 }], ctx, '2026-10-19'),
    ).toBe(true);
    expect(
      rowMatchesWhere(
        tracker,
        r,
        [{ field: 'estado', op: 'eq', value: '{{estado}}' }],
        ctx,
        '2026-10-19',
      ),
    ).toBe(true);
    expect(
      rowMatchesWhere(tracker, r, [{ field: 'costo', op: 'lt', value: 1000 }], ctx, '2026-10-19'),
    ).toBe(false);
    expect(rowMatchesWhere(tracker, r, [], ctx, '2026-10-19')).toBe(true);
  });
  it('parentIdsToRecompute: el padre de ahora y el de antes si cambió', () => {
    expect(
      parentIdsToRecompute('vuelo', { vuelo: rel(V1, 'a') }, { vuelo: rel(V2, 'b') }).sort(),
    ).toEqual([V1, V2]);
    expect(parentIdsToRecompute('vuelo', { vuelo: rel(V1, 'a') }, { vuelo: rel(V1, 'a') })).toEqual(
      [V1],
    );
    expect(parentIdsToRecompute('vuelo', { vuelo: '' }, null)).toEqual([]);
    expect(relatedId(V1)).toBe(V1);
    expect(relatedId('nada')).toBeNull();
  });
});

describe('plantillas con relaciones', () => {
  const V1 = '11111111-1111-4111-8111-111111111111';
  const rel = JSON.stringify({ id: V1, label: 'AV204' });
  const ctx: TemplateContext = {
    after: { vuelo: rel, peso: 12, nota: '007' },
    label: 'Equipo 1',
    labels: { vuelo: 'Vuelo' },
  };
  it('en un texto una relación se lee por su nombre', () => {
    expect(renderTemplate('Vuelo {{vuelo}} listo', ctx)).toBe('Vuelo AV204 listo');
    expect(renderTemplate('{{Vuelo}}', ctx)).toBe('AV204');
  });
  it('una plantilla de UNA sola variable conserva la relación entera (para copiarla a otra relación)', () => {
    expect(renderRaw('{{vuelo}}', ctx)).toBe(rel);
    expect(renderValues({ vuelo: '{{vuelo}}' }, ctx).vuelo).toBe(rel);
    expect(renderRaw('Vuelo {{vuelo}}', ctx)).toBe('Vuelo AV204');
  });
  it('los números de una sola variable siguen siendo número; lo fijo se queda', () => {
    expect(renderValues({ p: '{{peso}}', q: 5, t: 'fijo' }, ctx)).toEqual({
      p: 12,
      q: 5,
      t: 'fijo',
    });
  });
});

describe('«si» y «si no» por acción', () => {
  const tracker = {
    slug: 'equipos',
    name: 'Equipos',
    fields: [{ key: 'costo', label: 'Costo', type: 'money', required: false }],
  } as never;
  const event = (costo: number): AutomationEvent => ({
    kind: 'row_updated',
    rowId: 'r1',
    before: { costo: 0 },
    after: { costo },
    label: 'E',
    version: 'v',
    actor: { kind: 'member', id: 'u' },
    chain: [],
    depth: 0,
  });
  const caro = [{ field: 'costo', op: 'gt' as const, value: 1000 }];
  const actions = [
    { type: 'set_field', field: 'costo', value: '1', if: caro },
    { type: 'webhook', url: 'https://x.co/h', otherwise: true },
    { type: 'webhook', url: 'https://x.co/siempre' },
  ] as never;

  it('branchDecision: el «si no» corre justo cuando el «si» no se cumplió', () => {
    const run = (costo: number) => {
      const st = newBranchState();
      const ev = event(costo);
      return (actions as Array<Record<string, unknown>>).map(
        (a) => branchDecision(a as never, st, (c) => evaluateConditions(c, ev, tracker, NOW)).run,
      );
    };
    expect(run(5000)).toEqual([true, false, true]);
    expect(run(10)).toEqual([false, true, true]);
  });
  it('un «si no» sin condición anterior no corre', () => {
    const st = newBranchState();
    expect(branchDecision({ otherwise: true }, st, () => ({ ok: true })).run).toBe(false);
  });
  it('la vista previa marca como omitida la rama que no toca, con el motivo', () => {
    const ctx: TemplateContext = { after: { costo: 10 } };
    const prev = previewActions(actions, ctx, { event: event(10), tracker, now: NOW });
    expect(prev.map((p) => Boolean(p.skipped))).toEqual([true, false, false]);
    expect(prev[0]?.summary).toMatch(/No se haría con esta fila/);
    const prev2 = previewActions(
      actions,
      { after: { costo: 5000 } },
      {
        event: event(5000),
        tracker,
        now: NOW,
      },
    );
    expect(prev2.map((p) => Boolean(p.skipped))).toEqual([false, true, false]);
  });
  it('simulateRule usa las ramas y las condiciones de la regla', () => {
    const sim = simulateRule(
      {
        trigger: { type: 'row_updated', tracker: 'equipos' },
        conditions: [],
        actions,
      },
      event(5000),
      { after: { costo: 5000 } },
      tracker,
      NOW,
      true,
    );
    expect(sim.actions[1]?.skipped).toBe(true);
  });
});

describe('forma de la regla (spec)', () => {
  const base = (
    actions: unknown[],
    trigger: unknown = { type: 'row_updated', tracker: 'equipos' },
  ) => automationInputSchema.parse({ name: 'x', trigger, actions }) as AutomationInput;

  it('lo guardado antes sigue siendo válido (sin if, otherwise ni acciones nuevas)', () => {
    const r = automationInputSchema.parse({
      name: 'vieja',
      trigger: { type: 'row_created', tracker: 'guias' },
      actions: [{ type: 'set_field', field: 'estado', value: 'A' }],
    });
    expect(r.actions[0]).toEqual({ type: 'set_field', field: 'estado', value: 'A' });
    expect(structuralProblems(r)).toEqual([]);
  });
  it('update_related pide UNA dirección', () => {
    const none = base([{ type: 'update_related', set: { estado: 'X' } }]);
    expect(structuralProblems(none).join(' ')).toMatch(/UNA dirección/);
    const both = base([
      {
        type: 'update_related',
        up: 'vuelo',
        down: { tracker: 'otra_tabla', via: 'campo' },
        set: { x: 1 },
      },
    ]);
    expect(structuralProblems(both).join(' ')).toMatch(/UNA dirección/);
    const up = base([{ type: 'update_related', up: 'vuelo', set: { estado: 'X' } }]);
    expect(structuralProblems(up)).toEqual([]);
    const upMax = base([{ type: 'update_related', up: 'vuelo', set: { estado: 'X' }, max: 5 }]);
    expect(structuralProblems(upMax).join(' ')).toMatch(/max/);
  });
  it('el tope de filas no pasa de 200', () => {
    expect(
      automationActionSchema.safeParse({
        type: 'update_rows',
        tracker: 'equipos',
        where: [{ field: 'estado', op: 'eq', value: 'x' }],
        set: { estado: 'y' },
        max: 500,
      }).success,
    ).toBe(false);
  });
  it('update_rows exige al menos un filtro', () => {
    expect(
      automationActionSchema.safeParse({
        type: 'update_rows',
        tracker: 'equipos',
        where: [],
        set: { a: 'b' },
      }).success,
    ).toBe(false);
  });
  it('rollup: salvo el conteo, necesita el campo', () => {
    const sum = base([{ type: 'rollup', up: 'vuelo', target: 'total', op: 'sum' }]);
    expect(structuralProblems(sum).join(' ')).toMatch(/necesita `field`/);
    const count = base([{ type: 'rollup', up: 'vuelo', target: 'total', op: 'count' }]);
    expect(structuralProblems(count)).toEqual([]);
  });
  it('«si no» necesita una acción anterior con «si» y no lleva su propio «si»', () => {
    const lone = base([{ type: 'set_field', field: 'a', value: 'b', otherwise: true }]);
    expect(structuralProblems(lone).join(' ')).toMatch(/necesita una acción anterior/);
    const both = base([
      { type: 'set_field', field: 'a', value: 'b', if: [{ field: 'a', op: 'empty' }] },
      {
        type: 'set_field',
        field: 'a',
        value: 'c',
        otherwise: true,
        if: [{ field: 'a', op: 'empty' }],
      },
    ]);
    expect(structuralProblems(both).join(' ')).toMatch(/no lleva su propia condición/);
    const ok = base([
      { type: 'set_field', field: 'a', value: 'b', if: [{ field: 'a', op: 'empty' }] },
      { type: 'set_field', field: 'a', value: 'c', otherwise: true },
    ]);
    expect(structuralProblems(ok)).toEqual([]);
  });
  it('la espera no puede ser lo último ni la única acción; sin fila no hay «seguir si»', () => {
    const last = base([
      { type: 'set_field', field: 'a', value: 'b' },
      { type: 'wait', minutes: 30 },
    ]);
    expect(structuralProblems(last).join(' ')).toMatch(/no puede ser lo último/);
    const only = base([{ type: 'wait', minutes: 30 }]);
    expect(structuralProblems(only).join(' ')).toMatch(/sólo espera/);
    const ok = base([
      { type: 'wait', minutes: 30 },
      { type: 'set_field', field: 'a', value: 'b' },
    ]);
    expect(structuralProblems(ok)).toEqual([]);
    const rowless = base(
      [
        { type: 'wait', minutes: 30, stillIf: [{ field: 'a', op: 'empty' }] },
        { type: 'email', to: ['a@b.co'], subject: 's', body: 'b' },
      ],
      { type: 'schedule', cadence: 'daily', hour: 7 },
    );
    expect(structuralProblems(rowless).join(' ')).toMatch(/sin fila/);
  });
  it('la espera va de 1 minuto a 7 días', () => {
    expect(automationActionSchema.safeParse({ type: 'wait', minutes: 0 }).success).toBe(false);
    expect(automationActionSchema.safeParse({ type: 'wait', minutes: 10081 }).success).toBe(false);
    expect(automationActionSchema.safeParse({ type: 'wait', minutes: 10080 }).success).toBe(true);
    expect(waitText(90)).toBe('90 minutos');
    expect(waitText(120)).toBe('2 horas');
    expect(waitText(1440)).toBe('1 día');
    expect(waitText(1)).toBe('1 minuto');
  });
  it('row_deleted: no cambia un campo de la fila borrada', () => {
    const bad = base([{ type: 'set_field', field: 'a', value: 'b' }], {
      type: 'row_deleted',
      tracker: 'equipos',
    });
    expect(structuralProblems(bad).join(' ')).toMatch(/se borró/);
    const ok = base([{ type: 'rollup', up: 'vuelo', target: 't', op: 'count' }], {
      type: 'row_deleted',
      tracker: 'equipos',
    });
    expect(structuralProblems(ok)).toEqual([]);
  });
  it('el botón puede abrir otra pantalla después', () => {
    const r = automationInputSchema.parse({
      name: 'b',
      trigger: {
        type: 'button',
        screen: 'inicio',
        id: 'nuevo',
        label: 'Nuevo',
        next: { screen: 'nueva_atencion', prefill: { tipo: 'Rápida' } },
      },
      actions: [{ type: 'email', to: ['a@b.co'], subject: 's', body: 'b' }],
    });
    expect((r.trigger as { next?: { screen: string } }).next?.screen).toBe('nueva_atencion');
  });
});

describe('encadenar pantallas en el spec', () => {
  it('thenSchema: pantalla en slug y valores de campos válidos', () => {
    expect(
      thenSchema.safeParse({ screen: 'nueva_atencion', prefill: { vuelo: '{{fila}}' } }).success,
    ).toBe(true);
    expect(thenSchema.safeParse({ screen: 'Mala Pantalla' }).success).toBe(false);
    expect(thenSchema.safeParse({ screen: 'ok', prefill: { 'Campo Malo': 'x' } }).success).toBe(
      false,
    );
  });
  it('un formulario y un botón de fila la aceptan; sin ella todo igual que antes', () => {
    const base = { id: 'f1', type: 'form', tracker: 'vuelos', title: 'Vuelo' };
    const sin = formBlockSchema.parse(base);
    expect(sin.afterSubmit).toBeUndefined();
    const con = formBlockSchema.parse({
      ...base,
      afterSubmit: { screen: 'nueva_atencion', prefill: { vuelo: '{{fila}}' } },
    });
    expect(con.afterSubmit?.screen).toBe('nueva_atencion');
    const act = rowActionSchema.parse({
      id: 'atender',
      label: 'Atender',
      kind: 'set_field',
      field: 'estado',
      value: 'En atención',
      next: { screen: 'nueva_atencion', prefill: { vuelo: '{{fila}}' } },
    });
    expect(act.next?.screen).toBe('nueva_atencion');
    expect(rowActionSchema.parse({ id: 'a', label: 'A', kind: 'notify' }).next).toBeUndefined();
  });
});

describe('anti-bucles e idempotencia', () => {
  const ev = (over: Partial<AutomationEvent> = {}) => ({ chain: [], depth: 0, ...over });
  it('una regla no se dispara a sí misma ni por una vuelta larga (A → B → A)', () => {
    expect(mayFire('A', ev())).toBe(true);
    expect(mayFire('A', ev({ chain: ['A'], depth: 1 }))).toBe(false);
    expect(mayFire('A', ev({ chain: ['A', 'B'], depth: 2 }))).toBe(false);
    expect(mayFire('C', ev({ chain: ['A', 'B'], depth: 2 }))).toBe(true);
  });
  it('la cadena no pasa de la profundidad máxima', () => {
    expect(mayFire('Z', ev({ chain: ['A', 'B', 'C'], depth: AUTOMATION_MAX_DEPTH }))).toBe(false);
  });
  it('row_deleted dispara sólo en su tabla y la clave de idempotencia distingue sucesos', () => {
    const e: AutomationEvent = {
      kind: 'row_deleted',
      rowId: 'r',
      after: {},
      version: 'v1',
      actor: { kind: 'member' },
      chain: [],
      depth: 0,
    };
    expect(matchesTrigger({ type: 'row_deleted', tracker: 'equipos' }, e, 'equipos')).toBe(true);
    expect(matchesTrigger({ type: 'row_deleted', tracker: 'otra' }, e, 'equipos')).toBe(false);
    expect(matchesTrigger({ type: 'row_created', tracker: 'equipos' }, e, 'equipos')).toBe(false);
    expect(automationIdempotencyKey('A', e)).toBe(automationIdempotencyKey('A', { ...e }));
    expect(automationIdempotencyKey('A', e)).not.toBe(
      automationIdempotencyKey('A', { ...e, version: 'v2' }),
    );
  });
});

describe('descripciones del plan', () => {
  const plan = (
    rows: Array<{ label: string; changes: Array<{ field: string; from?: string; to: string }> }>,
    capped = false,
  ) =>
    ({
      kind: 'update_related',
      tracker: { id: 't', slug: 'equipos', name: 'Equipos' },
      rows: rows.map((r, i) => ({ id: String(i), values: {}, ...r })),
      matched: capped ? 120 : rows.length,
      max: 50,
      capped,
      set: {},
    }) as never;
  it('dice qué cambiaría y avisa del tope', () => {
    const text = describeRelatedPlan(
      plan([{ label: 'E1', changes: [{ field: 'estado', from: 'Nuevo', to: 'Listo' }] }], true),
    );
    expect(text).toMatch(/Cambiaría 1 fila/);
    expect(text).toMatch(/AVISO: cumplen 120 filas y el tope es 50/);
  });
  it('sin cambios o sin filas lo dice', () => {
    expect(describeRelatedPlan(plan([{ label: 'E1', changes: [] }]))).toMatch(/nada que cambiar/);
    expect(describeRelatedPlan(plan([]))).toMatch(/No hay filas/);
    expect(
      describeRelatedPlan(plan([{ label: 'E1', changes: [{ field: 'a', to: 'b' }] }]), true),
    ).toMatch(/^Cambié 1 fila/);
  });
  it('el acumulado dice antes y después', () => {
    const a = {
      type: 'rollup',
      up: 'vuelo',
      target: 'costo_total',
      op: 'sum',
      field: 'costo',
    } as never;
    const text = describeRollupPlan(a, {
      kind: 'rollup',
      parentTracker: null,
      target: 'costo_total',
      parents: [{ id: 'v', label: 'AV204', values: {}, children: 3, from: 100, to: 450 }],
    });
    expect(text).toMatch(/AV204.*quedaría en 450.*antes 100.*la suma de 3 filas/);
  });
});

// ---------------------------------------------------------------------------
// Contra una base falsa: vuelos y equipos
// ---------------------------------------------------------------------------

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const rel = (id: string, label: string) => JSON.stringify({ id, label });

function world(over: { automations?: Array<Record<string, unknown>> } = {}) {
  const vuelosFields = [
    { key: 'nombre', label: 'Vuelo', type: 'text', required: true },
    { key: 'estado', label: 'Estado', type: 'text' },
    { key: 'costo_total', label: 'Costo total', type: 'money' },
    { key: 'cantidad', label: 'Equipos', type: 'number' },
  ];
  const equiposFields = [
    { key: 'nombre', label: 'Equipo', type: 'text', required: true },
    { key: 'vuelo', label: 'Vuelo', type: 'relation', tracker: 'vuelos' },
    { key: 'estado', label: 'Estado', type: 'text' },
    { key: 'costo_total', label: 'Costo total', type: 'money' },
  ];
  const tracker = (id: string, slug: string, name: string, fields: unknown[]) => ({
    id,
    organization_id: ORG,
    slug,
    name,
    description: '',
    fields,
    duplicates: null,
    created_by: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  });
  const row = (
    id: string,
    trackerId: string,
    label: string,
    values: Record<string, string | number>,
  ) => ({
    id,
    organization_id: ORG,
    tracker_id: trackerId,
    label,
    values,
    created_by: 'u1',
    created_at: '2026-10-10T00:00:00Z',
    updated_at: '2026-10-10T00:00:00Z',
  });
  const tables: Record<string, Array<Record<string, unknown>>> = {
    trackers: [
      tracker('t-vuelos', 'vuelos', 'Vuelos', vuelosFields),
      tracker('t-equipos', 'equipos', 'Equipos', equiposFields),
    ],
    tracker_rows: [
      row(V1, 't-vuelos', 'AV204', { nombre: 'AV204', estado: 'Abierto', costo_total: 0 }),
      row(V2, 't-vuelos', 'LA300', { nombre: 'LA300', estado: 'Abierto' }),
      row('e1', 't-equipos', 'Escalera', {
        nombre: 'Escalera',
        vuelo: rel(V1, 'AV204'),
        estado: 'En uso',
        costo_total: 100,
      }),
      row('e2', 't-equipos', 'Tractor', {
        nombre: 'Tractor',
        vuelo: rel(V1, 'AV204'),
        estado: 'En uso',
        costo_total: 250,
      }),
      row('e3', 't-equipos', 'Banda', {
        nombre: 'Banda',
        vuelo: rel(V2, 'LA300'),
        estado: 'En uso',
        costo_total: 999,
      }),
    ],
    custom_apps: [
      {
        id: 'app-1',
        organization_id: ORG,
        slug: 'rampa',
        name: 'Rampa',
        icon: '✈️',
        status: 'published',
        archived_at: null,
      },
    ],
    custom_app_screens: [],
    custom_app_roles: [],
    custom_app_automations: over.automations ?? [],
    custom_app_automation_runs: [],
    custom_app_users: [],
    custom_app_members: [],
    users: [{ id: 'u1', organization_id: ORG, role: 'org_admin', email: 'a@a.co' }],
  };
  const fake = createFakeSupabase(tables);
  forgetAutomationWatch();
  return { tables, db: createOrgScopedClient(fake.client, ORG) };
}

const rowOf = (tables: Record<string, Array<Record<string, unknown>>>, id: string) =>
  (tables.tracker_rows ?? []).find((r) => r.id === id) as {
    values: Record<string, string | number>;
    label: string;
  };

function deps(): AutomationDeps {
  return {
    now: () => NOW,
    baseUrl: 'https://cortex.test',
    signingSecret: 's',
    sendEmail: async () => ({ sent: true }),
    notifyMembers: async (_d, users) => users.length,
    pushAppUsers: async () => [],
    askCortex: async () => ({ summary: 'ok', staged: 0 }),
  };
}

const ruleRow = (
  id: string,
  trigger: Record<string, unknown>,
  actions: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  id,
  organization_id: ORG,
  app_id: 'app-1',
  name: `Regla ${id}`,
  enabled: true,
  trigger,
  conditions: [],
  actions,
  tracker_id: 't-equipos',
  trigger_kind: trigger.type,
  created_by: 'u1',
  ...extra,
});

function queue(
  tables: Record<string, Array<Record<string, unknown>>>,
  automationId: string,
  event: Record<string, unknown>,
  over: Record<string, unknown> = {},
) {
  const run = {
    id: `run-${Math.random().toString(36).slice(2)}`,
    organization_id: ORG,
    app_id: 'app-1',
    automation_id: automationId,
    trigger_ref: 'x',
    status: 'queued',
    attempts: 0,
    next_attempt_at: NOW.toISOString(),
    event: {
      kind: 'row_updated',
      trackerId: 't-equipos',
      rowId: 'e1',
      before: { estado: 'En uso' },
      after: {
        nombre: 'Escalera',
        vuelo: rel(V1, 'AV204'),
        estado: 'Cerrada',
        costo_total: 100,
      },
      label: 'Escalera',
      version: 'v1',
      actor: { kind: 'member', id: 'u1' },
      chain: [],
      depth: 0,
      ...event,
    },
    result: [],
    error: null as string | null,
    ask_cortex_calls: 0,
    idempotency_key: `${automationId}:${Math.random()}`,
    created_at: NOW.toISOString(),
    ...over,
  };
  tables.custom_app_automation_runs?.push(run);
  return run;
}

describe('planUpdateRelated / planUpdateRows / planRollup contra la base', () => {
  const ctxFor = (after: Record<string, string | number>): TemplateContext => ({ after });

  it('subir: cambia la fila del vuelo al que apunta la atención', async () => {
    const { db } = world();
    const equipos = await getTrackerBySlug(db, 'equipos');
    if (!equipos) throw new Error('sin tabla');
    const plan = await planUpdateRelated(db, {
      tracker: equipos,
      rowId: 'e1',
      action: { type: 'update_related', up: 'vuelo', set: { estado: 'Atendido' } },
      ctx: ctxFor({ vuelo: rel(V1, 'AV204') }),
      now: NOW,
    });
    expect(plan.rows.map((r) => r.label)).toEqual(['AV204']);
    expect(plan.rows[0]?.changes).toEqual([{ field: 'estado', from: 'Abierto', to: 'Atendido' }]);
  });

  it('subir sin relación elegida o con el vuelo borrado: lo dice y no falla', async () => {
    const { db, tables } = world();
    const equipos = await getTrackerBySlug(db, 'equipos');
    if (!equipos) throw new Error('sin tabla');
    const action = { type: 'update_related', up: 'vuelo', set: { estado: 'X' } } as never;
    const none = await planUpdateRelated(db, {
      tracker: equipos,
      rowId: 'e1',
      action,
      ctx: ctxFor({}),
      now: NOW,
    });
    expect(none.rows).toEqual([]);
    expect(none.note).toMatch(/no tiene «Vuelo» elegido/);
    tables.tracker_rows = (tables.tracker_rows ?? []).filter((r) => r.id !== V1);
    const gone = await planUpdateRelated(db, {
      tracker: equipos,
      rowId: 'e1',
      action,
      ctx: ctxFor({ vuelo: rel(V1, 'AV204') }),
      now: NOW,
    });
    expect(gone.note).toMatch(/ya no existe/);
  });

  it('bajar: todas las atenciones del vuelo, no las de otro; con filtro y tope', async () => {
    const { db } = world();
    const vuelos = await getTrackerBySlug(db, 'vuelos');
    if (!vuelos) throw new Error('sin tabla');
    const down = (extra: Record<string, unknown> = {}) =>
      ({
        type: 'update_related',
        down: { tracker: 'equipos', via: 'vuelo' },
        set: { estado: 'Devuelto' },
        ...extra,
      }) as never;
    const all = await planUpdateRelated(db, {
      tracker: vuelos,
      rowId: V1,
      action: down(),
      ctx: ctxFor({ nombre: 'AV204' }),
      now: NOW,
    });
    expect(all.rows.map((r) => r.label).sort()).toEqual(['Escalera', 'Tractor']);
    expect(all.matched).toBe(2);
    const filtered = await planUpdateRelated(db, {
      tracker: vuelos,
      rowId: V1,
      action: down({ where: [{ field: 'costo_total', op: 'gt', value: 150 }] }),
      ctx: ctxFor({}),
      now: NOW,
    });
    expect(filtered.rows.map((r) => r.label)).toEqual(['Tractor']);
    const capped = await planUpdateRelated(db, {
      tracker: vuelos,
      rowId: V1,
      action: down({ max: 1 }),
      ctx: ctxFor({}),
      now: NOW,
    });
    expect(capped.rows).toHaveLength(1);
    expect(capped.capped).toBe(true);
    expect(capped.matched).toBe(2);
    expect(describeRelatedPlan(capped)).toMatch(/AVISO/);
  });

  it('bajar por una relación que no apunta a esta tabla: no hay por dónde', async () => {
    const { db } = world();
    const equipos = await getTrackerBySlug(db, 'equipos');
    if (!equipos) throw new Error('sin tabla');
    const plan = await planUpdateRelated(db, {
      tracker: equipos,
      rowId: 'e1',
      action: {
        type: 'update_related',
        down: { tracker: 'vuelos', via: 'nombre' },
        set: { estado: 'X' },
      } as never,
      ctx: ctxFor({}),
      now: NOW,
    });
    expect(plan.rows).toEqual([]);
    expect(plan.note).toMatch(/no apunta/);
  });

  it('applyRelatedPlan escribe sólo lo que cambia y repetirlo no cambia nada (idempotente)', async () => {
    const { db, tables } = world();
    const vuelos = await getTrackerBySlug(db, 'vuelos');
    if (!vuelos) throw new Error('sin tabla');
    const action = {
      type: 'update_related',
      down: { tracker: 'equipos', via: 'vuelo' },
      set: { estado: 'Devuelto' },
    } as never;
    const first = await planUpdateRelated(db, {
      tracker: vuelos,
      rowId: V1,
      action,
      ctx: ctxFor({}),
      now: NOW,
    });
    const done = await applyRelatedPlan(db, first, 'u1');
    expect(done).toEqual({ changed: 2, failures: [] });
    expect(rowOf(tables, 'e1').values.estado).toBe('Devuelto');
    expect(rowOf(tables, 'e2').values.estado).toBe('Devuelto');
    expect(rowOf(tables, 'e3').values.estado).toBe('En uso');
    const again = await planUpdateRelated(db, {
      tracker: vuelos,
      rowId: V1,
      action,
      ctx: ctxFor({}),
      now: NOW,
    });
    expect(again.rows.every((r) => r.changes.length === 0)).toBe(true);
    expect((await applyRelatedPlan(db, again, 'u1')).changed).toBe(0);
  });

  it('update_rows: filtra por plantilla de la fila que disparó, con tope y aviso', async () => {
    const { db } = world();
    const plan = await planUpdateRows(db, {
      action: {
        type: 'update_rows',
        tracker: 'equipos',
        where: [
          { field: 'vuelo', op: 'eq', value: '{{vuelo}}' },
          { field: 'estado', op: 'eq', value: 'En uso' },
        ],
        set: { estado: 'Libre' },
        max: 1,
      },
      ctx: ctxFor({ vuelo: rel(V1, 'AV204') }),
      now: NOW,
    });
    expect(plan.matched).toBe(2);
    expect(plan.rows).toHaveLength(1);
    expect(plan.capped).toBe(true);
    const gone = await planUpdateRows(db, {
      action: {
        type: 'update_rows',
        tracker: 'no_existe',
        where: [{ field: 'a', op: 'empty' }],
        set: { a: 'b' },
      },
      ctx: ctxFor({}),
      now: NOW,
    });
    expect(gone.note).toMatch(/ya no existe/);
  });

  it('rollup: suma todas las hijas del padre (nunca «suma uno») y repetirlo da lo mismo', async () => {
    const { db, tables } = world();
    const equipos = await getTrackerBySlug(db, 'equipos');
    if (!equipos) throw new Error('sin tabla');
    const action = {
      type: 'rollup',
      up: 'vuelo',
      target: 'costo_total',
      op: 'sum',
      field: 'costo_total',
    } as never;
    const ctx = ctxFor({ vuelo: rel(V1, 'AV204') });
    const plan = await planRollup(db, { tracker: equipos, action, ctx, now: NOW });
    expect(plan.parents).toHaveLength(1);
    expect(plan.parents[0]).toMatchObject({ label: 'AV204', children: 2, from: 0, to: 350 });
    expect((await applyRollupPlan(db, plan, 'u1')).changed).toBe(1);
    expect(rowOf(tables, V1).values.costo_total).toBe(350);
    const again = await planRollup(db, { tracker: equipos, action, ctx, now: NOW });
    expect(await applyRollupPlan(db, again, 'u1')).toEqual({ changed: 0, failures: [] });
    expect(rowOf(tables, V1).values.costo_total).toBe(350);
    // el vuelo 2 no se tocó
    expect(rowOf(tables, V2).values.costo_total).toBeUndefined();
  });

  it('rollup: conteo, promedio, y con filtro sobre las hijas', async () => {
    const { db } = world();
    const equipos = await getTrackerBySlug(db, 'equipos');
    if (!equipos) throw new Error('sin tabla');
    const ctx = ctxFor({ vuelo: rel(V1, 'AV204') });
    const count = await planRollup(db, {
      tracker: equipos,
      action: { type: 'rollup', up: 'vuelo', target: 'cantidad', op: 'count' } as never,
      ctx,
      now: NOW,
    });
    expect(count.parents[0]?.to).toBe(2);
    const avg = await planRollup(db, {
      tracker: equipos,
      action: {
        type: 'rollup',
        up: 'vuelo',
        target: 'costo_total',
        op: 'avg',
        field: 'costo_total',
      } as never,
      ctx,
      now: NOW,
    });
    expect(avg.parents[0]?.to).toBe(175);
    const filtered = await planRollup(db, {
      tracker: equipos,
      action: {
        type: 'rollup',
        up: 'vuelo',
        target: 'costo_total',
        op: 'sum',
        field: 'costo_total',
        where: [{ field: 'costo_total', op: 'gt', value: 150 }],
      } as never,
      ctx,
      now: NOW,
    });
    expect(filtered.parents[0]).toMatchObject({ children: 1, to: 250 });
  });

  it('rollup: si la hija cambió de vuelo se recalculan el de antes y el de ahora', async () => {
    const { db, tables } = world();
    const equipos = await getTrackerBySlug(db, 'equipos');
    if (!equipos) throw new Error('sin tabla');
    // la escalera pasó del vuelo 1 al 2 (en la base ya está en el 2)
    const e1 = rowOf(tables, 'e1');
    e1.values.vuelo = rel(V2, 'LA300');
    const plan = await planRollup(db, {
      tracker: equipos,
      action: {
        type: 'rollup',
        up: 'vuelo',
        target: 'costo_total',
        op: 'sum',
        field: 'costo_total',
      } as never,
      ctx: ctxFor({ vuelo: rel(V2, 'LA300') }),
      before: { vuelo: rel(V1, 'AV204') },
      now: NOW,
    });
    const byLabel = Object.fromEntries(plan.parents.map((p) => [p.label, p.to]));
    expect(byLabel).toEqual({ LA300: 1099, AV204: 250 });
  });

  it('rollup con la hija borrada: queda la suma de las que quedan', async () => {
    const { db, tables } = world();
    const equipos = await getTrackerBySlug(db, 'equipos');
    if (!equipos) throw new Error('sin tabla');
    tables.tracker_rows = (tables.tracker_rows ?? []).filter((r) => r.id !== 'e2');
    const plan = await planRollup(db, {
      tracker: equipos,
      action: {
        type: 'rollup',
        up: 'vuelo',
        target: 'costo_total',
        op: 'sum',
        field: 'costo_total',
      } as never,
      ctx: ctxFor({ vuelo: rel(V1, 'AV204') }),
      before: { vuelo: rel(V1, 'AV204') },
      now: NOW,
    });
    expect(plan.parents[0]?.to).toBe(100);
  });

  it('rollup rechaza un destino que no es número ni dinero', async () => {
    const { db } = world();
    const equipos = await getTrackerBySlug(db, 'equipos');
    if (!equipos) throw new Error('sin tabla');
    const plan = await planRollup(db, {
      tracker: equipos,
      action: { type: 'rollup', up: 'vuelo', target: 'estado', op: 'count' } as never,
      ctx: ctxFor({ vuelo: rel(V1, 'AV204') }),
      now: NOW,
    });
    expect(plan.parents).toEqual([]);
    expect(plan.note).toMatch(/número o dinero/);
  });
});

describe('la corrida con las acciones nuevas', () => {
  const cierra = ruleRow(
    'r-cierra',
    { type: 'row_updated', tracker: 'equipos', field: 'estado', to: 'Cerrada' },
    [
      { type: 'update_related', up: 'vuelo', set: { estado: 'Atendido' } },
      { type: 'rollup', up: 'vuelo', target: 'costo_total', op: 'sum', field: 'costo_total' },
    ],
  );

  it('«cuando cierre una atención, marca el vuelo como atendido y suma el costo»', async () => {
    const { db, tables } = world({ automations: [{ ...cierra }] });
    const run = queue(tables, 'r-cierra', {});
    const out = await executeRun(db, run.id as string, ORG, deps());
    expect(out.status).toBe('succeeded');
    expect(rowOf(tables, V1).values.estado).toBe('Atendido');
    expect(rowOf(tables, V1).values.costo_total).toBe(350);
    // el vuelo 2 quedó igual
    expect(rowOf(tables, V2).values.estado).toBe('Abierto');
    // detalle legible en el historial
    const detail = (run.result as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    expect(detail).toMatch(/Cambié 1 fila de «Vuelos»/);
    expect(detail).toMatch(/quedó en 350/);
  });

  it('anti-bucle: lo que escribe la regla no la vuelve a disparar, pero sí a otra distinta', async () => {
    const mirador = ruleRow(
      'r-vuelos',
      { type: 'row_updated', tracker: 'vuelos', field: 'estado' },
      [{ type: 'email', to: ['x@a.co'], roles: [], subject: 's', body: 'b' }],
      { tracker_id: 't-vuelos' },
    );
    // una regla que mira los cambios de equipos y escribe en vuelos: no se dispara a sí misma
    const { db, tables } = world({ automations: [{ ...cierra }, mirador] });
    const run = queue(tables, 'r-cierra', {});
    await executeRun(db, run.id as string, ORG, deps());
    const created = (tables.custom_app_automation_runs ?? []).filter((r) => r.id !== run.id);
    expect(created.map((r) => r.automation_id)).toEqual(['r-vuelos']);
    expect(created[0]?.depth).toBe(1);
    expect((created[0]?.event as AutomationEvent).chain).toEqual(['r-cierra']);
  });

  it('anti-bucle de vuelta larga: A escribe donde mira B y B donde mira A, y se corta', async () => {
    const aRule = ruleRow('r-a', { type: 'row_updated', tracker: 'equipos', field: 'estado' }, [
      { type: 'update_related', up: 'vuelo', set: { estado: 'X' } },
    ]);
    const bRule = ruleRow(
      'r-b',
      { type: 'row_updated', tracker: 'vuelos', field: 'estado' },
      [
        {
          type: 'update_related',
          down: { tracker: 'equipos', via: 'vuelo' },
          set: { estado: 'Y' },
        },
      ],
      { tracker_id: 't-vuelos' },
    );
    const { db, tables } = world({ automations: [aRule, bRule] });
    const first = queue(tables, 'r-a', { after: { vuelo: rel(V1, 'AV204'), estado: 'Cerrada' } });
    await executeRun(db, first.id as string, ORG, deps());
    // A escribió el vuelo → se encola B (cadena [r-a])
    const second = (tables.custom_app_automation_runs ?? []).find((r) => r.automation_id === 'r-b');
    expect(second).toBeTruthy();
    await executeRun(db, (second as { id: string }).id, ORG, deps());
    // B escribió equipos → A estaría en la cadena [r-a, r-b]: NO se encola de nuevo
    const again = (tables.custom_app_automation_runs ?? []).filter(
      (r) => r.automation_id === 'r-a',
    );
    expect(again).toHaveLength(1);
  });

  it('«si» y «si no» por acción: sólo una rama corre', async () => {
    const rule = ruleRow('r-rama', { type: 'row_updated', tracker: 'equipos' }, [
      {
        type: 'update_related',
        up: 'vuelo',
        set: { estado: 'Costoso' },
        if: [{ field: 'costo_total', op: 'gt', value: 1000 }],
      },
      { type: 'update_related', up: 'vuelo', set: { estado: 'Normal' }, otherwise: true },
    ]);
    const { db, tables } = world({ automations: [rule] });
    const cheap = queue(tables, 'r-rama', {});
    expect((await executeRun(db, cheap.id as string, ORG, deps())).status).toBe('succeeded');
    expect(rowOf(tables, V1).values.estado).toBe('Normal');
    expect((cheap.result as Array<{ detail: string }>)[0]?.detail).toMatch(/Omitida/);

    const dear = queue(tables, 'r-rama', {
      rowId: 'e2',
      after: { vuelo: rel(V1, 'AV204'), costo_total: 5000 },
      version: 'v2',
    });
    expect((await executeRun(db, dear.id as string, ORG, deps())).status).toBe('succeeded');
    expect(rowOf(tables, V1).values.estado).toBe('Costoso');
  });

  it('un reintento rehace el «si no» igual y no repite lo que ya salió', async () => {
    const rule = ruleRow('r-retry', { type: 'row_updated', tracker: 'equipos' }, [
      {
        type: 'set_field',
        field: 'estado',
        value: 'Marcado',
        if: [{ field: 'costo_total', op: 'gt', value: 1000 }],
      },
      {
        type: 'email',
        to: ['x@a.co'],
        roles: [],
        subject: 'sin costo alto',
        body: 'b',
        otherwise: true,
      },
      { type: 'ask_cortex', instruction: 'x' },
    ]);
    const { db, tables } = world({ automations: [rule] });
    const run = queue(tables, 'r-retry', {});
    const mails: string[] = [];
    let fail = true;
    const d: AutomationDeps = {
      ...deps(),
      sendEmail: async (m) => {
        mails.push(m.subject);
        return { sent: true };
      },
      askCortex: async () => {
        if (fail) throw new Error('fetch failed');
        return { summary: 'ok', staged: 0 };
      },
    };
    expect((await executeRun(db, run.id as string, ORG, d)).status).toBe('retry');
    fail = false;
    const later = { ...d, now: () => new Date(NOW.getTime() + 2 * 60_000) };
    expect((await executeRun(db, run.id as string, ORG, later)).status).toBe('succeeded');
    expect(mails).toEqual(['sin costo alto']);
  });

  it('update_rows en la corrida, con el tope diciendo que no cambió todo', async () => {
    const rule = ruleRow('r-rows', { type: 'row_updated', tracker: 'equipos' }, [
      {
        type: 'update_rows',
        tracker: 'equipos',
        where: [{ field: 'vuelo', op: 'eq', value: '{{vuelo}}' }],
        set: { estado: 'Cerrada' },
        max: 1,
      },
    ]);
    const { db, tables } = world({ automations: [rule] });
    const run = queue(tables, 'r-rows', {});
    expect((await executeRun(db, run.id as string, ORG, deps())).status).toBe('succeeded');
    const closed = ['e1', 'e2'].filter((id) => rowOf(tables, id).values.estado === 'Cerrada');
    expect(closed).toHaveLength(1);
    expect((run.result as Array<{ detail: string }>)[0]?.detail).toMatch(/AVISO/);
    expect(rowOf(tables, 'e3').values.estado).toBe('En uso');
  });

  it('una acción que no puede escribir (campo inventado) falla clara, no a medias en silencio', async () => {
    const rule = ruleRow('r-mala', { type: 'row_updated', tracker: 'equipos' }, [
      { type: 'update_related', up: 'vuelo', set: { inventado: 'x' } },
    ]);
    const { db, tables } = world({ automations: [rule] });
    const run = queue(tables, 'r-mala', {});
    const out = await executeRun(db, run.id as string, ORG, deps());
    expect(out.status).toBe('failed');
    expect(String(run.error)).toMatch(/inventado|No se pudo cambiar/);
  });
});

describe('esperar dentro de la regla', () => {
  const waiting = ruleRow('r-wait', { type: 'row_created', tracker: 'equipos' }, [
    { type: 'wait', minutes: 120, stillIf: [{ field: 'estado', op: 'neq', value: 'Devuelto' }] },
    { type: 'update_related', up: 'vuelo', set: { estado: 'Alerta' } },
  ]);
  const created = {
    kind: 'row_created',
    before: null,
    after: { nombre: 'Escalera', vuelo: rel(V1, 'AV204'), estado: 'En uso', costo_total: 100 },
  };

  it('la primera vez duerme la corrida hasta la hora y no hace lo que sigue', async () => {
    const { db, tables } = world({ automations: [waiting] });
    const run = queue(tables, 'r-wait', created);
    const out = await executeRun(db, run.id as string, ORG, deps());
    expect(out.status).toBe('retry');
    expect(run.status).toBe('queued');
    expect(new Date(String(run.next_attempt_at)).getTime()).toBe(NOW.getTime() + 120 * 60_000);
    expect(rowOf(tables, V1).values.estado).toBe('Abierto');
    const first = (run.result as Array<{ ok: boolean; detail: string }>)[0];
    expect(first?.ok).toBe(false);
    expect(first?.detail.startsWith(WAIT_PENDING)).toBe(true);
    // todavía no vence: no se puede reclamar
    expect((await executeRun(db, run.id as string, ORG, deps())).status).toBe('not_claimable');
    // el contador de intentos se reinicia: la espera no gasta reintentos
    expect(run.attempts).toBe(0);
  });

  it('al despertar, si la fila SIGUE cumpliendo, hace lo que sigue con la fila como está entonces', async () => {
    const { db, tables } = world({ automations: [waiting] });
    const run = queue(tables, 'r-wait', created);
    await executeRun(db, run.id as string, ORG, deps());
    const later = { ...deps(), now: () => new Date(NOW.getTime() + 121 * 60_000) };
    const out = await executeRun(db, run.id as string, ORG, later);
    expect(out.status).toBe('succeeded');
    expect(rowOf(tables, V1).values.estado).toBe('Alerta');
    const results = run.result as Array<{ ok: boolean; detail: string }>;
    expect(results[0]?.detail).toMatch(/sigue cumpliendo/);
  });

  it('al despertar, si ya NO cumple, termina «omitida» y no hace nada', async () => {
    const { db, tables } = world({ automations: [waiting] });
    const run = queue(tables, 'r-wait', created);
    await executeRun(db, run.id as string, ORG, deps());
    // entre tanto el equipo se devolvió
    rowOf(tables, 'e1').values.estado = 'Devuelto';
    const later = { ...deps(), now: () => new Date(NOW.getTime() + 121 * 60_000) };
    // el evento apunta a e1
    const out = await executeRun(db, run.id as string, ORG, later);
    expect(out.status).toBe('skipped');
    expect(run.status).toBe('skipped');
    expect(String(run.error)).toMatch(/ya no se cumple/);
    expect(rowOf(tables, V1).values.estado).toBe('Abierto');
  });

  it('sin «seguir si» usa las condiciones de la propia regla (menos «cambió»)', async () => {
    const rule = ruleRow(
      'r-wait2',
      { type: 'row_created', tracker: 'equipos' },
      [
        { type: 'wait', minutes: 10 },
        { type: 'update_related', up: 'vuelo', set: { estado: 'Alerta' } },
      ],
      { conditions: [{ field: 'estado', op: 'eq', value: 'En uso' }] },
    );
    const { db, tables } = world({ automations: [rule] });
    const run = queue(tables, 'r-wait2', created);
    expect((await executeRun(db, run.id as string, ORG, deps())).status).toBe('retry');
    rowOf(tables, 'e1').values.estado = 'Devuelto';
    const later = { ...deps(), now: () => new Date(NOW.getTime() + 11 * 60_000) };
    expect((await executeRun(db, run.id as string, ORG, later)).status).toBe('skipped');
  });

  it('pausada mientras esperaba: no hace nada al despertar', async () => {
    const { db, tables } = world({ automations: [waiting] });
    const run = queue(tables, 'r-wait', created);
    await executeRun(db, run.id as string, ORG, deps());
    (tables.custom_app_automations?.[0] as { enabled: boolean }).enabled = false;
    const later = { ...deps(), now: () => new Date(NOW.getTime() + 121 * 60_000) };
    expect((await executeRun(db, run.id as string, ORG, later)).status).toBe('skipped');
    expect(rowOf(tables, V1).values.estado).toBe('Abierto');
  });

  it('«seguir siempre» ([]) no relee las condiciones', async () => {
    const rule = ruleRow('r-wait3', { type: 'row_created', tracker: 'equipos' }, [
      { type: 'wait', minutes: 10, stillIf: [] },
      { type: 'update_related', up: 'vuelo', set: { estado: 'Alerta' } },
    ]);
    const { db, tables } = world({ automations: [rule] });
    const run = queue(tables, 'r-wait3', created);
    await executeRun(db, run.id as string, ORG, deps());
    rowOf(tables, 'e1').values.estado = 'Devuelto';
    const later = { ...deps(), now: () => new Date(NOW.getTime() + 11 * 60_000) };
    expect((await executeRun(db, run.id as string, ORG, later)).status).toBe('succeeded');
    expect(rowOf(tables, V1).values.estado).toBe('Alerta');
  });
});

describe('«se borra una fila»: el acumulado sigue a los borrados', () => {
  it('removeRows emite row_deleted con los valores que tenía la fila', async () => {
    const rule = ruleRow('r-borra', { type: 'row_deleted', tracker: 'equipos' }, [
      { type: 'rollup', up: 'vuelo', target: 'costo_total', op: 'sum', field: 'costo_total' },
    ]);
    const { db, tables } = world({ automations: [rule] });
    const removed = await removeRows(db, { id: 't-equipos', slug: 'equipos' }, ['e2'], {
      userId: 'u1',
    });
    expect(removed).toEqual(['e2']);
    expect((tables.tracker_rows ?? []).some((r) => r.id === 'e2')).toBe(false);
    const queued = tables.custom_app_automation_runs ?? [];
    expect(queued).toHaveLength(1);
    const event = queued[0]?.event as AutomationEvent;
    expect(event.kind).toBe('row_deleted');
    expect(event.rowId).toBe('e2');
    expect(event.after).toMatchObject({ nombre: 'Tractor', costo_total: 250 });
    // y al correr, el vuelo queda con la suma de las que quedan
    // (la corrida nace con la hora real; se corre un minuto después)
    const soon = { ...deps(), now: () => new Date(Date.now() + 60_000) };
    const out = await executeRun(db, queued[0]?.id as string, ORG, soon);
    expect(out.status).toBe('succeeded');
    expect(rowOf(tables, V1).values.costo_total).toBe(100);
  });

  it('sin reglas que miren la tabla no se emite nada, y borrar algo que no existe no emite', async () => {
    const { db, tables } = world();
    expect(await removeRows(db, { id: 't-equipos', slug: 'equipos' }, ['e1'])).toEqual(['e1']);
    expect(tables.custom_app_automation_runs).toEqual([]);
    expect(await removeRows(db, { id: 't-equipos', slug: 'equipos' }, ['nada'])).toEqual([]);
    expect(await removeRows(db, { id: 't-equipos', slug: 'equipos' }, [])).toEqual([]);
  });

  it('el mismo borrado emitido dos veces deja UNA corrida (idempotencia)', async () => {
    const rule = ruleRow('r-borra2', { type: 'row_deleted', tracker: 'equipos' }, [
      { type: 'rollup', up: 'vuelo', target: 'costo_total', op: 'count' },
    ]);
    const { db, tables } = world({ automations: [rule] });
    const input = {
      kind: 'row_deleted' as const,
      trackerId: 't-equipos',
      trackerSlug: 'equipos',
      rowId: 'e2',
      before: { nombre: 'Tractor' },
      after: { nombre: 'Tractor' },
      version: '2026-10-19T15:00:00.000Z',
      actor: { kind: 'member' as const, id: 'u1' },
    };
    await emitAutomationEvent(db, input);
    await emitAutomationEvent(db, input);
    expect(tables.custom_app_automation_runs).toHaveLength(1);
  });

  it('escribir dentro de una regla lleva la cadena: la regla de los borrados no se re-dispara', async () => {
    const rule = ruleRow('r-borra3', { type: 'row_deleted', tracker: 'equipos' }, [
      { type: 'rollup', up: 'vuelo', target: 'costo_total', op: 'count' },
    ]);
    const { db, tables } = world({ automations: [rule] });
    await withAutomationOrigin({ chain: ['r-borra3'], depth: 1 }, async () => {
      await removeRows(db, { id: 't-equipos', slug: 'equipos' }, ['e2']);
    });
    expect(tables.custom_app_automation_runs).toEqual([]);
  });
});

describe('validación y simulación contra la base', () => {
  const app = { id: 'app-1', name: 'Rampa', slug: 'rampa' };

  it('validateAutomation revisa relaciones, destinos y campos que se cambian', async () => {
    const { db } = world();
    const base = (actions: unknown[]) => ({
      name: 'x',
      trigger: { type: 'row_updated', tracker: 'equipos', field: 'estado' },
      actions,
    });
    await expect(
      validateAutomation(
        db,
        'app-1',
        base([{ type: 'update_related', up: 'estado', set: { a: 'b' } }]),
      ),
    ).rejects.toThrow(/no es un campo de relación/);
    await expect(
      validateAutomation(
        db,
        'app-1',
        base([{ type: 'update_related', up: 'vuelo', set: { inventado: 'x' } }]),
      ),
    ).rejects.toThrow(/inventado/);
    await expect(
      validateAutomation(
        db,
        'app-1',
        base([
          {
            type: 'update_related',
            down: { tracker: 'vuelos', via: 'nombre' },
            set: { estado: 'x' },
          },
        ]),
      ),
    ).rejects.toThrow(/tiene que ser un campo de relación que apunte/);
    await expect(
      validateAutomation(
        db,
        'app-1',
        base([{ type: 'rollup', up: 'vuelo', target: 'estado', op: 'count' }]),
      ),
    ).rejects.toThrow(/número o dinero/);
    await expect(
      validateAutomation(
        db,
        'app-1',
        base([{ type: 'rollup', up: 'vuelo', target: 'costo_total', op: 'sum', field: 'estado' }]),
      ),
    ).rejects.toThrow(/tiene que ser un número o dinero/);
    await expect(
      validateAutomation(
        db,
        'app-1',
        base([
          {
            type: 'set_field',
            field: 'estado',
            value: 'x',
            if: [{ field: 'inventado', op: 'empty' }],
          },
        ]),
      ),
    ).rejects.toThrow(/inventado/);
    await expect(
      validateAutomation(db, 'app-1', {
        name: 'x',
        trigger: { type: 'row_updated', tracker: 'equipos' },
        actions: [
          {
            type: 'update_rows',
            tracker: 'equipos',
            where: [{ field: 'inventado', op: 'empty' }],
            set: { estado: 'x' },
          },
        ],
      }),
    ).rejects.toThrow(/inventado/);
    const ok = await validateAutomation(
      db,
      'app-1',
      base([
        { type: 'update_related', up: 'vuelo', set: { estado: 'Atendido' } },
        { type: 'rollup', up: 'vuelo', target: 'costo_total', op: 'sum', field: 'costo_total' },
        { type: 'wait', minutes: 30 },
        {
          type: 'update_related',
          down: { tracker: 'equipos', via: 'vuelo' },
          set: { estado: 'Libre' },
        },
      ]),
    ).catch((e) => e);
    // la última baja desde «equipos» a «equipos» por su relación a «vuelos»: no apunta a «equipos»
    expect(String(ok)).toMatch(/tiene que ser un campo de relación que apunte a «Equipos»/);
  });

  it('un botón con «después abre» exige una pantalla de la app', async () => {
    const { db } = world();
    await expect(
      validateAutomation(db, 'app-1', {
        name: 'b',
        trigger: {
          type: 'button',
          screen: 'inicio',
          id: 'b1',
          label: 'B',
          next: { screen: 'inexistente' },
        },
        actions: [{ type: 'email', to: ['a@b.co'], subject: 's', body: 'b' }],
      }),
    ).rejects.toThrow(/no es de esta app/);
  });

  it('simulateAutomation prueba con una fila real y muestra qué cambiaría, sin escribir', async () => {
    const { db, tables } = world();
    const before = JSON.stringify(tables.tracker_rows);
    const sim = await simulateAutomation(
      db,
      app,
      {
        trigger: { type: 'row_updated', tracker: 'equipos', field: 'estado' },
        conditions: [],
        actions: [
          { type: 'update_related', up: 'vuelo', set: { estado: 'Atendido' } },
          { type: 'rollup', up: 'vuelo', target: 'costo_total', op: 'sum', field: 'costo_total' },
          { type: 'wait', minutes: 60 },
          {
            type: 'update_rows',
            tracker: 'equipos',
            where: [{ field: 'estado', op: 'eq', value: 'En uso' }],
            set: { estado: 'Libre' },
            max: 2,
          },
        ],
      } as never,
      { rowId: 'e1', now: NOW },
    );
    expect(sim.sample?.label).toBe('Escalera');
    expect(sim.actions[0]?.summary).toMatch(/Cambiaría 1 fila de «Vuelos».*AV204/);
    expect(sim.actions[0]?.details?.[0]).toMatch(/AV204: estado: Abierto → Atendido/);
    expect(sim.actions[1]?.summary).toMatch(/quedaría en 350/);
    expect(sim.actions[2]?.summary).toMatch(/Esperaría 1 hora/);
    expect(sim.actions[3]?.summary).toMatch(/AVISO/);
    // nada se escribió
    expect(JSON.stringify(tables.tracker_rows)).toBe(before);
    expect(tables.custom_app_automation_runs).toEqual([]);
  });

  it('upsertRow sigue emitiendo row_updated cuando una regla cambia un campo (la cadena la lleva la corrida)', async () => {
    const rule = ruleRow(
      'r-obs',
      { type: 'row_updated', tracker: 'vuelos', field: 'estado' },
      [{ type: 'email', to: ['a@a.co'], roles: [], subject: 's', body: 'b' }],
      { tracker_id: 't-vuelos' },
    );
    const { db, tables } = world({ automations: [rule] });
    const vuelos = await getTrackerBySlug(db, 'vuelos');
    if (!vuelos) throw new Error('sin tabla');
    await upsertRow(db, {
      tracker: vuelos,
      rowId: V1,
      values: { nombre: 'AV204', estado: 'Cerrado' },
      userId: 'u1',
      only: new Set(['estado']),
    });
    expect(tables.custom_app_automation_runs).toHaveLength(1);
  });

  it('adaptAutomation conserva if / otherwise y las acciones nuevas al leer lo guardado', () => {
    const row = ruleRow('x', { type: 'row_updated', tracker: 'equipos' }, [
      {
        type: 'update_related',
        up: 'vuelo',
        set: { estado: 'A' },
        if: [{ field: 'estado', op: 'eq', value: 'B' }],
      },
      { type: 'wait', minutes: 5 },
    ]);
    const a = adaptAutomation(row as never);
    expect(a.actions).toHaveLength(2);
    expect(a.actions[0]?.if).toHaveLength(1);
  });
});
