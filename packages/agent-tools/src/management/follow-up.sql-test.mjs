import assert from 'node:assert/strict';
// Migración 0158 contra PostgreSQL real (PGlite), aislada de cualquier base de clientes.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/management/follow-up.sql-test.mjs
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
const admin = '11111111-1111-4111-a111-111111111111';
const caseId = 'cccccccc-cccc-4ccc-accc-cccccccccccc';
const other = 'dddddddd-dddd-4ddd-addd-dddddddddddd';
const migration = (name) =>
  readFileSync(new URL(`../../../../infra/supabase/migrations/${name}`, import.meta.url), 'utf8');

await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create table ba_organization(id text primary key);
  create table users(id uuid primary key, organization_id text, role text);
  create table agents(id uuid default gen_random_uuid(), organization_id text, slug text, allowed_tool_ids text[], archived boolean default false);
  create table scheduled_jobs(id uuid default gen_random_uuid());
  insert into ba_organization values('acme');
  insert into users values('${admin}','acme','org_admin');`);
await db.exec(migration('0130_management.sql'));
await db.exec(`insert into management_cases(id, organization_id, data, created_by, updated_by) values
  ('${caseId}','acme','{"title":"A","state":"open","objective":"o","successCriteria":"s","dueOn":"2026-09-30","nextReviewOn":"2026-09-21"}','${admin}','${admin}'),
  ('${other}','acme','{"title":"B","state":"open","objective":"o","successCriteria":"s","dueOn":"2026-09-30","nextReviewOn":"2026-09-21"}','${admin}','${admin}')`);
// Dos veces: la migración es idempotente.
await db.exec(migration('0158_management_follow_up.sql'));
await db.exec(migration('0158_management_follow_up.sql'));
ok(true, 'la 0158 se aplica dos veces sin error');

const insert = (revision, step, extra = '') =>
  `insert into management_case_notices(organization_id, case_id, case_revision, step, sent_on, recipient_user_ids${extra ? ', reasons' : ''})
   values('acme','${caseId}',${revision},'${step}','2026-09-21',array['${admin}']::uuid[]${extra ? `, ${extra}` : ''})`;

await db.exec('set role service_role');
await db.query(insert(1, 'owner', `array['review_due']`));
ok(true, 'service_role reclama un aviso');
await rejects(insert(1, 'owner'), 'el mismo (asunto, revisión, paso) no entra dos veces');
await db.query(insert(2, 'owner'));
ok(true, 'una revisión nueva gana su propio aviso');
await db.query(insert(1, 'escalation'));
ok(true, 'el escalado es otro paso de la misma revisión');
await db.query(insert(1, 'unowned'));
await rejects(insert(5, 'unowned'), 'sin responsable sale una sola vez por asunto');
await db.query(
  `insert into management_case_notices(organization_id, case_id, case_revision, step, sent_on) values('acme','${other}',1,'unowned','2026-09-21')`,
);
ok(true, 'otro asunto sin responsable sí tiene su aviso');
await rejects(insert(3, 'nudge'), 'un paso desconocido no entra');
await rejects(insert(3, 'owner', `array['whatever']`), 'un motivo desconocido no entra');
await rejects(insert(0, 'owner'), 'la revisión empieza en 1');
await rejects(
  `insert into management_case_notices(organization_id, case_id, case_revision, step, sent_on, via) values('acme','${caseId}',7,'escalation','2026-09-21','boss')`,
  'la vía del escalado es named/manager/admin',
);
const { rows } = await db.query(
  `update management_case_notices set delivered = true, settled_at = now() where case_revision = 1 and step = 'owner' returning id`,
);
ok(rows.length === 1, 'service_role cierra el aviso con su resultado');
await db.exec('reset role');

await db.exec('set role authenticated');
await rejects('select * from management_case_notices', 'authenticated no lee el libro');
await db.exec('reset role');
await db.exec('set role anon');
await rejects(insert(9, 'owner'), 'anon no escribe en el libro');
await db.exec('reset role');

await db.query(`delete from management_cases where id = '${caseId}'`);
const left = await db.query(
  `select count(*)::int as n from management_case_notices where case_id = '${caseId}'`,
);
ok(left.rows[0].n === 0, 'borrar el asunto borra sus avisos');

console.log(`0158 management_case_notices: ${checks} comprobaciones OK`);
