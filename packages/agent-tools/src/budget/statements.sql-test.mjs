import assert from 'node:assert/strict';
// Migración 0191 (estados, presupuesto, informe para socios) contra PostgreSQL
// real (PGlite): unicidad de versiones y del aprobado, celdas, la puerta del
// informe y el candado de la contraseña.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/budget/statements.sql-test.mjs
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const mig = readFileSync(
  new URL('../../../../infra/supabase/migrations/0191_statements_budget.sql', import.meta.url),
  'utf8',
);
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.ba_organization (id text primary key);
  create table public.users (id uuid primary key);
  create table public.scheduled_jobs (id uuid primary key default gen_random_uuid());
  insert into public.ba_organization values ('a'), ('b');
  insert into public.users values ('00000000-0000-4000-8000-000000000001');
`);
await db.exec(mig);
// Dos veces: la migración es re-ejecutable.
await db.exec(mig);
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

// Clasificación ---------------------------------------------------------------
await db.query(`insert into statement_settings(organization_id, category_classes) values ('a', '{"mercadeo":"variable"}')`);
await rejects(
  `insert into statement_settings(organization_id, category_classes) values ('b', '[]')`,
  [],
  'la clasificación es un objeto',
);

// Copias del programa contable -------------------------------------------------
const snap = `insert into accounting_report_snapshots(organization_id, provider, kind, period_key, payload) values ($1,$2,$3,$4,$5)`;
await db.query(snap, ['a', 'siigo', 'balance', '2026-09-30', { report: {} }]);
await rejects(snap, ['a', 'siigo', 'balance', '2026-09-30', { report: {} }], 'una copia por programa, clase y período');
await rejects(snap, ['a', 'helisa', 'balance', '2026-09-30', { report: {} }], 'sólo programas conocidos');

// Presupuesto ------------------------------------------------------------------
const bud = `insert into budgets(organization_id, year, version, name, status, approved_at) values ($1,$2,$3,$4,$5,$6) returning id`;
const b1 = (await db.query(bud, ['a', 2026, 1, 'P 2026', 'aprobado', new Date().toISOString()])).rows[0].id;
await rejects(bud, ['a', 2026, 1, 'Otra', 'borrador', null], 'una versión por año');
await rejects(bud, ['a', 2026, 2, 'Otra', 'aprobado', new Date().toISOString()], 'un solo aprobado por año');
await rejects(bud, ['a', 2026, 3, 'Sin fecha', 'aprobado', null], 'aprobado lleva fecha');
const b2 = (await db.query(bud, ['a', 2026, 2, 'P 2026 v2', 'borrador', null])).rows[0].id;
ok(b2, 'un borrador junto al aprobado');
await db.query(bud, ['b', 2026, 1, 'P de b', 'aprobado', new Date().toISOString()]);
ok(true, 'otra empresa tiene su propio aprobado');

const cell = `insert into budget_lines(organization_id, budget_id, category, kind, month, amount) values ('a',$1,$2,$3,$4,$5)`;
await db.query(cell, [b1, 'arriendo', 'gasto', 1, 2500000]);
await rejects(cell, [b1, 'arriendo', 'gasto', 1, 1], 'una celda por categoría y mes');
await rejects(cell, [b1, 'arriendo', 'gasto', 13, 1], 'el mes va de 1 a 12');
await rejects(cell, [b1, 'arriendo', 'gasto', 2, -5], 'montos positivos');
await rejects(cell, [b1, 'Arriendo Bodega', 'gasto', 2, 5], 'categoría en minúsculas con guion bajo');
await db.query('delete from budgets where id = $1', [b1]);
ok((await db.query('select count(*)::int as c from budget_lines')).rows[0].c === 0, 'las celdas se van con su presupuesto');

// Informe para socios ------------------------------------------------------------
const rep = `insert into board_reports(organization_id, period, title, content, markdown, visibility, share_token, password_hash) values ($1,$2,'Informe',$3,'# x',$4,$5,$6) returning id`;
const token = 'A'.repeat(32);
const r1 = (await db.query(rep, ['a', '2026-09', { version: 1 }, 'contrasena', token, 'scrypt$x$y'])).rows[0].id;
await rejects(rep, ['a', '2026-09', {}, 'privado', null, null], 'un informe por mes');
await rejects(rep, ['a', '2026-13', {}, 'privado', null, null], 'el mes es AAAA-MM');
await rejects(rep, ['a', '2026-08', {}, 'enlace', null, null], 'un enlace lleva token');
await rejects(rep, ['a', '2026-07', {}, 'privado', 'B'.repeat(32), null], 'privado no tiene token');
await rejects(rep, ['a', '2026-06', {}, 'contrasena', 'C'.repeat(32), null], 'con contraseña lleva hash');
await rejects(
  `update board_reports set status = 'enviado' where id = $1`,
  [r1],
  'enviado lleva fecha de envío',
);

// El candado: diez intentos y se cierra.
const reserve = 'select board_report_reserve_unlock($1, $2) as r';
let last = null;
for (let i = 0; i < 10; i++) last = (await db.query(reserve, ['a', r1])).rows[0].r;
ok(last && last.locked === false && last.hash === 'scrypt$x$y', 'el décimo intento todavía compara');
const locked = (await db.query(reserve, ['a', r1])).rows[0].r;
ok(locked?.locked === true, 'el undécimo encuentra el candado');
ok((await db.query(reserve, ['b', r1])).rows[0].r === null, 'otra empresa no reserva el informe ajeno');
await db.query('select board_report_clear_unlocks($1, $2)', ['a', r1]);
const reopened = (await db.query('select failed_unlocks, locked_until from board_reports where id = $1', [r1])).rows[0];
ok(reopened.failed_unlocks === 0 && reopened.locked_until === null, 'limpiar quita el candado');

// Configuración ------------------------------------------------------------------
await rejects(
  `insert into board_report_settings(organization_id, day_of_month) values ('a', 31)`,
  [],
  'el día va de 1 a 28',
);
await db.query(`insert into board_report_settings(organization_id, recipients) values ('a', '["socio@demo.co"]')`);
ok(true, 'correos como arreglo');

console.log(`0191 ok: ${n} comprobaciones`);
