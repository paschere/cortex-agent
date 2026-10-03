import assert from 'node:assert/strict';
// Migración 0196 contra PostgreSQL real (PGlite): proyectos, horas, costos,
// hitos, work_items.project_id, stock_movements.project_id y la flota.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/projects/projects.sql-test.mjs
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
let checks = 0;
const ok = (value, message) => {
  assert.ok(value, message);
  checks++;
};
const rejects = async (sql, message) => {
  let failed = false;
  try {
    await db.query(sql);
  } catch {
    failed = true;
  }
  ok(failed, message);
};
const migration = (name) =>
  readFileSync(new URL(`../../../../infra/supabase/migrations/${name}`, import.meta.url), 'utf8');

const U = '11111111-1111-4111-8111-111111111111';
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.ba_organization (id text primary key);
  insert into public.ba_organization values ('a'), ('b');
  create table public.users (id uuid primary key);
  insert into public.users values ('${U}');
  create table public.clients (id uuid primary key default gen_random_uuid());
  create table public.sales_documents (id uuid primary key default gen_random_uuid());
  create table public.ledger_movements (id uuid primary key default gen_random_uuid());
  create table public.products (id uuid primary key default gen_random_uuid());
  create table public.work_items (id uuid primary key default gen_random_uuid(), organization_id text, title text, status text default 'open');
  create table public.stock_movements (id uuid primary key default gen_random_uuid(), organization_id text, qty numeric);
  create table public.vehicles (id uuid primary key default gen_random_uuid(), organization_id text, user_id uuid, plate text, archived boolean default false);
  create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end $$;
`);
await db.exec(migration('0196_projects_fleet.sql'));
await db.exec(migration('0196_projects_fleet.sql'));
ok(true, 'la migración corre dos veces');

const {
  rows: [p],
} = await db.query(
  `insert into projects(organization_id, number, code, title, budget_amount, budget_hours) values ('a', 1, 'OS-0001', 'Montaje', 1000, 10) returning *`,
);
ok(p.status === 'abierto' && p.kind === 'orden_servicio', 'valores por defecto');
await rejects(`insert into projects(organization_id, number, code, title) values ('a', 1, 'OS-0001', 'Otro')`, 'número único por empresa');
await db.query(`insert into projects(organization_id, number, code, title) values ('b', 1, 'OS-0001', 'Otra empresa')`);
ok(true, 'otra empresa repite el número');
await rejects(`insert into projects(organization_id, number, code, title, status) values ('a', 2, 'OS-0002', 'X', 'terminado')`, 'terminado exige fecha de fin');
await rejects(`insert into projects(organization_id, number, code, title, start_on, due_on) values ('a', 3, 'OS-0003', 'X', '2026-10-05', '2026-10-01')`, 'entrega antes del inicio');
const opp = '22222222-2222-4222-8222-222222222222';
await db.query(`insert into projects(organization_id, number, code, title, opportunity_id) values ('a', 4, 'PRY-0004', 'Ganada', '${opp}')`);
await rejects(`insert into projects(organization_id, number, code, title, opportunity_id) values ('a', 5, 'PRY-0005', 'Ganada otra vez', '${opp}')`, 'una oportunidad abre un solo proyecto');

await db.query(`insert into work_items(organization_id, title, project_id) values ('a', 'Tarea', '${p.id}')`);
ok(true, 'work_items acepta project_id');
await db.query(`insert into stock_movements(organization_id, qty, project_id) values ('a', -2, '${p.id}')`);
ok(true, 'stock_movements acepta project_id');

await db.query(`insert into time_entries(organization_id, project_id, user_id, worked_on, hours, cost_rate) values ('a', '${p.id}', '${U}', '2026-10-01', 6, 50000)`);
await rejects(`insert into time_entries(organization_id, project_id, user_id, worked_on, hours) values ('a', '${p.id}', '${U}', '2026-10-01', 25)`, 'no más de 24 h');
await rejects(`insert into time_entries(organization_id, project_id, worked_on, hours) values ('a', '${p.id}', '2026-10-01', 2)`, 'horas de alguien');
await db.query(`insert into project_rates(organization_id, cost_rate) values ('a', 30000)`);
await rejects(`insert into project_rates(organization_id, cost_rate) values ('a', 40000)`, 'una tarifa de empresa');
const {
  rows: [lm],
} = await db.query(`insert into ledger_movements default values returning id`);
await db.query(`insert into project_costs(organization_id, project_id, kind, description, amount, incurred_on, ledger_movement_id) values ('a', '${p.id}', 'gasto', 'Viáticos', 100, '2026-10-01', '${lm.id}')`);
await rejects(`insert into project_costs(organization_id, project_id, kind, description, amount, incurred_on, ledger_movement_id) values ('a', '${p.id}', 'gasto', 'Otra vez', 100, '2026-10-01', '${lm.id}')`, 'un gasto del libro se carga una vez');
await rejects(`insert into project_milestones(organization_id, project_id, title, amount, status) values ('a', '${p.id}', 'Anticipo', 500, 'facturado')`, 'facturado exige documento');

// Flota
const {
  rows: [v],
} = await db.query(`insert into vehicles(organization_id, user_id, plate, in_fleet, fuel_type, odometer_km) values ('a', '${U}', 'ABC123', true, 'diesel', 1000) returning *`);
ok(v.in_fleet === true, 'vehículo de flota');
await rejects(`update vehicles set fuel_type = 'carbon' where id = '${v.id}'`, 'combustible válido');
await db.query(`insert into maintenance_plans(organization_id, vehicle_id, task, every_km) values ('a', '${v.id}', 'Aceite', 5000)`);
await rejects(`insert into maintenance_plans(organization_id, vehicle_id, task, every_km) values ('a', '${v.id}', ' aceite ', 5000)`, 'tarea única por vehículo');
await rejects(`insert into maintenance_plans(organization_id, vehicle_id, task) values ('a', '${v.id}', 'Nada')`, 'un plan necesita intervalo');
await db.query(`insert into fuel_logs(organization_id, vehicle_id, filled_on, odometer_km, gallons, amount) values ('a', '${v.id}', '2026-10-01', 1200, 10, 150000)`);
await rejects(`insert into fuel_logs(organization_id, vehicle_id, filled_on, gallons, amount) values ('a', '${v.id}', '2026-10-01', 0, 1)`, 'galones positivos');
await db.query(`insert into trips(organization_id, vehicle_id, trip_on, stops, guide_refs) values ('a', '${v.id}', '2026-10-02', '[{"place":"Fusa"}]', '{1023}')`);
await rejects(`insert into trips(organization_id, trip_on, start_km, end_km) values ('a', '2026-10-02', 100, 50)`, 'llegada después de salida');
await rejects(`insert into trips(organization_id, trip_on, stops) values ('a', '2026-10-02', '{}')`, 'paradas es un arreglo');

const { rows: rls } = await db.query(
  `select count(*)::int as n from pg_class where relname in ('projects','project_rates','time_entries','project_costs','project_milestones','maintenance_plans','maintenance_events','fuel_logs','trips') and relrowsecurity`,
);
ok(rls[0].n === 9, 'RLS en las nueve tablas');
const { rows: grants } = await db.query(
  `select count(*)::int as n from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_name in ('projects','time_entries','trips')`,
);
ok(grants[0].n === 0, 'anon/authenticated sin permisos');
console.log(`0196 ok: ${checks} comprobaciones`);
