import assert from 'node:assert/strict';
// Migración 0175 contra PostgreSQL real (PGlite): la caja mínima de cada
// empresa, una fila por empresa, sólo para service_role.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/ledger/settings.sql-test.mjs
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const mig = (n) =>
  readFileSync(new URL(`../../../../infra/supabase/migrations/${n}`, import.meta.url), 'utf8');
await db.exec('create role anon; create role authenticated; create role service_role;');
await db.exec(
  `create table public.users (id uuid primary key, organization_id text not null);
   insert into public.users values ('11111111-1111-4111-8111-111111111111', 'a');`,
);
await db.exec(mig('0175_ledger_settings.sql'));
let n = 0;
const ok = (v, m) => {
  assert.ok(v, m);
  n++;
};
const rejects = async (sql, p, m) => {
  let f = false;
  try {
    await db.query(sql, p);
  } catch {
    f = true;
  }
  ok(f, m);
};

const ADMIN = '11111111-1111-4111-8111-111111111111';
await db.query(
  `insert into ledger_settings(organization_id, minimum_cash, updated_by) values ('a', 20000000, $1)`,
  [ADMIN],
);
const { rows } = await db.query(
  `select minimum_cash, currency from ledger_settings where organization_id='a'`,
);
ok(Number(rows[0].minimum_cash) === 20000000 && rows[0].currency === 'COP', 'COP por defecto');
await rejects(
  `insert into ledger_settings(organization_id, minimum_cash) values ('a', 1)`,
  [],
  'una fila por empresa',
);
await db.query(
  `insert into ledger_settings(organization_id, minimum_cash) values ('a', 25000000)
   on conflict (organization_id) do update set minimum_cash = excluded.minimum_cash`,
);
ok(
  Number(
    (await db.query(`select minimum_cash from ledger_settings where organization_id='a'`)).rows[0]
      .minimum_cash,
  ) === 25000000,
  'el upsert por organization_id reemplaza',
);
await db.query(`insert into ledger_settings(organization_id, minimum_cash) values ('b', null)`);
ok(true, 'nula = sin decidir');
await rejects(
  `insert into ledger_settings(organization_id, minimum_cash) values ('c', -1)`,
  [],
  'no negativa',
);
await rejects(
  `insert into ledger_settings(organization_id, currency) values ('d', 'pesos')`,
  [],
  'moneda de tres letras',
);
await db.query('delete from users where id=$1', [ADMIN]);
ok(
  (await db.query(`select updated_by from ledger_settings where organization_id='a'`)).rows[0]
    .updated_by === null,
  'borrar a la persona no borra la decisión',
);

const rls = await db.query(`select relrowsecurity from pg_class where relname='ledger_settings'`);
ok(rls.rows[0].relrowsecurity, 'RLS encendido');
const g = await db.query(
  `select grantee, privilege_type from information_schema.role_table_grants where table_name='ledger_settings'`,
);
ok(
  !g.rows.some((r) => ['anon', 'authenticated'].includes(r.grantee)),
  'nada para anon/authenticated',
);
ok(
  g.rows.some((r) => r.grantee === 'service_role' && r.privilege_type === 'UPDATE'),
  'service_role escribe',
);
console.log(`0175 · ${n} comprobaciones en PGlite: ok`);
