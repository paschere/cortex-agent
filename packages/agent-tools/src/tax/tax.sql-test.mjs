import assert from 'node:assert/strict';
// Migración 0180 contra PostgreSQL real (PGlite): el perfil tributario (una
// fila por empresa) y las obligaciones (una por empresa, año y llave).
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/tax/tax.sql-test.mjs
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

const USER = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const COMMITMENT = '33333333-3333-4333-8333-333333333333';

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.ba_organization (id text primary key);
  insert into public.ba_organization values ('a'), ('b');
  create table public.users (id uuid primary key);
  insert into public.users values ('${USER}');
  create table public.kb_documents (id uuid primary key);
  insert into public.kb_documents values ('${DOC}');
  create table public.commitments (id uuid primary key);
  insert into public.commitments values ('${COMMITMENT}');
`);
await db.exec(migration('0180_tax_calendar.sql'));
await db.exec(migration('0180_tax_calendar.sql'));
ok(true, 'la migración corre dos veces');

// --- Perfil -----------------------------------------------------------------
const {
  rows: [p],
} = await db.query(
  `insert into tax_profiles(organization_id, nit, dv, owner_user_id) values ('a', '900123456', '8', $1) returning *`,
  [USER],
);
ok(p.person_type === 'juridica', 'persona jurídica por defecto');
ok(p.iva_periodicity === 'none', 'sin IVA por defecto');
ok(p.notice_days === 7, 'aviso de 7 días');
ok(p.camara_comercio === true, 'matrícula mercantil por defecto');
await rejects(
  `insert into tax_profiles(organization_id, nit) values ('a', '900999999')`,
  [],
  'un perfil por empresa',
);
await rejects(
  `insert into tax_profiles(organization_id, nit) values ('b', '900.123.456')`,
  [],
  'NIT sólo dígitos',
);
await rejects(
  `insert into tax_profiles(organization_id, nit, dv) values ('b', '900123456', '12')`,
  [],
  'DV de un dígito',
);
await rejects(
  `insert into tax_profiles(organization_id, nit, ica_city) values ('b', '900123456', 'tunja')`,
  [],
  'ciudad del ICA conocida',
);
await rejects(
  `insert into tax_profiles(organization_id, nit, notice_days) values ('b', '900123456', 0)`,
  [],
  'aviso de al menos un día',
);

// --- Obligaciones ---------------------------------------------------------------
const insert = (org, key, extra = '') =>
  db.query(
    `insert into tax_obligations(organization_id, year, obligation_key, kind, period, title, authority, due_date, rule_version${extra ? `, ${extra.split('=')[0]}` : ''})
     values ($1, 2026, $2, 'iva', 'Bimestre 1', 'IVA bimestral — bimestre 1', 'DIAN', '2026-03-12', 'co-2026.1'${extra ? `, ${extra.split('=')[1]}` : ''}) returning *`,
    [org, key],
  );
const {
  rows: [o],
} = await insert('a', 'iva:b1');
ok(o.status === 'pendiente', 'nace pendiente');
ok(o.requires_payment === true, 'se paga por defecto');
ok(o.needs_confirmation === false, 'confirmada por defecto');
await rejects(
  `insert into tax_obligations(organization_id, year, obligation_key, kind, period, title, authority, due_date, rule_version)
   values ('a', 2026, 'iva:b1', 'iva', 'x', 'otra vez', 'DIAN', '2026-03-12', 'v')`,
  [],
  'una llave por empresa y año',
);
const {
  rows: [other],
} = await insert('b', 'iva:b1');
ok(Boolean(other.id), 'la misma llave en otra empresa sí');
await rejects(
  `insert into tax_obligations(organization_id, year, obligation_key, kind, period, title, authority, due_date, rule_version)
   values ('a', 2026, 'x:1', 'predial', 'x', 'Predial', 'Alcaldía', '2026-03-12', 'v')`,
  [],
  'tipo de obligación conocido',
);
await rejects(
  `update tax_obligations set status = 'pagada' where id = $1`,
  [o.id],
  'pagada sin cuándo: no',
);
await db.query(
  `update tax_obligations set status = 'pagada', status_at = now(), status_by = $2, evidence_document_id = $3, evidence_url = 'https://muisca.dian.gov.co/r', commitment_id = $4 where id = $1`,
  [o.id, USER, DOC, COMMITMENT],
);
ok(true, 'pagada con evidencia y vencimiento');
await rejects(
  `update tax_obligations set evidence_url = 'javascript:alert(1)' where id = $1`,
  [o.id],
  'la evidencia es un enlace http(s)',
);
await rejects(
  `update tax_obligations set status = 'archivada', status_at = now() where id = $1`,
  [o.id],
  'estado conocido',
);
await db.query('delete from public.commitments where id = $1', [COMMITMENT]);
const {
  rows: [after],
} = await db.query('select commitment_id from tax_obligations where id = $1', [o.id]);
ok(after.commitment_id === null, 'borrar el vencimiento no borra la obligación');
await db.query(`delete from public.ba_organization where id = 'b'`);
const {
  rows: [{ n }],
} = await db.query(`select count(*)::int as n from tax_obligations where organization_id = 'b'`);
ok(n === 0, 'borrar la empresa borra sus obligaciones');

// --- Acceso -----------------------------------------------------------------------
for (const table of ['tax_profiles', 'tax_obligations']) {
  const {
    rows: [rls],
  } = await db.query('select relrowsecurity from pg_class where relname = $1', [table]);
  ok(rls.relrowsecurity === true, `${table}: RLS encendido`);
  const { rows: grants } = await db.query(
    'select grantee, privilege_type from information_schema.role_table_grants where table_name = $1',
    [table],
  );
  ok(
    !grants.some((g) => g.grantee === 'anon' || g.grantee === 'authenticated'),
    `${table}: sin anon ni authenticated`,
  );
  ok(
    grants.some((g) => g.grantee === 'service_role' && g.privilege_type === 'SELECT'),
    `${table}: service_role lee`,
  );
}

console.log(`0180 tax_calendar: ${checks} comprobaciones ok`);
