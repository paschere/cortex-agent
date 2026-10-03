import assert from 'node:assert/strict';
// Migración 0195 contra PostgreSQL real (PGlite): contratos, obligaciones,
// perfil de cumplimiento, lista, PQRS y procesos judiciales.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/compliance/contracts-compliance.sql-test.mjs
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
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.ba_organization (id text primary key);
  insert into public.ba_organization values ('a'), ('b');
  create table public.users (id uuid primary key);
  insert into public.users values ('${USER}');
  create table public.clients (id uuid primary key);
  create table public.suppliers (id uuid primary key);
  create table public.kb_documents (id uuid primary key);
  insert into public.kb_documents values ('${DOC}');
  create table public.commitments (id uuid primary key);
  create table public.document_expirations (id uuid primary key);
`);
await db.exec(migration('0195_contracts_compliance.sql'));
await db.exec(migration('0195_contracts_compliance.sql'));
ok(true, 'la migración corre dos veces');

// --- Contratos ---------------------------------------------------------------
const {
  rows: [c],
} = await db.query(
  `insert into contracts(organization_id, contract_type, title) values ('a', 'confidencialidad', 'NDA Coltrans') returning *`,
);
ok(c.status === 'borrador' && c.renewal === 'ninguna' && c.currency === 'COP', 'nace borrador, sin renovación, en pesos');
await rejects(`update contracts set status = 'firmado' where id = $1`, [c.id], 'firmado sin fecha ni copia: no');
await db.query(`update contracts set status = 'firmado', document_id = $2 where id = $1`, [c.id, DOC]);
ok(true, 'firmado con la copia firmada');
await rejects(`update contracts set status = 'terminado' where id = $1`, [c.id], 'terminado sin fecha: no');
await rejects(
  `insert into contracts(organization_id, contract_type, title, start_on, end_on) values ('a', 'otro', 'Malo', '2026-12-01', '2026-01-01')`,
  [],
  'fin antes del inicio: no',
);
await rejects(`insert into contracts(organization_id, contract_type, title) values ('a', 'leasing', 'X1')`, [], 'tipo conocido');

// --- Obligaciones ----------------------------------------------------------
await rejects(
  `insert into contract_obligations(organization_id, contract_id, party, description, source) values ('a', $1, 'nosotros', 'Pagar', 'documento')`,
  [c.id],
  'lo leído de un documento lleva su frase',
);
await rejects(
  `insert into contract_obligations(organization_id, contract_id, party, description, source, status) values ('a', $1, 'nosotros', 'Pagar', 'manual', 'confirmada')`,
  [c.id],
  'confirmada exige quién y cuándo',
);
await db.query(
  `insert into contract_obligations(organization_id, contract_id, party, description, source, evidence_quote) values ('a', $1, 'contraparte', 'Guardar reserva', 'documento', 'no divulgará la información')`,
  [c.id],
);
ok(true, 'propuesta con su frase');

// --- Perfil y lista --------------------------------------------------------
await db.query(`insert into compliance_profiles(organization_id) values ('a')`);
await rejects(`insert into compliance_profiles(organization_id) values ('a')`, [], 'un perfil por empresa');
await rejects(`update compliance_profiles set pqrs_enabled = true where organization_id = 'a'`, [], 'formulario prendido sin token: no');
await rejects(`update compliance_profiles set pqrs_token = 'corto' where organization_id = 'a'`, [], 'token largo');
await rejects(`update compliance_profiles set sectors = '{petroleo}' where organization_id = 'a'`, [], 'sectores conocidos');
const {
  rows: [item],
} = await db.query(
  `insert into compliance_items(organization_id, item_key, period, area, title, frequency) values ('a', 'asamblea_ordinaria', '2026', 'societario', 'Asamblea 2026', 'anual') returning *`,
);
await rejects(
  `insert into compliance_items(organization_id, item_key, period, area, title, frequency) values ('a', 'asamblea_ordinaria', '2026', 'societario', 'Otra', 'anual')`,
  [],
  'una por clave y período',
);
await rejects(`update compliance_items set status = 'cumplido', completed_at = now() where id = $1`, [item.id], 'cumplido sin evidencia: no');
await db.query(`update compliance_items set status = 'cumplido', completed_at = now(), evidence_note = 'Acta 12' where id = $1`, [item.id]);
ok(true, 'cumplido con evidencia');

// --- PQRS --------------------------------------------------------------------
const pq = (seq, extra = '') =>
  `insert into pqrs(organization_id, year, seq, radicado, channel, kind, subject, body, requester_name, received_on, deadline_days, due_on, deadline_basis${extra ? ', consent_accepted' : ''}) values ('a', 2026, ${seq}, 'PQRS-2026-${String(seq).padStart(6, '0')}', '${extra ? 'formulario' : 'correo'}', 'reclamo', 'Cobro doble', 'Me cobraron dos veces', 'Ana Ruiz', '2026-10-01', 15, '2026-10-23', 'Ley 1755'${extra ? ', true' : ''}) returning *`;
const {
  rows: [p1],
} = await db.query(pq(1));
ok(p1.status === 'radicada' && p1.matter === 'general', 'radicada, materia general');
await rejects(pq(1), [], 'consecutivo único por año');
await rejects(
  `insert into pqrs(organization_id, year, seq, radicado, channel, kind, subject, body, requester_name, received_on, deadline_days, due_on, deadline_basis) values ('a', 2026, 9, 'PQRS-2026-000009', 'formulario', 'queja', 'Algo', 'x', 'Ana', '2026-10-01', 15, '2026-10-23', 'x')`,
  [],
  'el formulario exige la autorización de datos',
);
await db.query(pq(2, 'form'));
ok(true, 'el formulario con autorización');
await rejects(`update pqrs set status = 'respondida' where id = $1`, [p1.id], 'respondida sin respuesta: no');
await rejects(`update pqrs set extended_due_on = '2026-10-10' where id = $1`, [p1.id], 'ampliar es posterior');
await rejects(`update pqrs set radicado = 'R-1' where id = $1`, [p1.id], 'forma del radicado');

// --- Procesos ----------------------------------------------------------------
await rejects(
  `insert into legal_cases(organization_id, title, radicado) values ('a', 'Ejecutivo', '0500131030012024')`,
  [],
  'radicado de 23 dígitos',
);
const {
  rows: [lc],
} = await db.query(
  `insert into legal_cases(organization_id, title, radicado) values ('a', 'Ejecutivo Coltrans', '05001310300120240012300') returning *`,
);
ok(lc.status === 'activo' && lc.role === 'demandado', 'activo, demandado por defecto');
await rejects(
  `insert into legal_cases(organization_id, title, radicado) values ('a', 'Duplicado', '05001310300120240012300')`,
  [],
  'radicado único por empresa',
);
await db.query(`insert into legal_cases(organization_id, title, radicado) values ('b', 'Otra empresa', '05001310300120240012300')`);
ok(true, 'el mismo radicado en otra empresa sí');
await db.query(`insert into legal_case_actions(organization_id, case_id, action_on, text) values ('a', $1, '2026-09-30', 'Auto admite demanda')`, [lc.id]);
ok(true, 'actuación');

// --- Acceso ------------------------------------------------------------------
for (const t of ['contracts', 'contract_obligations', 'compliance_profiles', 'compliance_items', 'pqrs', 'legal_cases']) {
  const {
    rows: [r],
  } = await db.query(`select relrowsecurity from pg_class where relname = $1`, [t]);
  ok(r.relrowsecurity, `${t}: RLS encendido`);
  const { rows } = await db.query(
    `select grantee from information_schema.role_table_grants where table_name = $1 and grantee in ('anon', 'authenticated')`,
    [t],
  );
  ok(rows.length === 0, `${t}: nada para anon ni authenticated`);
}
console.log(`0195: ${checks} comprobaciones OK`);
