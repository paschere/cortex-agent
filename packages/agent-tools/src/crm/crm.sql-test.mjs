import assert from 'node:assert/strict';
// Migración 0193 contra PostgreSQL real (PGlite): embudo, oportunidades,
// actividades, encuestas y riesgo; y las reglas que la base defiende sola.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/crm/crm.sql-test.mjs
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
const migration = readFileSync(
  new URL('../../../../infra/supabase/migrations/0193_crm.sql', import.meta.url),
  'utf8',
);

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.ba_organization (id text primary key);
  create table public.users (id uuid primary key);
  create table public.clients (id uuid primary key default gen_random_uuid());
  create table public.sales_documents (id uuid primary key default gen_random_uuid());
  create function public.touch_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end $$;
  insert into public.ba_organization values ('a'), ('b');
  insert into public.clients (id) values ('00000000-0000-4000-8000-000000000001');
  insert into public.sales_documents (id) values ('00000000-0000-4000-8000-0000000000aa');
`);
await db.exec(migration);
await db.exec(migration);
ok(true, 'la migración corre dos veces');

const C = '00000000-0000-4000-8000-000000000001';
const Q = '00000000-0000-4000-8000-0000000000aa';

const stages = JSON.stringify([
  { key: 'nuevo', label: 'Nuevo', probability: 10 },
  { key: 'ganada', label: 'Ganada', probability: 100, role: 'won' },
]);
await db.query('insert into public.crm_pipelines (organization_id, stages) values ($1, $2)', [
  'a',
  stages,
]);
await rejects(
  'insert into public.crm_pipelines (organization_id, stages) values ($1, $2)',
  ['a', stages],
  'dos embudos por defecto en la misma empresa no',
);
await rejects(
  'insert into public.crm_pipelines (organization_id, stages) values ($1, $2)',
  ['b', '{"key":"x"}'],
  'las etapas son un arreglo',
);

const opp = async (org, extra = {}) => {
  const cols = [
    'organization_id',
    'client_id',
    'client_name',
    'title',
    'stage',
    ...Object.keys(extra),
  ];
  const vals = [org, C, 'Nexa', 'Fletes', 'nuevo', ...Object.values(extra)];
  const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `insert into public.crm_opportunities (${cols.join(', ')}) values (${ph}) returning id`;
  return (await db.query(sql, vals)).rows[0].id;
};
const o1 = await opp('a', { value: 40000000, quote_id: Q });
ok(!!o1, 'una oportunidad se crea con lo mínimo');
await rejects(
  'insert into public.crm_opportunities (organization_id, client_name, title, stage, quote_id) values ($1, $2, $3, $4, $5)',
  ['a', 'Nexa', 'Otra', 'nuevo', Q],
  'una cotización no materializa dos negocios',
);
ok(!!(await opp('b', { quote_id: Q })), 'otra empresa sí puede (el índice es por empresa)');
await rejects(
  'insert into public.crm_opportunities (organization_id, client_name, title, stage, probability) values ($1, $2, $3, $4, $5)',
  ['a', 'Nexa', 'X', 'nuevo', 140],
  'la probabilidad va de 0 a 100',
);
await rejects(
  'insert into public.crm_opportunities (organization_id, client_name, title, stage) values ($1, $2, $3, $4)',
  ['a', 'Nexa', 'X', 'Etapa Rara'],
  'la clave de la etapa es minúscula y sin espacios',
);
await rejects(
  'insert into public.crm_opportunities (organization_id, client_name, title, stage, source) values ($1, $2, $3, $4, $5)',
  ['a', 'Nexa', 'X', 'nuevo', 'tiktok'],
  'el origen es uno de los conocidos',
);
await rejects(
  'insert into public.crm_opportunities (organization_id, client_name, title, stage, value) values ($1, $2, $3, $4, $5)',
  ['a', 'Nexa', 'X', 'nuevo', -1],
  'el valor no es negativo',
);

await db.query(
  `insert into public.crm_activities (organization_id, opportunity_id, kind, title) values ('a', $1, 'call', 'Llamada')`,
  [o1],
);
await rejects(
  `insert into public.crm_activities (organization_id, kind, title) values ('a', 'note', 'Sin sujeto')`,
  [],
  'una actividad sin negocio ni cliente no',
);
await rejects(
  `insert into public.crm_activities (organization_id, client_id, kind, title) values ('a', $1, 'fax', 'X')`,
  [C],
  'la clase es una de las conocidas',
);
await db.query('delete from public.crm_opportunities where id = $1', [o1]);
ok(
  (await db.query('select count(*)::int as n from public.crm_activities')).rows[0].n === 0,
  'borrar el negocio borra sus actividades',
);

const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const s1 = (
  await db.query(
    `insert into public.nps_surveys (organization_id, client_id, client_name, token) values ('a', $1, 'Nexa', $2) returning id`,
    [C, token],
  )
).rows[0].id;
await rejects(
  `insert into public.nps_surveys (organization_id, client_name, token) values ('b', 'Otra', $1)`,
  [token],
  'el token es único en toda la instalación',
);
await rejects(
  `insert into public.nps_surveys (organization_id, client_name, token) values ('a', 'Otra', 'corto')`,
  [],
  'un token corto no es un token',
);
await rejects(
  `insert into public.nps_responses (organization_id, survey_id, score) values ('a', $1, 11)`,
  [s1],
  'la calificación va de 0 a 10',
);
await db.query(
  `insert into public.nps_responses (organization_id, survey_id, score) values ('a', $1, 3)`,
  [s1],
);
await rejects(
  `insert into public.nps_responses (organization_id, survey_id, score) values ('a', $1, 9)`,
  [s1],
  'una respuesta por encuesta',
);

await db.query(
  `insert into public.crm_client_risk (organization_id, client_id, level, score, evidence) values ('a', $1, 'alto', 60, '["x"]')`,
  [C],
);
await db.query(
  `insert into public.crm_client_risk (organization_id, client_id, level, score) values ('a', $1, 'medio', 30)
   on conflict (organization_id, client_id) do update set level = excluded.level, score = excluded.score`,
  [C],
);
const risk = (await db.query('select level, told_level from public.crm_client_risk')).rows[0];
ok(risk.level === 'medio' && risk.told_level === null, 'el upsert actualiza sin tocar lo contado');
await rejects(
  `insert into public.crm_client_risk (organization_id, client_id, level, score) values ('b', $1, 'critico', 90)`,
  [C],
  'el nivel es alto, medio o bajo',
);

const TABLES = [
  'crm_pipelines',
  'crm_opportunities',
  'crm_activities',
  'nps_surveys',
  'nps_responses',
  'crm_client_risk',
];
for (const t of TABLES) {
  const r = (await db.query('select relrowsecurity from pg_class where relname = $1', [t])).rows[0];
  ok(r?.relrowsecurity === true, `RLS prendido en ${t}`);
  const g = (
    await db.query(
      `select count(*)::int as n from information_schema.role_table_grants where table_name = $1 and grantee in ('anon', 'authenticated')`,
      [t],
    )
  ).rows[0];
  ok(g.n === 0, `${t} no tiene permisos para anon/authenticated`);
}

console.log(`0193 crm: ${checks} comprobaciones, todas bien.`);
