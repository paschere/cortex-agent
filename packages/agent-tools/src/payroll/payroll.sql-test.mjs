import assert from 'node:assert/strict';
// Migración 0194 (nómina, ausencias y SG-SST) contra PostgreSQL real (PGlite).
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/payroll/payroll.sql-test.mjs
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const sql = readFileSync(
  new URL('../../../../infra/supabase/migrations/0194_payroll_sst.sql', import.meta.url),
  'utf8',
);
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.ba_organization (id text primary key);
  create table public.users (id uuid primary key);
  create table public.kb_documents (id uuid primary key);
  create table public.commitments (id uuid primary key);
  insert into public.ba_organization values ('a'), ('b');
  insert into public.users values ('00000000-0000-4000-8000-000000000001');
`);
await db.exec(sql);
// Dos veces: re-ejecutable.
await db.exec(sql);
let n = 0;
const ok = (v, m) => {
  assert.ok(v, m);
  n++;
};
const rejects = async (q, p, m) => {
  let failed = false;
  try {
    await db.query(q, p);
  } catch {
    failed = true;
  }
  ok(failed, m);
};
const U = '00000000-0000-4000-8000-000000000001';

// Empleados ------------------------------------------------------------------
const emp = `insert into employees(organization_id, full_name, document_number, contract_type, start_date, salary, salary_integral, apprentice_phase, bank_account_last4, user_id)
  values ($1,$2,$3,$4,'2026-01-01',$5,$6,$7,$8,$9) returning id`;
const e1 = (
  await db.query(emp, [
    'a',
    'Ana Ruiz',
    '1020304050',
    'indefinido',
    1750905,
    false,
    null,
    '1234',
    U,
  ])
).rows[0].id;
await rejects(
  emp,
  ['a', 'Otra', '1020304050', 'indefinido', 1, false, null, null, null],
  'un documento, una persona por empresa',
);
await db.query(emp, [
  'b',
  'Ana Ruiz',
  '1020304050',
  'indefinido',
  1750905,
  false,
  null,
  null,
  null,
]);
ok(true, 'otra empresa puede tener a la misma persona');
await rejects(
  emp,
  ['a', 'Dup user', '999', 'indefinido', 1, false, null, null, U],
  'una cuenta de Cortex, una persona por empresa',
);
await rejects(
  emp,
  ['a', 'Cuenta', '998', 'indefinido', 1, false, null, '0123456789', null],
  'sólo los últimos 4 dígitos de la cuenta',
);
await rejects(
  emp,
  ['a', 'Integral PS', '997', 'prestacion_servicios', 30000000, true, null, null, null],
  'integral sólo en contrato laboral',
);
await rejects(
  emp,
  ['a', 'Fase', '996', 'indefinido', 1, false, 'lectiva', null, null],
  'la fase de aprendiz sólo en aprendizaje',
);
await rejects(
  emp,
  ['a', 'Neg', '995', 'indefinido', -1, false, null, null, null],
  'salario no negativo',
);
await db.query(emp, ['a', 'Aprendiz', '994', 'aprendizaje', 1313179, false, 'lectiva', null, null]);
ok(true, 'aprendiz con su fase');

// Periodos -----------------------------------------------------------------
const per = `insert into payroll_periods(organization_id, frequency, period_start, period_end, pay_date, status, approved_at, paid_at)
  values ($1,'mensual',$2,$3,$3,$4,$5,$6) returning id`;
const p1 = (await db.query(per, ['a', '2026-09-01', '2026-09-30', 'borrador', null, null])).rows[0]
  .id;
await rejects(
  per,
  ['a', '2026-09-01', '2026-09-30', 'borrador', null, null],
  'un periodo vivo por rango',
);
await rejects(
  per,
  ['a', '2026-10-01', '2026-10-31', 'aprobado', null, null],
  'aprobado lleva fecha de aprobación',
);
await rejects(
  per,
  ['a', '2026-11-01', '2026-11-30', 'pagado', new Date().toISOString(), null],
  'pagado lleva fecha de pago',
);
await rejects(
  per,
  ['a', '2026-12-31', '2026-12-01', 'borrador', null, null],
  'fin después del inicio',
);
await db.query("update payroll_periods set status = 'anulado' where id = $1", [p1]);
await db.query(per, ['a', '2026-09-01', '2026-09-30', 'borrador', null, null]);
ok(true, 'un periodo anulado deja abrir otro con el mismo rango');

// Novedades, líneas, desprendibles -------------------------------------------------
const nov =
  'insert into payroll_novelties(organization_id, employee_id, kind, date_from, date_to, hours, amount) values ($1,$2,$3,$4,$5,$6,$7)';
await db.query(nov, ['a', e1, 'hora_extra_nocturna', '2026-09-10', null, 3, null]);
await rejects(
  nov,
  ['a', e1, 'hora_extra_nocturna', '2026-09-10', null, 0, null],
  'horas positivas',
);
await rejects(nov, ['a', e1, 'propina', '2026-09-10', null, 1, null], 'tipo de novedad conocido');
await rejects(
  nov,
  ['a', e1, 'vacaciones', '2026-09-10', '2026-09-01', null, null],
  'rango en orden',
);
const p2 = (await db.query("select id from payroll_periods where status = 'borrador'")).rows[0].id;
const item = `insert into payroll_items(organization_id, period_id, employee_id, line_no, code, item_group, label, amount, explanation) values ('a',$1,$2,$3,'salario',$4,'Salario',1750905,'30 días')`;
await db.query(item, [p2, e1, 1, 'devengado']);
await rejects(item, [p2, e1, 1, 'devengado'], 'una línea por número');
await rejects(item, [p2, e1, 2, 'bono'], 'grupo conocido');
await db.query(
  `insert into payroll_payslips(organization_id, period_id, employee_id, neto, params_version) values ('a',$1,$2,1859928,'co-2026.c')`,
  [p2, e1],
);
await rejects(
  `insert into payroll_payslips(organization_id, period_id, employee_id, neto, params_version) values ('a',$1,$2,1,'x')`,
  [p2, e1],
  'un desprendible por persona y periodo',
);

// Ausencias -------------------------------------------------------------------
const lv = `insert into leave_requests(organization_id, employee_id, kind, start_date, end_date, status, decided_at) values ('a',$1,$2,$3,$4,$5,$6) returning id`;
const l1 = (await db.query(lv, [e1, 'vacaciones', '2026-10-13', '2026-11-03', 'pendiente', null]))
  .rows[0].id;
await rejects(
  lv,
  [e1, 'vacaciones', '2026-10-13', '2026-11-03', 'aprobada', null],
  'aprobada lleva fecha de decisión',
);
await rejects(
  lv,
  [e1, 'vacaciones', '2026-11-03', '2026-10-13', 'pendiente', null],
  'fechas en orden',
);
await db.query(
  `insert into payroll_novelties(organization_id, employee_id, kind, date_from, date_to, source, leave_request_id) values ('a',$1,'vacaciones','2026-10-13','2026-11-03','licencia',$2)`,
  [e1, l1],
);
await rejects(
  `insert into payroll_novelties(organization_id, employee_id, kind, date_from, date_to, source, leave_request_id) values ('a',$1,'vacaciones','2026-10-13','2026-11-03','licencia',$2)`,
  [e1, l1],
  'una novedad viva por solicitud',
);

// SG-SST -----------------------------------------------------------------------
await db.query(
  `insert into sst_settings(organization_id, workers, max_risk_class) values ('a', 12, 2)`,
);
await rejects(
  `insert into sst_settings(organization_id, workers, max_risk_class) values ('b', 5, 6)`,
  [],
  'riesgo de I a V',
);
const plan = `insert into sst_plan(organization_id, year, standard_code, title, cycle, weight) values ('a', 2026, $1, 'Responsable', 'planear', 0.5)`;
await db.query(plan, ['1.1.1']);
await rejects(plan, ['1.1.1'], 'un estándar por año');
await rejects(plan, ['uno'], 'código con forma de estándar');
await rejects(
  `insert into sst_activities(organization_id, kind, title, status) values ('a','simulacro','Simulacro','programada')`,
  [],
  'una actividad lleva fecha',
);
await rejects(
  `insert into sst_activities(organization_id, kind, title, planned_date, status) values ('a','simulacro','Simulacro','2026-10-20','realizada')`,
  [],
  'realizada lleva fecha en que se hizo',
);
await db.query(
  `insert into sst_incidents(organization_id, kind, occurred_on, description, investigation_due, furat_due) values ('a','accidente','2026-10-09','Caída en bodega','2026-10-24','2026-10-14')`,
);
ok(true, 'accidente con sus plazos');

// Acceso ---------------------------------------------------------------------
for (const t of [
  'employees',
  'payroll_items',
  'payroll_payslips',
  'leave_requests',
  'sst_incidents',
]) {
  const rls = (await db.query('select relrowsecurity from pg_class where relname = $1', [t]))
    .rows[0];
  ok(rls?.relrowsecurity === true, `${t}: RLS encendido`);
  const anon = (
    await db.query("select has_table_privilege('anon', $1, 'select') as can", [`public.${t}`])
  ).rows[0];
  ok(anon?.can === false, `${t}: anon no lee`);
  const svc = (
    await db.query("select has_table_privilege('service_role', $1, 'insert') as can", [
      `public.${t}`,
    ])
  ).rows[0];
  ok(svc?.can === true, `${t}: service_role escribe`);
}

console.log(`0194: ${n} comprobaciones OK`);
