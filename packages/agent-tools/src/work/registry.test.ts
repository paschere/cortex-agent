import { ForbiddenError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { isCompanyManager, isWorkspaceOwner } from '../directory/store';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import type { ToolContext } from '../types';
import { readPlatformSource } from '../views/sources';
import { scopeFor } from './access';
import {
  commitmentToWork,
  managementCaseToWork,
  numberValue,
  pendingActionToWork,
  proposeTrackerMapping,
  trackerRowToWork,
} from './adapters';
import { factsRef, resolvePerson, trackerMappingSchema } from './shape';
import {
  getWorkItemsByIds,
  listWorkItems,
  markTrackerItemDone,
  readWorkSettings,
  undoTrackerItemDone,
  updateWorkPerson,
  upsertWorkItems,
  workPersonChangeRefusal,
} from './store';
import { syncWork } from './sync';
import { workAssign, workConfigure, workQuery, workRecord, workUpdatePerson } from './tools';

/**
 * El registro de trabajo contra un PostgREST de mentira con dos empresas: los
 * mapeadores de cada fuente, la idempotencia, la sincronización, el mapeo de
 * una tabla, quién ve qué y quién puede anotar días fuera.
 */

const ORG = 'org-andina';
const OTHER = 'org-otra';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const LAURA = '22222222-2222-4222-8222-222222222222';
const ANDRES = '33333333-3333-4333-8333-333333333333';
const LAURA_P = '44444444-4444-4444-8444-444444444444';
const T0 = '2026-09-01T15:00:00.000Z';

const PEOPLE = [
  { id: ADMIN, name: 'Mateo Ángel', email: 'mateo@andina.co', role: 'org_admin' },
  { id: LAURA, name: 'Laura Gómez', email: 'laura@andina.co', role: 'member' },
  { id: ANDRES, name: 'Andrés Peña', email: 'andres@andina.co', role: 'member' },
];

type Row = Record<string, unknown>;
let seq = 0;
const uuid = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

/** La base: ids y fechas por defecto al insertar, como Postgres. */
function world(seed: Record<string, Row[]> = {}) {
  const users = PEOPLE.map((p, i) => ({
    ...p,
    organization_id: ORG,
    manager_id: null,
    created_at: `2026-01-0${i + 1}T00:00:00Z`,
  }));
  const fake = createFakeSupabase({
    users: [
      ...users,
      {
        id: '99999999-9999-4999-8999-999999999999',
        name: 'Laura Otra',
        email: 'laura@otra.co',
        role: 'member',
        organization_id: OTHER,
        manager_id: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    ...seed,
  });
  const from = fake.client.from.bind(fake.client);
  const raw = {
    ...fake.client,
    from: (table: string) => {
      // biome-ignore lint/suspicious/noExplicitAny: envuelve el builder del doble
      const qb = from(table) as any;
      const insert = qb.insert.bind(qb);
      qb.insert = (values: Row | Row[]) =>
        insert(
          (Array.isArray(values) ? values : [values]).map((r) => ({
            id: uuid(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...r,
          })),
        );
      return qb;
    },
  } as unknown as SupabaseClient;
  return { db: createOrgScopedClient(raw, ORG), raw, tables: fake.tables };
}

function ctx(db: SupabaseClient, userId: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    organizationId: ORG,
    userId,
    agentId: '55555555-5555-4555-8555-555555555555',
    db,
    integrations: {
      getAccessToken: async () => ({ token: '', scopes: [] }),
      hasScopes: async () => true,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ToolContext['logger'],
    ...extra,
  };
}

// ---------------------------------------------------------------------------

describe('quién es quién', () => {
  it('encuentra por correo, por nombre completo sin tildes y por el primer nombre', () => {
    expect(resolvePerson(PEOPLE, 'LAURA@andina.co')).toMatchObject({ kind: 'found', id: LAURA });
    expect(resolvePerson(PEOPLE, 'andres pena')).toMatchObject({ kind: 'found', id: ANDRES });
    expect(resolvePerson(PEOPLE, 'Laura')).toMatchObject({ kind: 'found', id: LAURA });
    expect(resolvePerson(PEOPLE, 'Laura G')).toMatchObject({ kind: 'found', id: LAURA });
  });

  it('nunca adivina: dos Lauras es ambiguo, un desconocido queda con su nombre', () => {
    const two = [...PEOPLE, { id: LAURA_P, name: 'Laura Pérez', email: 'lp@andina.co' }];
    const m = resolvePerson(two, 'Laura');
    expect(m.kind).toBe('ambiguous');
    expect(resolvePerson(PEOPLE, 'Don Jorge')).toEqual({ kind: 'unknown', label: 'Don Jorge' });
    expect(resolvePerson(PEOPLE, '  ')).toEqual({ kind: 'empty' });
  });
});

describe('los mapeadores de cada fuente', () => {
  it('un asunto de Gerencia: verificado es hecho, descartado ya no aplica', () => {
    const base = {
      id: 'c1',
      created_at: T0,
      updated_at: '2026-09-10T15:00:00Z',
      data: { title: 'Cobrar a Coltrans', ownerId: LAURA, dueOn: '2026-09-15', state: 'working' },
    };
    expect(managementCaseToWork(base)).toMatchObject({
      status: 'open',
      workType: 'caso',
      assigneeId: LAURA,
      dueAt: '2026-09-15',
      source: { kind: 'management_case', system: 'gerencia', ref: 'c1' },
    });
    const done = managementCaseToWork({ ...base, data: { ...base.data, state: 'verified' } });
    expect(done).toMatchObject({
      status: 'done',
      doneAt: '2026-09-10T15:00:00Z',
      doneAtApprox: true,
    });
    expect(
      managementCaseToWork({ ...base, data: { ...base.data, state: 'cancelled' } })?.status,
    ).toBe('cancelled');
  });

  it('un compromiso: sin confirmar no es trabajo; cumplido usa met_at; interno es «compromiso»', () => {
    const c = {
      id: 'k1',
      title: 'SOAT ABC123',
      kind: 'soat',
      due_on: '2026-10-01',
      state: 'in_force',
      met_at: null,
      dropped_at: null,
      owner_user_id: ANDRES,
      review_state: 'confirmed',
      created_at: T0,
      updated_at: T0,
    };
    expect(commitmentToWork({ ...c, review_state: 'pending' })).toBeNull();
    expect(commitmentToWork(c)).toMatchObject({ workType: 'vencimiento', status: 'open' });
    expect(commitmentToWork({ ...c, state: 'met', met_at: '2026-09-20T13:00:00Z' })).toMatchObject({
      status: 'done',
      doneAt: '2026-09-20T13:00:00Z',
      doneAtApprox: false,
    });
    expect(commitmentToWork({ ...c, state: 'dropped' })?.status).toBe('cancelled');
    expect(commitmentToWork({ ...c, review_state: 'rejected' })?.status).toBe('cancelled');
    expect(commitmentToWork({ ...c, kind: 'internal' })?.workType).toBe('compromiso');
  });

  it('una aprobación es «espera de decisión», sin el payload, y cuenta cuánto tardó', () => {
    const now = new Date('2026-09-05T12:00:00Z');
    const a = {
      id: 'p1',
      user_id: LAURA,
      tool_id: 'gmail.send_message',
      created_at: '2026-09-05T10:00:00Z',
      expires_at: '2026-09-06T10:00:00Z',
      decision: null,
      decided_at: null,
    };
    const open = pendingActionToWork(a, 'Enviar este correo tal cual', now);
    expect(open).toMatchObject({
      status: 'open',
      workType: 'decisión',
      title: 'Espera de decisión: Enviar este correo tal cual',
      assigneeId: LAURA,
    });
    expect(
      pendingActionToWork(
        { ...a, decision: 'approved', decided_at: '2026-09-05T11:00:00Z' },
        'x',
        now,
      ),
    ).toMatchObject({ status: 'done', doneAt: '2026-09-05T11:00:00Z' });
    expect(pendingActionToWork(a, 'x', new Date('2026-09-07T00:00:00Z'))?.status).toBe('cancelled');
  });

  it('una fila de tabla, con el mapeo de la empresa', () => {
    const mapping = trackerMappingSchema.parse({
      tracker: 'despachos',
      workType: 'despacho',
      assigneeField: 'responsable',
      statusField: 'estado',
      doneValues: ['Despachado'],
      cancelledValues: ['Anulado'],
      dueField: 'entrega',
      quantityField: 'guias',
      unit: 'guías',
    });
    const row = {
      id: 'r1',
      label: 'Pedido 881',
      values: { responsable: 'laura', estado: 'DESPACHADO', entrega: '2026-09-03', guias: '1.200' },
      created_at: T0,
      updated_at: '2026-09-02T20:00:00Z',
    };
    expect(trackerRowToWork(mapping, row, PEOPLE)).toMatchObject({
      assigneeId: LAURA,
      status: 'done',
      quantity: 1200,
      unit: 'guías',
      dueAt: '2026-09-03',
      title: 'Pedido 881',
      source: { kind: 'tracker_row', system: 'despachos', ref: 'r1' },
    });
    const stranger = trackerRowToWork(
      mapping,
      { ...row, values: { responsable: 'Don Jorge', estado: 'Anulado' } },
      PEOPLE,
    );
    expect(stranger).toMatchObject({
      assigneeId: null,
      assigneeLabel: 'Don Jorge',
      status: 'cancelled',
    });
    expect(numberValue('12,5')).toBe(12.5);
    expect(numberValue('abc')).toBeNull();
  });

  it('propone el campo de responsable por su nombre y por sus valores', () => {
    const proposal = proposeTrackerMapping(
      [
        { key: 'pedido', label: 'Pedido', type: 'text', required: true },
        { key: 'quien', label: 'Quién despacha', type: 'text', required: false },
        {
          key: 'estado',
          label: 'Estado',
          type: 'select',
          required: false,
          options: ['Pendiente', 'Despachado', 'Anulado'],
        },
        { key: 'cantidad', label: 'Cantidad', type: 'number', required: false },
      ],
      [
        {
          id: 'a',
          label: 'P1',
          values: { pedido: 'P1', quien: 'Laura' },
          created_at: T0,
          updated_at: T0,
        },
        {
          id: 'b',
          label: 'P2',
          values: { pedido: 'P2', quien: 'Andrés' },
          created_at: T0,
          updated_at: T0,
        },
      ],
      PEOPLE,
    );
    expect(proposal.mapping).toMatchObject({
      assigneeField: 'quien',
      statusField: 'estado',
      doneValues: ['Despachado'],
      cancelledValues: ['Anulado'],
      quantityField: 'cantidad',
    });
    expect(proposal.assigneeCandidates[0]).toMatchObject({ key: 'quien', matchedPeople: 2 });
  });
});

describe('idempotencia', () => {
  it('la misma identidad de fuente dos veces es una fila; lo igual no se reescribe', async () => {
    const { db, tables } = world();
    const draft = managementCaseToWork({
      id: 'c1',
      created_at: T0,
      updated_at: T0,
      data: { title: 'Asunto', ownerId: LAURA, dueOn: '2026-09-15', state: 'open' },
    });
    if (!draft) throw new Error('sin borrador');
    const first = await upsertWorkItems(db, [draft]);
    const second = await upsertWorkItems(db, [draft]);
    expect(first.inserted).toHaveLength(1);
    expect(second).toMatchObject({ inserted: [], updated: [], unchanged: 1 });
    expect(tables.work_items).toHaveLength(1);
    expect(tables.work_items?.[0]?.organization_id).toBe(ORG);
  });

  it('una fecha de cierre aproximada no se mueve cuando alguien vuelve a tocar la fila', async () => {
    const { db, tables } = world();
    const base = {
      id: 'c9',
      created_at: T0,
      data: { title: 'Asunto', ownerId: LAURA, dueOn: '2026-09-15', state: 'verified' },
    };
    await upsertWorkItems(db, [
      managementCaseToWork({ ...base, updated_at: '2026-09-10T10:00:00.000Z' }) as never,
    ]);
    await upsertWorkItems(db, [
      managementCaseToWork({ ...base, updated_at: '2026-09-20T10:00:00.000Z' }) as never,
    ]);
    expect(tables.work_items?.[0]?.done_at).toBe('2026-09-10T10:00:00.000Z');
  });

  it('work.record dicho dos veces con los mismos hechos cuenta una vez', async () => {
    const { db, tables } = world();
    const input = {
      person: 'Laura',
      workType: 'despacho',
      title: 'Despacho de guías',
      quantity: 12,
      unit: 'guías',
      on: '2026-09-01',
    };
    const a = await workRecord.handler(input as never, ctx(db, ADMIN));
    const b = await workRecord.handler(input as never, ctx(db, ADMIN));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(tables.work_items).toHaveLength(1);
    expect(tables.work_items?.[0]).toMatchObject({
      assignee_id: LAURA,
      status: 'done',
      quantity: 12,
      recorded_by: ADMIN,
      source_kind: 'chat',
    });
    expect(
      factsRef({
        assignee: LAURA,
        workType: 'Despacho',
        title: 'despacho de guias',
        day: '2026-09-01',
        quantity: 12,
        unit: 'Guías',
      }),
    ).toBe(tables.work_items?.[0]?.source_ref);
  });

  it('un tipo que la empresa no mide no se guarda', async () => {
    const { db, tables } = world({
      work_settings: [{ organization_id: ORG, measured_types: ['despacho'] }],
    });
    await expect(
      workRecord.handler({ workType: 'visita', title: 'Visita' } as never, ctx(db, LAURA)),
    ).rejects.toThrow(/no es un tipo de trabajo que esta empresa mida/);
    expect(tables.work_items ?? []).toHaveLength(0);
  });
});

describe('la sincronización', () => {
  const seed = () => ({
    management_cases: [
      {
        id: 'mc1',
        organization_id: ORG,
        created_at: T0,
        updated_at: '2026-09-02T00:00:00.000Z',
        data: { title: 'Renovar póliza', ownerId: ANDRES, dueOn: '2026-09-20', state: 'working' },
      },
      {
        id: 'mc-otra',
        organization_id: OTHER,
        created_at: T0,
        updated_at: T0,
        data: { title: 'De otra empresa', ownerId: null, dueOn: '2026-09-20', state: 'open' },
      },
    ],
    commitments: [
      {
        id: 'k1',
        organization_id: ORG,
        title: 'Pagar arriendo',
        kind: 'internal',
        due_on: '2026-09-05',
        state: 'overdue',
        met_at: null,
        dropped_at: null,
        owner_user_id: LAURA,
        review_state: 'confirmed',
        created_at: T0,
        updated_at: '2026-09-03T00:00:00.000Z',
      },
    ],
    mcp_pending_actions: [
      {
        id: 'p1',
        organization_id: ORG,
        user_id: LAURA,
        tool_id: 'gmail.send_message',
        input: { to: ['secreto@cliente.co'], body: 'texto privado' },
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        decision: null,
        decided_at: null,
      },
    ],
  });

  it('trae Gerencia, compromisos y aprobaciones de SU empresa, sin el payload, y es idempotente', async () => {
    const { db, tables } = world(seed());
    const first = await syncWork(db, ORG);
    expect(first.warnings).toEqual([]);
    const items = tables.work_items ?? [];
    expect(items.map((i) => i.source_ref).sort()).toEqual(['k1', 'mc1', 'p1']);
    expect(JSON.stringify(items)).not.toContain('secreto@cliente.co');
    expect(JSON.stringify(items)).not.toContain('texto privado');
    expect(items.find((i) => i.source_ref === 'p1')?.title).toBe(
      'Espera de decisión: Enviar este correo tal cual',
    );

    const second = await syncWork(db, ORG);
    const totals = Object.values(second.sources);
    expect(totals.reduce((n, s) => n + s.inserted + s.updated, 0)).toBe(0);
    expect(tables.work_items).toHaveLength(3);
    expect(tables.work_settings?.[0]?.sync_state).toMatchObject({
      management_case: '2026-09-02T00:00:00.000Z',
      commitment: '2026-09-03T00:00:00.000Z',
    });
  });

  it('una fuente apagada en los ajustes no entra', async () => {
    const { db, tables } = world({
      ...seed(),
      work_settings: [{ organization_id: ORG, sources: ['commitment'] }],
    });
    await syncWork(db, ORG);
    expect((tables.work_items ?? []).map((i) => i.source_ref)).toEqual(['k1']);
  });
});

describe('una tabla mapeada se vuelve trabajo', () => {
  const trackerSeed = () => ({
    trackers: [
      {
        id: 't1',
        organization_id: ORG,
        slug: 'despachos',
        name: 'Despachos',
        description: '',
        fields: [
          { key: 'pedido', label: 'Pedido', type: 'text', required: true },
          { key: 'responsable', label: 'Responsable', type: 'text', required: false },
          {
            key: 'estado',
            label: 'Estado',
            type: 'select',
            required: false,
            options: ['Pendiente', 'Despachado'],
          },
          { key: 'guias', label: 'Guías', type: 'number', required: false },
        ],
        created_by: ADMIN,
        created_at: T0,
        updated_at: T0,
      },
    ],
    tracker_rows: [
      {
        id: 'r1',
        organization_id: ORG,
        tracker_id: 't1',
        label: 'P-1',
        values: { pedido: 'P-1', responsable: 'Laura', estado: 'Despachado', guias: 12 },
        created_by: ADMIN,
        created_at: T0,
        updated_at: '2026-09-02T00:00:00.000Z',
      },
      {
        id: 'r2',
        organization_id: ORG,
        tracker_id: 't1',
        label: 'P-2',
        values: { pedido: 'P-2', responsable: 'andres@andina.co', estado: 'Pendiente' },
        created_by: ADMIN,
        created_at: T0,
        updated_at: '2026-09-03T00:00:00.000Z',
      },
    ],
  });
  const mapTracker = {
    tracker: 'despachos',
    workType: 'Despacho',
    assigneeField: 'responsable',
    statusField: 'estado',
    doneValues: ['Despachado'],
    quantityField: 'guias',
    unit: 'guías',
  };

  it('work.configure (administrador) guarda el mapeo y carga las filas', async () => {
    const { db, tables } = world(trackerSeed());
    const out = await workConfigure.handler({ mapTracker } as never, ctx(db, ADMIN));
    expect(out.loaded).toBe(2);
    const items = tables.work_items ?? [];
    expect(items.find((i) => i.source_ref === 'r1')).toMatchObject({
      assignee_id: LAURA,
      work_type: 'despacho',
      status: 'done',
      quantity: 12,
      unit: 'guías',
      source_system: 'despachos',
    });
    expect(items.find((i) => i.source_ref === 'r2')).toMatchObject({
      assignee_id: ANDRES,
      status: 'open',
    });

    // Se borra una fila y se relee entera: lo abierto que ya no existe, ya no aplica.
    tables.tracker_rows = (tables.tracker_rows ?? []).filter((r) => r.id !== 'r2');
    await syncWork(db, ORG, { full: true });
    expect((tables.work_items ?? []).find((i) => i.source_ref === 'r2')?.status).toBe('cancelled');
  });

  it('quien no administra no configura', async () => {
    const { db } = world(trackerSeed());
    await expect(workConfigure.handler({ mapTracker } as never, ctx(db, LAURA))).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('un campo que no existe se rechaza con su nombre', async () => {
    const { db } = world(trackerSeed());
    await expect(
      workConfigure.handler(
        { mapTracker: { ...mapTracker, assigneeField: 'vendedor' } } as never,
        ctx(db, ADMIN),
      ),
    ).rejects.toThrow(/«vendedor» no es un campo de Despachos/);
  });

  it('reasignar una fila cambia su responsable EN la tabla y avisa', async () => {
    const { db, tables } = world(trackerSeed());
    await workConfigure.handler({ mapTracker } as never, ctx(db, ADMIN));
    const open = (tables.work_items ?? []).find((i) => i.source_ref === 'r2');
    const jobs: Array<{ name: string; data: Record<string, unknown> }> = [];
    const out = await workAssign.handler(
      { itemIds: [String(open?.id)], person: 'Laura' } as never,
      ctx(db, ADMIN, {
        enqueueJob: async (name, data) => {
          jobs.push({ name, data });
          return true;
        },
      }),
    );
    expect(out.assigned).toBe(1);
    expect(out.notified).toBe(true);
    expect(jobs[0]).toMatchObject({ name: 'work/assigned', data: { assigneeId: LAURA } });
    expect((tables.tracker_rows ?? []).find((r) => r.id === 'r2')?.values).toMatchObject({
      responsable: 'Laura Gómez',
    });
    // Y la próxima sincronización no lo devuelve a Andrés.
    await syncWork(db, ORG, { full: true });
    expect((tables.work_items ?? []).find((i) => i.source_ref === 'r2')?.assignee_id).toBe(LAURA);
  });

  it('quien no administra sólo pasa lo suyo', async () => {
    const { db, tables } = world(trackerSeed());
    await workConfigure.handler({ mapTracker } as never, ctx(db, ADMIN));
    const andres = (tables.work_items ?? []).find((i) => i.source_ref === 'r2');
    const out = await workAssign.handler(
      { itemIds: [String(andres?.id)], person: 'yo' } as never,
      ctx(db, LAURA),
    );
    expect(out.assigned).toBe(0);
    expect(out.refused[0]?.reason).toMatch(/tu propio trabajo/);
  });

  it('«Marcar hecho» en una fila: el estado «hecho» EN la tabla, el registro al día, y se deshace', async () => {
    const { db, tables } = world(trackerSeed());
    await workConfigure.handler({ mapTracker } as never, ctx(db, ADMIN));
    const { trackerMappings: mappings } = await readWorkSettings(db);
    const open = (tables.work_items ?? []).find((i) => i.source_ref === 'r2');
    const [item] = await getWorkItemsByIds(db, [String(open?.id)]);
    if (!item) throw new Error('falta el ítem');
    const row = () => (tables.tracker_rows ?? []).find((r) => r.id === 'r2');

    // Laura no responde por él ni administra: no.
    await expect(
      markTrackerItemDone(db, {
        item,
        mappings,
        actor: { id: LAURA, admin: false },
        today: '2026-10-02',
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(row()?.values).toMatchObject({ estado: 'Pendiente' });

    // Andrés, que responde por él: el primer valor «hecho» queda en la tabla.
    const change = await markTrackerItemDone(db, {
      item,
      mappings,
      actor: { id: ANDRES, admin: false },
      today: '2026-10-02',
    });
    expect(change).toMatchObject({
      tracker: 'despachos',
      rowId: 'r2',
      field: 'estado',
      previous: 'Pendiente',
      value: 'Despachado',
      doneAtField: null,
    });
    expect(row()?.values).toMatchObject({ pedido: 'P-2', estado: 'Despachado' });
    await syncWork(db, ORG, { onlyTracker: 'despachos' });
    expect((tables.work_items ?? []).find((i) => i.source_ref === 'r2')?.status).toBe('done');

    // Deshacer: vuelve a «Pendiente» y el registro lo reabre.
    await undoTrackerItemDone(db, {
      item,
      mappings,
      actor: { id: ANDRES, admin: false },
      previous: change.previous,
      clearDoneAt: false,
    });
    expect(row()?.values).toMatchObject({ estado: 'Pendiente' });
    await syncWork(db, ORG, { onlyTracker: 'despachos' });
    expect((tables.work_items ?? []).find((i) => i.source_ref === 'r2')?.status).toBe('open');

    // Si alguien cambió la fila después, deshacer no la pisa.
    await expect(
      undoTrackerItemDone(db, {
        item,
        mappings,
        actor: { id: ANDRES, admin: false },
        previous: 'Pendiente',
        clearDoneAt: false,
      }),
    ).rejects.toThrow(/ya cambió/);

    // Quien administra (o es dueño) marca lo de otro.
    await markTrackerItemDone(db, {
      item,
      mappings,
      actor: { id: ADMIN, admin: true },
      today: '2026-10-02',
    });
    expect(row()?.values).toMatchObject({ estado: 'Despachado' });
  });

  it('sin estado «hecho» en el mapeo, o con un ítem que no es de tabla, no se marca', async () => {
    const { db, tables } = world(trackerSeed());
    await workConfigure.handler(
      { mapTracker: { ...mapTracker, statusField: null, doneValues: [] } } as never,
      ctx(db, ADMIN),
    );
    const { trackerMappings: mappings } = await readWorkSettings(db);
    const open = (tables.work_items ?? []).find((i) => i.source_ref === 'r2');
    const [item] = await getWorkItemsByIds(db, [String(open?.id)]);
    if (!item) throw new Error('falta el ítem');
    await expect(
      markTrackerItemDone(db, {
        item,
        mappings,
        actor: { id: ANDRES, admin: false },
        today: '2026-10-02',
      }),
    ).rejects.toThrow(/qué estado es «hecho»/);
    await expect(
      markTrackerItemDone(db, {
        item: { ...item, source: { kind: 'chat', system: null, ref: 'x' } },
        mappings,
        actor: { id: ANDRES, admin: true },
        today: '2026-10-02',
      }),
    ).rejects.toThrow(/no es una fila de tabla/);
  });
});

describe('quién ve qué', () => {
  async function seeded() {
    const w = world();
    for (const [who, title] of [
      [LAURA, 'Despacho Laura'],
      [ANDRES, 'Despacho Andrés'],
    ] as const) {
      await workRecord.handler(
        { person: who, workType: 'despacho', title, status: 'open', dueOn: '2026-01-02' } as never,
        ctx(w.db, ADMIN),
      );
    }
    await workRecord.handler(
      { person: 'Don Jorge', workType: 'despacho', title: 'Sin cuenta', status: 'open' } as never,
      ctx(w.db, ADMIN),
    );
    return w;
  }

  it('cada persona ve todo lo suyo y nada de los demás', async () => {
    const { db } = await seeded();
    const mine = await workQuery.handler({} as never, ctx(db, LAURA));
    expect(mine.items.map((i) => i.title)).toEqual(['Despacho Laura']);
    expect(mine.scope).toBe('own');
    expect(mine.items[0]?.overdue).toBe(true);
    await expect(workQuery.handler({ person: 'Andrés' } as never, ctx(db, LAURA))).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      workQuery.handler({ status: 'unassigned' } as never, ctx(db, LAURA)),
    ).rejects.toThrow(ForbiddenError);
  });

  it('quien administra ve al equipo y lo que no tiene responsable', async () => {
    const { db } = await seeded();
    const all = await workQuery.handler({} as never, ctx(db, ADMIN));
    expect(all.items.map((i) => i.title).sort()).toEqual([
      'Despacho Andrés',
      'Despacho Laura',
      'Sin cuenta',
    ]);
    const nobody = await workQuery.handler({ status: 'unassigned' } as never, ctx(db, ADMIN));
    expect(nobody.items.map((i) => i.person)).toEqual(['Don Jorge (sin cuenta)']);
  });

  it('con visibilidad de equipo, cada quien ve lo de su equipo', () => {
    const meta = new Map([
      [LAURA, { team: 'Bodega' }],
      [ANDRES, { team: 'bodega ' }],
      [ADMIN, { team: 'Gerencia' }],
    ]);
    const team = scopeFor({ viewerId: LAURA, admin: false, visibility: 'team', meta });
    expect([...(team.visibleIds ?? [])].sort()).toEqual([LAURA, ANDRES].sort());
    expect(
      scopeFor({ viewerId: LAURA, admin: false, visibility: 'self', meta }).visibleIds,
    ).toEqual(new Set([LAURA]));
    expect(scopeFor({ viewerId: null, admin: true, visibility: 'all', meta }).visibleIds).toEqual(
      new Set(),
    );
  });

  it('las vistas aplican la misma regla: cortex.trabajo y cortex.equipo', async () => {
    const { db } = await seeded();
    const laura = await readPlatformSource(db, 'cortex.trabajo', 100, '2026-09-30', {
      viewerId: LAURA,
    });
    expect(laura?.rows.map((r) => r.values.titulo)).toEqual(['Despacho Laura']);
    const nobody = await readPlatformSource(db, 'cortex.trabajo', 100, '2026-09-30', {
      viewerId: null,
    });
    expect(nobody?.rows).toEqual([]);
    const admin = await readPlatformSource(db, 'cortex.trabajo', 100, '2026-09-30', {
      viewerId: ADMIN,
    });
    expect(admin?.rows).toHaveLength(3);

    const today = new Date().toISOString().slice(0, 10);
    const equipoLaura = await readPlatformSource(db, 'cortex.equipo', 100, today, {
      viewerId: LAURA,
    });
    expect(new Set(equipoLaura?.rows.map((r) => r.values.persona))).toEqual(
      new Set(['Laura Gómez']),
    );
    const equipoAdmin = await readPlatformSource(db, 'cortex.equipo', 100, today, {
      viewerId: ADMIN,
    });
    expect(new Set(equipoAdmin?.rows.map((r) => r.values.persona))).toEqual(
      new Set(['Laura Gómez', 'Andrés Peña']),
    );
    expect(equipoLaura?.rows.find((r) => r.values.tipo === 'Todos')?.values.abiertos).toBe(1);
  });

  it('lo de otra empresa no aparece aunque se llame igual', async () => {
    const { db, raw } = await seeded();
    const other = createOrgScopedClient(raw, OTHER);
    const theirs = await listWorkItems(other);
    expect(theirs.items).toEqual([]);
    expect((await listWorkItems(db)).items).toHaveLength(3);
  });
});

describe('días fuera: de la persona y del administrador', () => {
  it('la regla, pura', () => {
    const me = { id: LAURA, admin: false };
    expect(workPersonChangeRefusal(me, LAURA, { addAwayDays: ['2026-10-05'] })).toBeNull();
    expect(workPersonChangeRefusal(me, LAURA, { team: 'Bodega' })).toMatch(/administrador/);
    expect(workPersonChangeRefusal(me, ANDRES, { addAwayDays: ['2026-10-05'] })).toMatch(
      /administrador/,
    );
    expect(
      workPersonChangeRefusal({ id: ADMIN, admin: true }, ANDRES, { team: 'Bodega' }),
    ).toBeNull();
  });

  it('la persona anota y quita SUS días; no los de otro; el administrador sí', async () => {
    const { db, tables } = world();
    const mine = await updateWorkPerson(db, {
      actor: { id: LAURA, admin: false },
      userId: LAURA,
      change: { addAwayDays: ['2026-10-06', '2026-10-05'] },
    });
    expect(mine.awayDays).toEqual(['2026-10-05', '2026-10-06']);
    const less = await updateWorkPerson(db, {
      actor: { id: LAURA, admin: false },
      userId: LAURA,
      change: { removeAwayDays: ['2026-10-06'] },
    });
    expect(less.awayDays).toEqual(['2026-10-05']);
    await expect(
      updateWorkPerson(db, {
        actor: { id: LAURA, admin: false },
        userId: ANDRES,
        change: { addAwayDays: ['2026-10-05'] },
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      updateWorkPerson(db, {
        actor: { id: LAURA, admin: false },
        userId: LAURA,
        change: { team: 'Gerencia' },
      }),
    ).rejects.toThrow(ForbiddenError);
    const byAdmin = await updateWorkPerson(db, {
      actor: { id: ADMIN, admin: true },
      userId: ANDRES,
      change: { team: 'Bodega', addAwayDays: ['2026-10-07'] },
    });
    expect(byAdmin).toMatchObject({ team: 'Bodega', awayDays: ['2026-10-07'] });
    expect(tables.work_people_meta).toHaveLength(2);
    await expect(
      updateWorkPerson(db, {
        actor: { id: ADMIN, admin: true },
        userId: '99999999-9999-4999-8999-999999999999',
        change: { team: 'X' },
      }),
    ).rejects.toThrow(/no es de este espacio/);
  });
});

describe('el dueño de la empresa administra el equipo', () => {
  /**
   * Andrés es `member` en el directorio pero DUEÑO de la empresa en better-auth
   * (ba_member.role = 'owner'): tiene los mismos poderes de equipo que un
   * `org_admin`. Los ids de better-auth no son los del directorio; los une el
   * correo, sin mayúsculas.
   */
  const ownership = (opts: { kind?: string; role?: string; org?: string } = {}) => ({
    ba_organization: [
      { id: ORG, name: 'Andina', kind: opts.kind ?? 'company' },
      { id: OTHER, name: 'Otra', kind: 'company' },
    ],
    ba_user: [{ id: 'ba-andres', email: 'Andres@Andina.co', name: 'Andrés Peña' }],
    ba_member: [
      {
        id: 'm-andres',
        organizationId: opts.org ?? ORG,
        userId: 'ba-andres',
        role: opts.role ?? 'owner',
      },
    ],
  });

  it('isCompanyManager: org_admin o dueño de una empresa; nada más', async () => {
    expect(await isCompanyManager(world(ownership()).db, ANDRES)).toBe(true);
    expect(await isWorkspaceOwner(world(ownership()).db, ANDRES)).toBe(true);
    expect(await isCompanyManager(world(ownership()).db, ADMIN)).toBe(true);
    expect(await isCompanyManager(world(ownership()).db, LAURA)).toBe(false);
    // Miembro, no dueño.
    expect(await isCompanyManager(world(ownership({ role: 'member' })).db, ANDRES)).toBe(false);
    // Dueño de OTRA empresa: aquí no cuenta.
    expect(await isCompanyManager(world(ownership({ org: OTHER })).db, ANDRES)).toBe(false);
    // Ser dueño de un espacio personal nunca da permisos de empresa.
    expect(await isCompanyManager(world(ownership({ kind: 'personal' })).db, ANDRES)).toBe(false);
    // Sin persona, o con un handle sin empresa, no.
    expect(await isCompanyManager(world(ownership()).db, null)).toBe(false);
    expect(await isWorkspaceOwner(world(ownership()).raw, ANDRES)).toBe(false);
  });

  it('configura, reasigna lo de otros, ve todo y edita días fuera de cualquiera', async () => {
    const { db, tables } = world(ownership());
    await workRecord.handler(
      { person: LAURA, workType: 'despacho', title: 'Despacho Laura', status: 'open' } as never,
      ctx(db, ADMIN),
    );
    await workRecord.handler(
      { person: 'Don Jorge', workType: 'despacho', title: 'Sin cuenta', status: 'open' } as never,
      ctx(db, ADMIN),
    );

    // Ve todo, también lo que no tiene responsable.
    const all = await workQuery.handler({} as never, ctx(db, ANDRES));
    expect(all.items.map((i) => i.title).sort()).toEqual(['Despacho Laura', 'Sin cuenta']);
    const view = await readPlatformSource(db, 'cortex.trabajo', 100, '2026-09-30', {
      viewerId: ANDRES,
    });
    expect(view?.rows).toHaveLength(2);

    // Reasigna lo de Laura.
    const laura = (tables.work_items ?? []).find((i) => i.title === 'Despacho Laura');
    const moved = await workAssign.handler(
      { itemIds: [String(laura?.id)], person: 'yo' } as never,
      ctx(db, ANDRES),
    );
    expect(moved.assigned).toBe(1);

    // Configura qué se mide.
    const configured = await workConfigure.handler(
      { teamVisibility: 'team' } as never,
      ctx(db, ANDRES),
    );
    expect(configured).toBeTruthy();

    // Días fuera de otra persona.
    const away = await workUpdatePerson.handler(
      { person: 'Laura', addAwayDays: ['2026-10-05'] } as never,
      ctx(db, ANDRES),
    );
    expect(away.awayDays).toEqual(['2026-10-05']);
  });

  it('el mismo Andrés, sin ser dueño, sigue sin poder', async () => {
    const { db } = world(ownership({ role: 'member' }));
    await expect(
      workConfigure.handler({ teamVisibility: 'all' } as never, ctx(db, ANDRES)),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      workUpdatePerson.handler(
        { person: 'Laura', addAwayDays: ['2026-10-05'] } as never,
        ctx(db, ANDRES),
      ),
    ).rejects.toThrow(ForbiddenError);
  });
});
