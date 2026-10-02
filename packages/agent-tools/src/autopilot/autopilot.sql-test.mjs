import assert from 'node:assert/strict';
// Migración 0176 contra PostgreSQL real (PGlite): la configuración del piloto,
// sus corridas (una por empresa y día) y sus cosas (una por clave y corrida).
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/autopilot/autopilot.sql-test.mjs
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

const OWNER = '11111111-1111-4111-8111-111111111111';

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.users (id uuid primary key);
  insert into public.users values ('${OWNER}');
  create table public.mandates (id uuid primary key default gen_random_uuid());
  create table public.actions (id uuid primary key default gen_random_uuid());
`);
await db.exec(migration('0176_autopilot.sql'));
await db.exec(migration('0176_autopilot.sql'));
ok(true, 'la migración corre dos veces');

// --- Configuración --------------------------------------------------------
const {
  rows: [s],
} = await db.query(`insert into autopilot_settings(organization_id) values ('a') returning *`);
ok(s.enabled === false, 'nace apagado');
ok(s.run_hour === 7, 'a las 7');
ok(JSON.stringify(s.run_days) === '[1,2,3,4,5]', 'lunes a viernes');
ok(s.timezone === 'America/Bogota', 'Bogotá');
await rejects(
  `update autopilot_settings set enabled = true where organization_id = 'a'`,
  [],
  'encendido sin actor: no',
);
await db.query(
  `update autopilot_settings set enabled = true, actor_user_id = $1 where organization_id = 'a'`,
  [OWNER],
);
ok(true, 'encendido con actor: sí');
await rejects('update autopilot_settings set run_hour = 24', [], 'hora fuera de rango');
await rejects(`update autopilot_settings set run_days = '{0,1}'`, [], 'día 0 no existe');
await rejects(`update autopilot_settings set run_days = '{}'`, [], 'sin días no');
await rejects('update autopilot_settings set max_external_messages = 51', [], 'tope de mensajes');
await rejects('update autopilot_settings set max_actions_per_run = 0', [], 'tope de acciones');
await rejects(`update autopilot_settings set currency = 'cop'`, [], 'moneda en mayúsculas');
await rejects(`update autopilot_settings set area_levels = '[]'`, [], 'niveles: un objeto');
await rejects(`update autopilot_settings set timezone = 'UTC'`, [], 'sólo Bogotá por ahora');

// --- Corridas: una por empresa y día ---------------------------------------
const {
  rows: [run],
} = await db.query(
  `insert into autopilot_runs(organization_id, run_on, actor_user_id) values ('a', '2026-10-06', $1) returning *`,
  [OWNER],
);
ok(run.status === 'running', 'empieza en curso');
await rejects(
  `insert into autopilot_runs(organization_id, run_on) values ('a', '2026-10-06')`,
  [],
  'una sola corrida por día',
);
await db.query(`insert into autopilot_runs(organization_id, run_on) values ('b', '2026-10-06')`);
ok(true, 'otra empresa, el mismo día: sí');
await rejects(`update autopilot_runs set status = 'raro'`, [], 'estado desconocido');

// --- Cosas -----------------------------------------------------------------
const item = (over = {}) => {
  const row = {
    organization_id: 'a',
    run_id: run.id,
    dedupe_key: 'cobro:document:x:30',
    area: 'cobro',
    title: 'Cobrar $ 12.400.000 a Coltrans',
    why: 'Coltrans lleva 47 días de mora.',
    risk: 'medium',
    effect: 'external_message',
    decision: 'ask',
    decision_reason: 'Sale de la empresa.',
    tool_id: 'gmail.send_message',
    tool_input: JSON.stringify({ to: ['c@coltrans.co'] }),
    amount: 12400000,
    currency: 'COP',
    ...over,
  };
  const cols = Object.keys(row);
  return db.query(
    `insert into autopilot_items(${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
    Object.values(row),
  );
};
const {
  rows: [it],
} = await item();
ok(it.status === 'planned', 'nace en cola');
await rejects(
  `insert into autopilot_items(organization_id, run_id, dedupe_key, area, title, why, risk, decision, decision_reason, tool_id) values ('a', $1, 'cobro:document:x:30', 'cobro', 't', 'w', 'low', 'ask', 'r', 'x.y')`,
  [run.id],
  'la misma cosa dos veces en la misma corrida: no',
);
let failed = false;
try {
  await item({ area: 'nomina', dedupe_key: 'clave-2' });
} catch {
  failed = true;
}
ok(failed, 'área desconocida');
failed = false;
try {
  await item({ dedupe_key: 'clave-3', decision: 'do', tool_id: null });
} catch {
  failed = true;
}
ok(failed, 'hacer o preguntar sin herramienta: no');
await item({ dedupe_key: 'clave-4', decision: 'tell', tool_id: null, tool_input: null });
ok(true, 'contar sin herramienta: sí');
failed = false;
try {
  await item({ dedupe_key: 'clave-5', currency: null });
} catch {
  failed = true;
}
ok(failed, 'plata sin moneda: no');
failed = false;
try {
  await item({ dedupe_key: 'clave-6', href: 'https://fuera.com' });
} catch {
  failed = true;
}
ok(failed, 'enlace externo: no');
await rejects(
  'update autopilot_items set decided_by = $1 where id = $2',
  [OWNER, it.id],
  'decidido sin cuándo: no',
);
await db.query('update autopilot_items set decided_by = $1, decided_at = now() where id = $2', [
  OWNER,
  it.id,
]);
ok(true, 'decidido con quién y cuándo');
await rejects(
  `update autopilot_items set verification = 'casi' where id = $1`,
  [it.id],
  'verificación desconocida',
);
// Borrar la corrida se lleva sus cosas.
await db.query('delete from autopilot_runs where id = $1', [run.id]);
const {
  rows: [{ n }],
} = await db.query('select count(*)::int as n from autopilot_items');
ok(n === 0, 'las cosas se van con su corrida');

console.log(`0176 autopilot: ${checks} comprobaciones, todas bien.`);
