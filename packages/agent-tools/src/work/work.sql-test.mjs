import assert from 'node:assert/strict';
// Migración 0174 contra PostgreSQL real (PGlite): el registro de trabajo, las
// personas y los ajustes, y la clase de aviso `work_assigned`.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/work/work.sql-test.mjs
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
let checks = 0;
const ok = (value, message) => {
  assert.ok(value, message);
  checks++;
};
const rejects = async (sql, params, message) => {
  let failed = false;
  try {
    await db.query(sql, params);
  } catch {
    failed = true;
  }
  ok(failed, message);
};
const migration = (name) =>
  readFileSync(new URL(`../../../../infra/supabase/migrations/${name}`, import.meta.url), 'utf8');

const LAURA = '22222222-2222-4222-8222-222222222222';
const ANDRES = '33333333-3333-4333-8333-333333333333';

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.users (id uuid primary key, organization_id text not null);
  insert into public.users values ('${LAURA}', 'a'), ('${ANDRES}', 'a');
  create table public.notifications (id uuid primary key default gen_random_uuid(), kind text not null);
  alter table public.notifications add constraint notifications_kind_check check (kind in ('table_sync'));
`);
await db.exec(migration('0174_work_registry.sql'));
// Idempotente: correrla dos veces no falla (if not exists / drop if exists).
await db.exec(migration('0174_work_registry.sql'));
ok(true, 'la migración corre dos veces');

const insert = (over = {}) => {
  const row = {
    organization_id: 'a',
    assignee_id: LAURA,
    work_type: 'despacho',
    title: 'Despacho de guías',
    status: 'open',
    opened_at: '2026-09-01T15:00:00Z',
    source_kind: 'chat',
    source_system: '',
    source_ref: 'h:1',
    ...over,
  };
  const cols = Object.keys(row);
  return db.query(
    `insert into work_items(${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
    Object.values(row),
  );
};

const {
  rows: [first],
} = await insert();
ok(first.id && first.status === 'open' && first.source_system === '', 'un ítem nace abierto');
await rejects(
  `insert into work_items(organization_id, work_type, title, opened_at, source_kind, source_ref)
   values ('a', 'despacho', 'otro', now(), 'chat', 'h:1')`,
  [],
  'la misma identidad de fuente no se duplica (source_system por defecto vacío)',
);
const {
  rows: [elsewhere],
} = await insert({ organization_id: 'b' });
ok(elsewhere.id, 'la misma identidad en otra empresa sí entra');
await db.query(
  `insert into work_items(organization_id, work_type, title, opened_at, source_kind, source_ref)
   values ('a', 'despacho', 'x', now(), 'chat', 'h:1')
   on conflict (organization_id, source_kind, source_system, source_ref) do update set title = excluded.title`,
);
const {
  rows: [{ n }],
} = await db.query(`select count(*)::int as n from work_items where organization_id = 'a'`);
ok(n === 1, 'el upsert por identidad de fuente actualiza en vez de duplicar');

await rejects(
  `insert into work_items(organization_id, work_type, title, status, opened_at, source_kind, source_ref)
   values ('a', 'despacho', 'x', 'done', now(), 'chat', 'h:2')`,
  [],
  'hecho exige fecha de cierre',
);
await rejects(
  `insert into work_items(organization_id, work_type, title, opened_at, due_on, due_at, source_kind, source_ref)
   values ('a', 'despacho', 'x', now(), '2026-09-01', now(), 'chat', 'h:3')`,
  [],
  'un vencimiento es día o instante, no los dos',
);
await rejects(
  `insert into work_items(organization_id, work_type, title, status, opened_at, source_kind, source_ref)
   values ('a', 'despacho', 'x', 'paused', now(), 'chat', 'h:4')`,
  [],
  'el estado es abierto, hecho o ya no aplica',
);
await rejects(
  `insert into work_items(organization_id, work_type, title, opened_at, source_kind, source_ref)
   values ('a', 'despacho', 'x', now(), 'email_content', 'h:5')`,
  [],
  'la fuente es una de las conocidas',
);
await rejects(
  `insert into work_items(organization_id, work_type, title, opened_at, quantity, source_kind, source_ref)
   values ('a', 'despacho', 'x', now(), -1, 'chat', 'h:6')`,
  [],
  'la cantidad no es negativa',
);
await db.query('delete from users where id = $1', [LAURA]);
const {
  rows: [orphan],
} = await db.query('select assignee_id from work_items where id = $1', [first.id]);
ok(orphan.assignee_id === null, 'si la persona se borra, el trabajo queda sin asignar');

await db.query(
  `insert into work_people_meta(organization_id, user_id, team, away_days) values ('a', $1, 'Bodega', '{2026-10-05,2026-10-06}')`,
  [ANDRES],
);
await rejects(
  `insert into work_people_meta(organization_id, user_id) values ('a', $1)`,
  [ANDRES],
  'una fila de datos de trabajo por persona y empresa',
);
await rejects(
  `insert into work_people_meta(organization_id, user_id, team) values ('b', $1, '')`,
  [ANDRES],
  'un equipo vacío no es un equipo',
);
const {
  rows: [meta],
} = await db.query('select away_days from work_people_meta where user_id = $1', [ANDRES]);
ok(Array.isArray(meta.away_days) && meta.away_days.length === 2, 'los días fuera son fechas');

const {
  rows: [settings],
} = await db.query(`insert into work_settings(organization_id) values ('a') returning *`);
ok(
  settings.team_visibility === 'self' &&
    settings.measured_types === null &&
    settings.sources.length === 4 &&
    Array.isArray(settings.tracker_mappings),
  'los ajustes nacen: cada quien ve lo suyo, se mide todo, cuatro fuentes',
);
await rejects(
  `update work_settings set team_visibility = 'everyone' where organization_id = 'a'`,
  [],
  'la visibilidad es self, team o all',
);
await rejects(
  `update work_settings set sources = array['chat_content'] where organization_id = 'a'`,
  [],
  'sólo fuentes que la sincronización conoce',
);
await rejects(
  `update work_settings set tracker_mappings = '{}'::jsonb where organization_id = 'a'`,
  [],
  'los mapeos son un arreglo',
);

await db.query(`insert into notifications(kind) values ('work_assigned')`);
ok(true, 'la campana acepta work_assigned');
await db.query(`insert into notifications(kind) values ('table_sync')`);
ok(true, 'y sigue aceptando las clases de antes');

for (const table of ['work_items', 'work_people_meta', 'work_settings']) {
  const {
    rows: [rls],
  } = await db.query('select relrowsecurity from pg_class where relname = $1', [table]);
  ok(rls.relrowsecurity, `${table} tiene RLS`);
  const { rows: grants } = await db.query(
    'select grantee, privilege_type from information_schema.role_table_grants where table_name = $1',
    [table],
  );
  ok(
    !grants.some((g) => g.grantee === 'anon' || g.grantee === 'authenticated'),
    `${table}: ni anon ni authenticated`,
  );
  ok(
    grants.some((g) => g.grantee === 'service_role' && g.privilege_type === 'SELECT'),
    `${table}: service_role lee`,
  );
}

console.log(`0174 work registry: ${checks} checks ok`);
