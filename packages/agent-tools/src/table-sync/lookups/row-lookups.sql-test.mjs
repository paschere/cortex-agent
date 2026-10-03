import assert from 'node:assert/strict';
// Migración 0198 contra PostgreSQL real (PGlite): las consultas por fila y su
// estado por fila.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/table-sync/lookups/row-lookups.sql-test.mjs
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
  readFileSync(
    new URL(`../../../../../infra/supabase/migrations/${name}`, import.meta.url),
    'utf8',
  );

await db.exec('create role anon; create role authenticated; create role service_role;');
// Sólo lo que la 0198 referencia: tablas, filas de tablas y herramientas propias.
await db.exec(`
  create table public.trackers (id uuid primary key default gen_random_uuid(), organization_id text not null);
  create table public.tracker_rows (id uuid primary key default gen_random_uuid(), organization_id text not null, tracker_id uuid not null references public.trackers(id) on delete cascade);
  create table public.custom_tools (id uuid primary key default gen_random_uuid(), organization_id text not null);
`);
await db.exec(migration('0198_row_lookups.sql'));
// Idempotente: aplicarla otra vez no rompe nada.
await db.exec(migration('0198_row_lookups.sql'));

const user = '11111111-1111-4111-a111-111111111111';
const {
  rows: [t],
} = await db.query(`insert into trackers(organization_id) values ('a') returning id`);
const {
  rows: [r1],
} = await db.query(
  `insert into tracker_rows(organization_id, tracker_id) values ('a', $1) returning id`,
  [t.id],
);
const {
  rows: [tool],
} = await db.query(`insert into custom_tools(organization_id) values ('a') returning id`);

const mapping = JSON.stringify([{ path: 'status', field: 'estado' }]);
const insertLookup = (name, extra = '', params = []) =>
  db.query(
    `insert into row_lookups(organization_id, tracker_id, name, url_template, mapping, created_by${extra ? `, ${extra.split('=')[0]}` : ''})
     values ('a', $1, $2, 'https://api.ejemplo.com/v/{vuelo}', $3, $4${extra ? ', $5' : ''})
     returning id, base_interval_minutes, daily_cap, per_run_cap, enabled, calls_today, filter`,
    [t.id, name, mapping, user, ...params],
  );

const {
  rows: [l],
} = await insertLookup('Estado del vuelo');
ok(l.id && l.enabled, 'una consulta nace activa');
ok(
  l.base_interval_minutes === 30 && l.daily_cap === 1000 && l.per_run_cap === 100,
  'topes por defecto: 30 min, 1.000 al día, 100 por corrida',
);
ok(l.calls_today === 0, 'sin consultas gastadas');
ok(l.filter.match === 'all' && l.filter.filters.length === 0, 'sin filtro: todas las filas');

await rejects(
  `insert into row_lookups(organization_id, tracker_id, name, url_template, mapping, created_by) values ('a', $1, 'Estado del vuelo', 'https://api.ejemplo.com/x', '[]', $2)`,
  [t.id, user],
  'el nombre no se repite en una tabla',
);
await rejects(
  `insert into row_lookups(organization_id, tracker_id, name, url_template, mapping, created_by, base_interval_minutes) values ('a', $1, 'x1', 'https://api.ejemplo.com/x', '[]', $2, 4)`,
  [t.id, user],
  'el intervalo mínimo es 5 minutos',
);
await rejects(
  `insert into row_lookups(organization_id, tracker_id, name, url_template, mapping, created_by, daily_cap) values ('a', $1, 'x2', 'https://api.ejemplo.com/x', '[]', $2, 0)`,
  [t.id, user],
  'el tope diario es obligatorio y mayor que cero',
);
await rejects(
  `insert into row_lookups(organization_id, tracker_id, name, url_template, mapping, created_by, per_run_cap) values ('a', $1, 'x3', 'https://api.ejemplo.com/x', '[]', $2, 5000)`,
  [t.id, user],
  'el tope por corrida tiene techo',
);
await rejects(
  `insert into row_lookups(organization_id, tracker_id, name, url_template, mapping, created_by) values ('a', $1, 'x4', 'https://api.ejemplo.com/x', '{}', $2)`,
  [t.id, user],
  'el mapeo es una lista',
);
await rejects(
  `insert into row_lookups(organization_id, tracker_id, name, url_template, mapping, created_by, last_status) values ('a', $1, 'x5', 'https://api.ejemplo.com/x', '[]', $2, 'raro')`,
  [t.id, user],
  'el estado es ok, error o capped',
);
await db.query(
  `insert into row_lookups(organization_id, tracker_id, name, url_template, mapping, created_by, credential_tool_id, credential_name, last_status) values ('a', $1, 'con llave', 'https://api.ejemplo.com/x', '[]', $2, $3, 'AeroDataBox', 'capped')`,
  [t.id, user, tool.id],
);
ok(true, 'con credencial y estado capped se guarda');

// Estado por fila.
await db.query(
  `insert into row_lookup_state(organization_id, lookup_id, row_id) values ('a', $1, $2)`,
  [l.id, r1.id],
);
await rejects(
  `insert into row_lookup_state(organization_id, lookup_id, row_id) values ('a', $1, $2)`,
  [l.id, r1.id],
  'una fila tiene un solo estado por consulta',
);
await rejects(
  `insert into row_lookup_state(organization_id, lookup_id, row_id, last_status) values ('a', $1, gen_random_uuid(), 'ok')`,
  [l.id],
  'la fila tiene que existir',
);
await db.query(
  `insert into row_lookup_state(organization_id, lookup_id, row_id, last_status, fail_count) values ('a', $1, $2, 'ok', 0) on conflict (lookup_id, row_id) do update set last_status = excluded.last_status`,
  [l.id, r1.id],
);
ok(true, 'el estado se puede actualizar por (consulta, fila)');

// Borrar la herramienta no borra la consulta; borrar la fila o la consulta limpia el estado.
await db.query('delete from custom_tools where id = $1', [tool.id]);
const {
  rows: [withTool],
} = await db.query(
  `select credential_tool_id, credential_name from row_lookups where name = 'con llave'`,
);
ok(
  withTool.credential_tool_id === null && withTool.credential_name === 'AeroDataBox',
  'si la credencial se borra, la consulta sigue y recuerda su nombre',
);
await db.query('delete from tracker_rows where id = $1', [r1.id]);
const { rows: s1 } = await db.query('select 1 from row_lookup_state');
ok(s1.length === 0, 'al borrar la fila se va su estado');
await db.query('delete from trackers where id = $1', [t.id]);
const { rows: left } = await db.query('select 1 from row_lookups');
ok(left.length === 0, 'al borrar la tabla se van sus consultas');

// Acceso: sólo service_role.
const { rows: grants } = await db.query(
  `select grantee, privilege_type from information_schema.role_table_grants where table_name = 'row_lookups'`,
);
ok(
  grants.some((g) => g.grantee === 'service_role' && g.privilege_type === 'INSERT'),
  'service_role puede escribir',
);
ok(
  !grants.some((g) => g.grantee === 'anon' || g.grantee === 'authenticated'),
  'anon y authenticated no tienen acceso',
);
const { rows: rls } = await db.query(
  `select relname, relrowsecurity from pg_class where relname in ('row_lookups','row_lookup_state')`,
);
ok(rls.length === 2 && rls.every((r) => r.relrowsecurity), 'RLS encendido en las dos');

console.log(`OK · ${checks} comprobaciones`);
