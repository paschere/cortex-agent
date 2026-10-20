import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { viewSpecSchema } from '../../../views/spec';
import { CONTROL_EN_PLANTA } from '../../templates';
import { type NoticeDelivery, deliverStored } from '../dispatch';
import {
  type NoticeAppModel,
  interestsFor,
  resolveRoleNotices,
  summarizeRoleNotices,
} from '../interest';
import {
  type NoticeEvent,
  type NoticePerson,
  type NoticeTracker,
  type PlannedNotice,
  changedSelects,
  planNotices,
} from '../plan';
import {
  BURST_SINGLE,
  type InboxNotice,
  type NoticePrefs,
  burstMode,
  groupNotices,
  isMuted,
  levelAllows,
  parseNoticeConfig,
  parsePrefs,
  personKey,
  unreadByScreen,
} from '../shape';
import type { StoredNotice } from '../store';

/**
 * QUIÉN RECIBE QUÉ (0231), con la app «Control en planta» de las plantillas
 * (operario que registra y ve lo suyo, supervisor que aprueba, gerencia que
 * mira) y una app de tareas con «Asignar a…».
 */

const guias = CONTROL_EN_PLANTA.trackers[0];
if (!guias) throw new Error('fixture');
const tracker: NoticeTracker = {
  id: 't-guias',
  slug: guias.slug,
  name: guias.name,
  fields: guias.fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    ...(f.options ? { options: f.options } : {}),
  })),
};

function plantaApp(config: unknown = {}): NoticeAppModel {
  return {
    id: 'app-planta',
    slug: 'planta',
    name: 'Planta',
    screens: CONTROL_EN_PLANTA.screens.map((s) => ({
      slug: s.slug,
      title: s.title,
      roles: s.roles,
      spec: s.spec,
    })),
    roles: CONTROL_EN_PLANTA.roles.map((r) => ({
      key: r.key,
      name: r.name,
      permissions: r.permissions,
    })),
    config: parseNoticeConfig(config),
  };
}

const person = (
  id: string,
  roleKey: string,
  kind: NoticePerson['kind'] = 'member',
): NoticePerson => ({
  kind,
  id,
  name: id.toUpperCase(),
  email: `${id}@x.co`,
  roleKey,
  attributes: {},
});
const ana = person('ana', 'operario');
const beto = person('beto', 'operario');
const sara = person('sara', 'supervisor');
const gus = person('gus', 'gerencia');
const people = [ana, beto, sara, gus];

const created: NoticeEvent = {
  kind: 'row_created',
  rowId: 'r1',
  before: null,
  after: { numero_guia: '123-1', estado: 'Pendiente' },
  label: '123-1',
  version: '2026-10-20T10:00:00Z',
  actor: { kind: 'member', id: 'ana' },
  actorName: 'Ana',
};
const owner = { created_by: 'ana', created_by_app_user: null };
const noPrefs = new Map<string, NoticePrefs>();

const plan = (over: Partial<Parameters<typeof planNotices>[0]> = {}) =>
  planNotices({
    app: plantaApp(),
    tracker,
    event: created,
    row: owner,
    people,
    prefs: noPrefs,
    ...over,
  });
const kindsOf = (list: PlannedNotice[]) => Object.fromEntries(list.map((p) => [p.person.id, p.kind]));

describe('de quién depende cada tabla', () => {
  it('el operario que registra y sólo ve lo suyo no depende de filas ajenas; supervisor y gerencia sí', () => {
    const roles = Object.fromEntries(
      interestsFor(plantaApp(), 'guias').map((i) => [i.roleKey, i]),
    );
    expect(roles.operario?.sees).toBe('own');
    expect(roles.operario?.screens.map((s) => s.slug)).toEqual(['mis_registros']);
    expect(roles.supervisor?.approves).toBe(true);
    expect(roles.gerencia?.sees).toBe('all');
  });

  it('un formulario sólo escribe: una pantalla que sólo registra no cuenta como «leer»', () => {
    const app = plantaApp();
    const onlyForm = { ...app, screens: app.screens.filter((s) => s.slug === 'registrar') };
    // El operario sólo tiene el formulario: no lee la tabla en ninguna pantalla.
    expect(interestsFor(onlyForm, 'guias').find((i) => i.roleKey === 'operario')).toBeUndefined();
  });

  it('valores por defecto: «nuevo» para supervisor y gerencia, no para el operario', () => {
    const summary = Object.fromEntries(summarizeRoleNotices(plantaApp()).map((r) => [r.roleKey, r]));
    expect(summary.supervisor).toMatchObject({ new: true, assigned: true, approval: true, custom: false });
    expect(summary.gerencia).toMatchObject({ new: true, approval: false });
    expect(summary.operario).toMatchObject({ new: false, assigned: true, changed: true });
  });

  it('lo guardado por app manda sobre el valor por defecto, y `only` limita las tablas', () => {
    const role = plantaApp().roles[1];
    if (!role) throw new Error('rol');
    const i = interestsFor(plantaApp(), 'guias').find((x) => x.roleKey === 'supervisor') ?? null;
    expect(resolveRoleNotices(role, i, { new: false }, 'guias').new).toBe(false);
    expect(resolveRoleNotices(role, i, { only: ['otra'] }, 'guias').new).toBe(false);
    expect(resolveRoleNotices(role, i, { only: ['guias'] }, 'guias').new).toBe(true);
    const s = summarizeRoleNotices(plantaApp({ roles: { operario: { new: true } } }));
    expect(s.find((r) => r.roleKey === 'operario')).toMatchObject({ new: true, custom: true });
  });
});

describe('quién recibe qué al crear una fila', () => {
  it('avisa al supervisor que aprueba y a gerencia; nunca a quien la registró ni a otro operario que no la ve', () => {
    const out = plan();
    expect(kindsOf(out)).toEqual({ sara: 'approval', gus: 'new' });
    const toSara = out.find((p) => p.person.id === 'sara');
    expect(toSara?.title).toBe('Pendiente de tu aprobación: 123-1');
    expect(toSara?.screen).toBe('registrar');
    expect(out.find((p) => p.person.id === 'gus')?.title).toBe('Nuevo en Tablero');
  });

  it('una fila que no entra en estado «por aprobar» deja a Sara con un «nuevo»', () => {
    const out = plan({ event: { ...created, after: { ...created.after, estado: 'Aprobada' } } });
    expect(kindsOf(out)).toEqual({ sara: 'new', gus: 'new' });
  });

  it('respeta `read: own`: Beto no recibe lo que Ana registró aunque se encienda «nuevo» para su rol', () => {
    const app = plantaApp({ roles: { operario: { new: true } } });
    const out = plan({ app });
    expect(out.find((p) => p.person.id === 'beto')).toBeUndefined();
  });

  it('respeta los atributos: un cliente sólo recibe filas de su cliente', () => {
    const app: NoticeAppModel = {
      ...plantaApp(),
      roles: [
        ...plantaApp().roles,
        {
          key: 'cliente',
          name: 'Cliente',
          permissions: {
            tables: {
              guias: {
                read: { field: 'ubicacion', equals: '$user.cliente' },
                create: false,
                edit: 'none',
                actions: [],
              },
            },
            export: false,
          },
        },
      ],
      screens: [
        ...plantaApp().screens,
        { slug: 'mis_pedidos', title: 'Mis pedidos', roles: ['cliente'], spec: plantaApp().screens[1]?.spec as never },
      ],
    };
    const andina: NoticePerson = { ...person('c1', 'cliente', 'app_user'), attributes: { cliente: 'Andina' } };
    const otro: NoticePerson = { ...person('c2', 'cliente', 'app_user'), attributes: { cliente: 'Otro' } };
    const out = planNotices({
      app,
      tracker,
      event: { ...created, after: { ...created.after, ubicacion: 'Andina' } },
      row: owner,
      people: [andina, otro],
      prefs: noPrefs,
    });
    expect(out.map((p) => [p.person.id, p.kind])).toEqual([['c1', 'new']]);
  });

  it('el id de un miembro y el de un externo nunca se confunden al excluir a quien actuó', () => {
    const externo = person('ana', 'gerencia', 'app_user');
    const out = plan({ people: [externo] });
    expect(out.map((p) => p.person.kind)).toEqual(['app_user']);
  });

  it('un cambio automático o de sincronización avisa a todos los que dependen', () => {
    const out = plan({ event: { ...created, actor: { kind: 'system', id: null } } });
    expect(out.map((p) => p.person.id).sort()).toEqual(['gus', 'sara']);
  });
});

describe('cambios de lo suyo', () => {
  const updated: NoticeEvent = {
    ...created,
    kind: 'row_updated',
    before: { numero_guia: '123-1', estado: 'Pendiente' },
    after: { numero_guia: '123-1', estado: 'Aprobada' },
    version: '2026-10-20T10:05:00Z',
    actor: { kind: 'member', id: 'sara' },
    actorName: 'Sara',
  };

  it('le avisa al creador (y sólo a él) cuando cambia un campo de opciones', () => {
    const out = plan({ event: updated });
    expect(kindsOf(out)).toEqual({ ana: 'changed' });
    const note = out[0];
    expect(note?.title).toBe('Cambió estado de «123-1»');
    expect(note?.body).toBe('Estado: Pendiente → Aprobada.');
  });

  it('no avisa si no cambió ningún campo de opciones, ni si lo cambió el mismo creador', () => {
    expect(plan({ event: { ...updated, after: { ...updated.after, estado: 'Pendiente' } } })).toEqual([]);
    expect(plan({ event: { ...updated, actor: { kind: 'member', id: 'ana' } } })).toEqual([]);
  });

  it('un cambio de estado de otra fila no llega a un operario que no la creó', () => {
    const out = plan({ event: updated, row: { created_by: 'beto', created_by_app_user: null } });
    expect(kindsOf(out)).toEqual({ beto: 'changed' });
  });

  it('changedSelects lista sólo los de opciones que cambiaron', () => {
    expect(changedSelects(tracker, updated.before, updated.after).map((c) => c.key)).toEqual(['estado']);
    expect(changedSelects(tracker, null, updated.after)).toEqual([]);
  });
});

describe('asignaciones', () => {
  const tareasSpec = viewSpecSchema.parse({
    version: 1,
    blocks: [
      {
        id: 'lista',
        type: 'table',
        tracker: 'tareas',
        title: 'Tareas',
        columns: ['titulo', 'asignado', 'estado'],
        actions: [{ id: 'asignar', label: 'Asignar', kind: 'assign', field: 'asignado' }],
      },
    ],
  });
  const misSpec = viewSpecSchema.parse({
    version: 1,
    blocks: [{ id: 'mis', type: 'table', tracker: 'tareas', title: 'Mis tareas', columns: ['titulo', 'estado'] }],
  });
  const tareas: NoticeTracker = {
    id: 't-tareas',
    slug: 'tareas',
    name: 'Tareas',
    fields: [
      { key: 'titulo', label: 'Título', type: 'text' },
      { key: 'asignado', label: 'Asignado', type: 'text' },
      { key: 'estado', label: 'Estado', type: 'select', options: ['Pendiente', 'Hecha'] },
    ],
  };
  const app: NoticeAppModel = {
    id: 'app-tareas',
    slug: 'tareas',
    name: 'Tareas',
    screens: [
      { slug: 'todas', title: 'Todas', roles: ['jefe'], spec: tareasSpec },
      { slug: 'mis_tareas', title: 'Mis tareas', roles: ['tecnico'], spec: misSpec },
    ],
    roles: [
      {
        key: 'jefe',
        name: 'Jefe',
        permissions: {
          tables: { tareas: { read: 'all', create: true, edit: 'all', actions: ['asignar'] } },
          export: false,
        },
      },
      {
        key: 'tecnico',
        name: 'Técnico',
        permissions: {
          tables: {
            tareas: { read: { field: 'asignado', equals: '$user.id' }, create: false, edit: 'none', actions: [] },
          },
          export: false,
        },
      },
    ],
    config: { roles: {} },
  };
  const jefe = person('jefe1', 'jefe');
  const t1 = person('11111111-1111-4111-8111-111111111111', 'tecnico', 'app_user');
  const t2 = person('22222222-2222-4222-8222-222222222222', 'tecnico', 'app_user');
  const base: Omit<NoticeEvent, 'before' | 'after'> = {
    kind: 'row_updated',
    rowId: 'task1',
    label: 'Revisar bomba',
    version: 'v1',
    actor: { kind: 'member', id: 'jefe1' },
    actorName: 'Jefe',
  };
  const run = (e: NoticeEvent, who: NoticePerson[] = [jefe, t1, t2], prefs = noPrefs) =>
    planNotices({ app, tracker: tareas, event: e, row: { created_by: 'jefe1', created_by_app_user: null }, people: who, prefs });

  it('detecta el campo de la persona (botón «Asignar a…») y avisa sólo a la asignada', () => {
    const out = run({ ...base, before: { titulo: 'Revisar bomba', asignado: '' }, after: { titulo: 'Revisar bomba', asignado: t1.id } });
    expect(out.map((p) => [p.person.id, p.kind])).toEqual([[t1.id, 'assigned']]);
    expect(out[0]?.title).toBe('Se te asignó: Revisar bomba');
    expect(out[0]?.screen).toBe('mis_tareas');
  });

  it('una fila creada ya asignada avisa; un cambio que no toca al asignado, no', () => {
    const asCreated = run({ ...base, kind: 'row_created', before: null, after: { titulo: 'x', asignado: t2.id } });
    expect(asCreated.map((p) => p.person.id)).toEqual([t2.id]);
    const same = run({
      ...base,
      before: { titulo: 'x', asignado: t1.id, estado: 'Pendiente' },
      after: { titulo: 'x', asignado: t1.id, estado: 'Pendiente', ...{} },
    });
    expect(same).toEqual([]);
  });

  it('reasignar avisa a la nueva persona (la anterior ya no ve la fila: no recibe nada)', () => {
    const out = run({
      ...base,
      before: { titulo: 'x', asignado: t1.id },
      after: { titulo: 'x', asignado: t2.id },
      version: 'v2',
    });
    expect(out.map((p) => p.person.id)).toEqual([t2.id]);
  });

  it('el aviso de asignar sólo existe si el rol ve la fila', () => {
    const ciego: NoticeAppModel = {
      ...app,
      roles: app.roles.map((r) => (r.key === 'tecnico' ? { ...r, permissions: { tables: {}, export: false } } : r)),
    };
    const out = planNotices({
      app: ciego,
      tracker: tareas,
      event: { ...base, before: null, after: { asignado: t1.id }, kind: 'row_created' },
      row: { created_by: 'jefe1', created_by_app_user: null },
      people: [t1],
      prefs: noPrefs,
    });
    expect(out).toEqual([]);
  });

  it('las preferencias de la persona mandan: nada / sólo lo mío', () => {
    const e: NoticeEvent = { ...base, before: null, after: { asignado: t1.id }, kind: 'row_created' };
    const none = new Map([[personKey('app_user', t1.id), { level: 'none', email: false, mutedUntil: null } as NoticePrefs]]);
    expect(run(e, [t1], none)).toEqual([]);
    const mine = new Map([[personKey('app_user', t1.id), { level: 'mine', email: false, mutedUntil: null } as NoticePrefs]]);
    expect(run(e, [t1], mine).map((p) => p.kind)).toEqual(['assigned']);
  });
});

describe('preferencias y silencio', () => {
  it('«sólo lo mío» deja pasar todo menos «nuevo»; «nada» no deja pasar nada', () => {
    expect(levelAllows('mine', 'new')).toBe(false);
    expect(levelAllows('mine', 'assigned')).toBe(true);
    expect(levelAllows('mine', 'approval')).toBe(true);
    expect(levelAllows('none', 'assigned')).toBe(false);
    expect(levelAllows('all', 'new')).toBe(true);
  });

  it('con «sólo lo mío» Gus ya no recibe el «nuevo» y Sara conserva el de aprobar', () => {
    const prefs = new Map<string, NoticePrefs>([
      [personKey('member', 'gus'), { level: 'mine', email: false, mutedUntil: null }],
      [personKey('member', 'sara'), { level: 'mine', email: false, mutedUntil: null }],
    ]);
    expect(kindsOf(plan({ prefs }))).toEqual({ sara: 'approval' });
  });

  it('parsePrefs es tolerante y isMuted compara con la hora dada', () => {
    expect(parsePrefs({ level: 'rareza', mutedUntil: 'no es fecha' })).toEqual({ level: 'all', email: false, mutedUntil: null });
    const p = parsePrefs({ level: 'mine', email: true, mutedUntil: '2026-10-20T12:00:00Z' });
    expect(isMuted(p, Date.parse('2026-10-20T11:00:00Z'))).toBe(true);
    expect(isMuted(p, Date.parse('2026-10-20T13:00:00Z'))).toBe(false);
  });

  it('parseNoticeConfig descarta lo roto en vez de tumbar', () => {
    expect(parseNoticeConfig({ roles: { Mal: { new: true } } })).toEqual({ roles: {} });
    expect(parseNoticeConfig({ roles: { ok_rol: { new: 'sí' } } })).toEqual({ roles: {} });
    expect(parseNoticeConfig(null)).toEqual({ roles: {} });
  });
});

describe('idempotencia', () => {
  it('el mismo suceso emitido dos veces da las mismas claves; otra versión da otras', () => {
    const a = plan().map((p) => p.dedupeKey);
    const b = plan().map((p) => p.dedupeKey);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    const c = plan({ event: { ...created, version: 'otra' } }).map((p) => p.dedupeKey);
    expect(c.some((k) => a.includes(k))).toBe(false);
  });
});

describe('anti-ráfaga', () => {
  it('uno por uno, luego un resumen y luego silencio; asignar y aprobar nunca se agrupan', () => {
    expect([1, 2, 3].map((n) => burstMode('new', n))).toEqual(['single', 'single', 'single']);
    expect(burstMode('new', BURST_SINGLE + 1)).toBe('summary');
    expect(burstMode('new', BURST_SINGLE + 2)).toBe('silent');
    expect(burstMode('changed', 50)).toBe('silent');
    expect(burstMode('assigned', 50)).toBe('single');
    expect(burstMode('approval', 50)).toBe('single');
  });

  const n = (id: string, minutes: number, over: Partial<InboxNotice> = {}): InboxNotice => ({
    id,
    kind: 'new',
    title: `Nuevo en Atenciones`,
    body: id,
    screen: 'atenciones',
    rowId: id,
    trackerName: 'Atenciones',
    trackerId: 't1',
    createdAt: new Date(Date.parse('2026-10-20T10:00:00Z') - minutes * 60_000).toISOString(),
    readAt: null,
    ...over,
  });

  it('la bandeja junta los «nuevos» de una tabla que llegaron seguidos en «5 nuevos en Atenciones»', () => {
    const groups = groupNotices([n('a', 0), n('b', 1), n('c', 2), n('d', 3), n('e', 4)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 5, title: '5 nuevos en Atenciones', rowId: null });
    expect(groups[0]?.ids).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('no junta lo que llegó con más de la ventana de diferencia, ni asignaciones, ni leídos con no leídos', () => {
    expect(groupNotices([n('a', 0), n('b', 30)])).toHaveLength(2);
    const asg = (id: string, m: number) => n(id, m, { kind: 'assigned', title: `Se te asignó ${id}` });
    expect(groupNotices([asg('a', 0), asg('b', 1)])).toHaveLength(2);
    expect(groupNotices([n('a', 0), n('b', 1, { readAt: '2026-10-20T09:00:00Z' })])).toHaveLength(2);
  });

  it('cuenta lo no leído por pantalla', () => {
    expect(
      unreadByScreen([
        { screen: 'a', readAt: null },
        { screen: 'a', readAt: null },
        { screen: 'b', readAt: '2026-10-20T10:00:00Z' },
        { screen: null, readAt: null },
      ]),
    ).toEqual({ a: 2, '': 1 });
  });
});

describe('entrega', () => {
  const stored = (
    p: Partial<PlannedNotice> & { person: NoticePerson },
    over: Partial<StoredNotice> = {},
  ): StoredNotice => ({
    id: 'n1',
    mode: 'single',
    muted: false,
    prefs: { level: 'all', email: false, mutedUntil: null },
    planned: {
      kind: 'new',
      title: 'Nuevo en Atenciones',
      body: 'x',
      screen: 'atenciones',
      rowId: 'r1',
      trackerId: 't1',
      trackerName: 'Atenciones',
      actorName: 'Ana',
      dedupeKey: 'k',
      ...p,
    },
    ...over,
  });
  const deps = (over: Partial<NoticeDelivery> = {}): NoticeDelivery => ({
    pushEnabled: () => true,
    pushAppUsers: vi.fn(async () => []),
    pushMembers: vi.fn(async () => []),
    bell: vi.fn(async () => 'bell1'),
    email: vi.fn(async () => ({ sent: true })),
    baseUrl: () => 'https://x.co',
    ...over,
  });
  const app = { id: 'a1', slug: 'planta', name: 'Planta' };
  const db = {} as SupabaseClient;
  const ext = person('u1', 'cliente', 'app_user');

  it('push si llega; si no, correo sólo para asignar y aprobar', async () => {
    const d = deps({ pushAppUsers: vi.fn(async () => ['u1']) });
    expect([...(await deliverStored(db, app, [stored({ person: ext })], d)).values()]).toEqual(['push']);

    const d2 = deps();
    const asg = stored({ person: ext, kind: 'assigned', title: 'Se te asignó: X' });
    expect([...(await deliverStored(db, app, [asg], d2)).values()]).toEqual(['email']);
    expect(d2.email).toHaveBeenCalledOnce();
    const nuevo = await deliverStored(db, app, [stored({ person: ext })], deps());
    expect([...nuevo.values()]).toEqual(['inbox']);
  });

  it('con «recibir correo» también manda los nuevos cuando no hay push', async () => {
    const d = deps();
    const s = stored({ person: ext }, { prefs: { level: 'all', email: true, mutedUntil: null } });
    expect([...(await deliverStored(db, app, [s], d)).values()]).toEqual(['email']);
  });

  it('silenciado o en silencio de ráfaga: sólo bandeja, nada sale', async () => {
    const d = deps();
    const out = await deliverStored(
      db,
      app,
      [
        stored({ person: ext, kind: 'assigned' }, { muted: true, id: 'a' }),
        stored({ person: ext }, { mode: 'silent', id: 'b' }),
      ],
      d,
    );
    expect([...out.values()]).toEqual(['inbox', 'inbox']);
    expect(d.pushAppUsers).not.toHaveBeenCalled();
    expect(d.email).not.toHaveBeenCalled();
  });

  it('el resumen de la ráfaga manda un solo aviso «Varios nuevos…» sin abrir una fila', async () => {
    const push = vi.fn(async () => ['u1']);
    await deliverStored(db, app, [stored({ person: ext }, { mode: 'summary' })], deps({ pushAppUsers: push }));
    const payload = (push.mock.calls[0] as unknown as [unknown, unknown, unknown, { title: string; url: string }])[3];
    expect(payload.title).toBe('Varios nuevos en Atenciones');
    expect(payload.url).toBe('/a/a1/atenciones');
  });

  it('un miembro recibe campana en asignaciones y aprobaciones, y la ruta abre su fila', async () => {
    const d = deps();
    const m = person('m1', 'supervisor');
    const out = await deliverStored(db, app, [stored({ person: m, kind: 'approval', title: 'Pendiente de tu aprobación: X' })], d);
    expect([...out.values()]).toEqual(['bell']);
    const note = (d.bell as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { href: string };
    expect(note.href).toBe('/apps/planta/atenciones?fila=r1');
    const quiet = deps();
    await deliverStored(db, app, [stored({ person: m })], quiet);
    expect(quiet.bell).not.toHaveBeenCalled();
  });

  it('sin entrega registrada no pasa nada (queda la bandeja)', async () => {
    expect((await deliverStored(db, app, [stored({ person: ext })], null)).size).toBe(0);
  });
});

describe('silenciar', () => {
  it('una hora, ocho, hasta mañana a las 7 (hora de Colombia) y quitar', async () => {
    const { muteUntil } = await import('../shape');
    const now = Date.parse('2026-10-20T20:30:00Z'); // 15:30 en Bogotá
    expect(muteUntil('1h', now)).toBe('2026-10-20T21:30:00.000Z');
    expect(muteUntil('8h', now)).toBe('2026-10-21T04:30:00.000Z');
    expect(muteUntil('tomorrow', now)).toBe('2026-10-21T12:00:00.000Z');
    // A las 23:30 de Bogotá (04:30 UTC del día siguiente) «mañana» sigue siendo el día de Bogotá + 1.
    expect(muteUntil('tomorrow', Date.parse('2026-10-21T04:30:00Z'))).toBe('2026-10-21T12:00:00.000Z');
    expect(muteUntil('off', now)).toBeNull();
  });
});
