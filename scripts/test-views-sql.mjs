// Migración 0156 contra PGlite: los CHECK de las puertas y el candado de la
// contraseña. `node scripts/test-views-sql.mjs`
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const root = new URL('..', import.meta.url).pathname;
const db = new PGlite();
let checks = 0;
const ok = (v, msg) => {
  assert.ok(v, msg);
  checks++;
};
const rejects = async (sql, params, msg) => {
  let failed = false;
  try {
    await db.query(sql, params);
  } catch {
    failed = true;
  }
  ok(failed, msg);
};

await db.exec(`create role anon;create role authenticated;create role service_role;`);
await db.exec(await readFile(`${root}/infra/supabase/migrations/0115_trackers.sql`, 'utf8'));
await db.exec(await readFile(`${root}/infra/supabase/migrations/0156_custom_views.sql`, 'utf8'));

const spec = JSON.stringify({ version: 1, blocks: [{ id: 't', type: 'text', markdown: 'hola' }] });
const hash = `scrypt$${'a'.repeat(22)}$${'b'.repeat(86)}`;
const token = 'x'.repeat(32);

const {
  rows: [view],
} = await db.query(
  `insert into custom_views(organization_id,slug,name,spec) values('a','tablero','Tablero',$1) returning id`,
  [spec],
);
ok(view.id, 'una vista interna sin token entra');

await rejects(
  `insert into custom_views(organization_id,slug,name,spec) values('a','vacia','Vacía','{"version":1,"blocks":[]}')`,
  [],
  'una vista sin bloques no entra',
);
await rejects(
  `insert into custom_views(organization_id,slug,name,spec) values('a','sin_blocks','X','{}')`,
  [],
  'un spec sin la clave blocks no entra (el CHECK no puede dar NULL)',
);
await rejects(
  `update custom_views set visibility='link' where id=$1`,
  [view.id],
  'enlace sin token: rechazado',
);
await rejects(
  `update custom_views set share_token=$2 where id=$1`,
  [view.id, token],
  'token en una vista interna: rechazado',
);
await rejects(
  `update custom_views set visibility='password', share_token=$2 where id=$1`,
  [view.id, token],
  'contraseña sin hash: rechazado',
);
await rejects(
  `update custom_views set visibility='link', share_token=$2, password_hash=$3 where id=$1`,
  [view.id, token, hash],
  'hash en una vista de enlace simple: rechazado',
);
await rejects(
  `insert into custom_views(organization_id,slug,name,spec) values('a','tablero','Otro',$1)`,
  [spec],
  'slug repetido en el mismo espacio: rechazado',
);
await db.query(
  `insert into custom_views(organization_id,slug,name,spec) values('b','tablero','Tablero de b',$1)`,
  [spec],
);
ok(true, 'el mismo slug en otro espacio sí entra');

await db.query(
  `update custom_views set visibility='password', share_token=$2, password_hash=$3 where id=$1`,
  [view.id, token, hash],
);

const reserve = async (org = 'a') =>
  (await db.query('select custom_view_reserve_unlock($1,$2) as r', [org, view.id])).rows[0].r;

ok((await reserve('b')) === null, 'otro espacio no puede gastar intentos de esta vista');
const first = await reserve();
ok(first.locked === false && first.hash === hash, 'el primer intento devuelve el hash');
for (let i = 0; i < 8; i++) await reserve();
const tenth = await reserve();
ok(tenth.locked === false, 'el décimo intento todavía compara');
const locked = await reserve();
ok(
  locked.locked === true && !locked.hash,
  'después del décimo, la vista queda cerrada y no entrega el hash',
);
await db.query('select custom_view_clear_unlocks($1,$2)', ['a', view.id]);
ok((await reserve()).locked === false, 'limpiar tras una contraseña buena reabre');

console.log(`views sql: ${checks} comprobaciones`);
