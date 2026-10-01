import assert from 'node:assert/strict';
// Migración 0164 contra PostgreSQL real (PGlite): la carpeta, el libro de
// archivos y la clave externa de las filas que sostiene la idempotencia.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/drive-table/drive-table.sql-test.mjs
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

await db.exec('create role anon; create role authenticated; create role service_role;');
await db.exec(migration('0115_trackers.sql'));
// De la 0161 sólo hace falta la clave externa de las filas (el resto depende
// de feed_sources y notifications, que no son de esta prueba).
const m161 = migration('0161_tracker_syncs.sql');
await db.exec(
  m161.slice(
    m161.indexOf('alter table public.tracker_rows'),
    m161.indexOf('create table public.tracker_syncs'),
  ),
);
await db.exec(migration('0164_drive_folder_syncs.sql'));

const user = '11111111-1111-4111-a111-111111111111';
const {
  rows: [tracker],
} = await db.query(
  `insert into trackers(organization_id, slug, name, fields) values ('a', 'guias', 'Guías', '[]') returning id`,
);
const extract = JSON.stringify([{ key: 'guia', hint: 'Número de guía' }]);
const insertSync = (org, folder) =>
  db.query(
    `insert into drive_folder_syncs(organization_id, created_by, folder_id, tracker_id, extract_fields, key_fields)
     values ($1, $2, $3, $4, $5, '{guia}') returning id, interval_minutes, enabled, defaults`,
    [org, user, folder, tracker.id, extract],
  );

const {
  rows: [sync],
} = await insertSync('a', 'folder-0001');
ok(
  sync.id && sync.interval_minutes === 10 && sync.enabled,
  'una carpeta entra con 10 minutos y activa',
);
ok(JSON.stringify(sync.defaults) === '{}', 'sin valores por defecto, un objeto vacío');

await rejects(
  `insert into drive_folder_syncs(organization_id, created_by, folder_id, tracker_id, extract_fields, key_fields)
   values ('a', $1, 'folder-0001', $2, $3, '{guia}')`,
  [user, tracker.id, extract],
  'la misma carpeta y la misma tabla dos veces: rechazado',
);
await rejects(
  `insert into drive_folder_syncs(organization_id, created_by, folder_id, tracker_id, extract_fields, key_fields, interval_minutes)
   values ('a', $1, 'folder-0002', $2, $3, '{guia}', 5)`,
  [user, tracker.id, extract],
  'menos de 10 minutos: rechazado',
);
await rejects(
  `insert into drive_folder_syncs(organization_id, created_by, folder_id, tracker_id, extract_fields, key_fields)
   values ('a', $1, 'folder-0003', $2, '[]', '{guia}')`,
  [user, tracker.id],
  'sin campos que leer: rechazado',
);
await rejects(
  `insert into drive_folder_syncs(organization_id, created_by, folder_id, tracker_id, extract_fields, key_fields)
   values ('a', $1, 'folder-0004', $2, $3, '{}')`,
  [user, tracker.id, extract],
  'sin campos clave: rechazado',
);
await rejects(
  `insert into drive_folder_syncs(organization_id, created_by, folder_id, tracker_id, extract_fields, key_fields, defaults)
   values ('a', $1, 'folder-0005', $2, $3, '{guia}', '[]')`,
  [user, tracker.id, extract],
  'valores por defecto que no son un objeto: rechazado',
);
const {
  rows: [otherOrg],
} = await insertSync('b', 'folder-0001');
ok(otherOrg.id, 'la misma carpeta en otro espacio sí entra');

// La toma: sólo corre si ya tocaba, y sólo una de dos a la vez.
const claim = () =>
  db.query(
    `update drive_folder_syncs set next_run_at = now() + interval '10 minutes'
     where id = $1 and next_run_at <= now() returning id`,
    [sync.id],
  );
ok((await claim()).rows.length === 1, 'la primera toma se queda con la corrida');
ok((await claim()).rows.length === 0, 'la segunda no: ya la tomó otra');

// El libro de archivos: una fila por archivo y sincronización.
const ledger = (status, revision = 'r1', attempts = 1) =>
  db.query(
    `insert into drive_folder_sync_files(organization_id, sync_id, file_id, file_name, revision, status, attempts)
     values ('a', $1, 'file-1', 'guia.pdf', $2, $3, $4)
     on conflict (sync_id, file_id) do update set revision = excluded.revision, status = excluded.status, attempts = excluded.attempts
     returning id, revision, status, attempts, extracted, tracker_row_ids`,
    [sync.id, revision, status, attempts],
  );
const first = (await ledger('ok')).rows[0];
ok(
  first.status === 'ok' && JSON.stringify(first.extracted) === '[]',
  'un archivo leído entra al libro',
);
const second = (await ledger('needs_review', 'r2')).rows[0];
ok(
  second.id === first.id && second.revision === 'r2',
  'una revisión nueva reemplaza la anterior, no duplica',
);
await rejects(
  `insert into drive_folder_sync_files(organization_id, sync_id, file_id, status) values ('a', $1, 'file-2', 'skipped')`,
  [sync.id],
  'un estado que no existe: rechazado',
);
await rejects(
  `insert into drive_folder_sync_files(organization_id, sync_id, file_id, status, extracted) values ('a', $1, 'file-3', 'ok', '{}')`,
  [sync.id],
  'lo extraído tiene que ser una lista: rechazado',
);

// La clave externa de 0161: la misma guía no entra dos veces a la misma tabla.
const row = (key) =>
  db.query(
    `insert into tracker_rows(organization_id, tracker_id, label, values, external_key) values ('a', $1, 'G', '{}', $2)`,
    [tracker.id, key],
  );
await row('04512345678');
await rejects(
  `insert into tracker_rows(organization_id, tracker_id, label, values, external_key) values ('a', $1, 'G', '{}', '04512345678')`,
  [tracker.id],
  'la misma clave en la misma tabla: rechazado (23505, que el motor convierte en actualizar)',
);

// Borrar la tabla se lleva la carpeta y su libro.
await db.query('delete from trackers where id = $1', [tracker.id]);
ok(
  (await db.query('select count(*)::int as n from drive_folder_sync_files')).rows[0].n === 0,
  'sin tabla no queda carpeta ni libro',
);

// Nadie fuera de service_role toca estas tablas.
const grants = await db.query(
  `select grantee from information_schema.role_table_grants
   where table_name in ('drive_folder_syncs', 'drive_folder_sync_files') and grantee in ('anon', 'authenticated')`,
);
ok(grants.rows.length === 0, 'anon y authenticated no tienen permisos');
const rls = await db.query(
  `select bool_and(relrowsecurity) as on from pg_class where relname in ('drive_folder_syncs', 'drive_folder_sync_files')`,
);
ok(rls.rows[0].on === true, 'RLS encendido en las dos');

console.log(`drive-table sql: ${checks} comprobaciones`);
