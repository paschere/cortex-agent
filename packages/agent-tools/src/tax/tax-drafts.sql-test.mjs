import assert from 'node:assert/strict';
// Migración 0197 contra PostgreSQL real (PGlite): borradores, certificados,
// casillas nuevas del perfil y clases nuevas de obligación.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/tax/tax-drafts.sql-test.mjs
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
  create table public.kb_documents (id uuid primary key);
  insert into public.kb_documents values ('${DOC}');
  create table public.commitments (id uuid primary key);
  create table public.suppliers (id uuid primary key default gen_random_uuid(), organization_id text, name text);
`);
await db.exec(migration('0180_tax_calendar.sql'));
await db.exec(migration('0197_tax_drafts.sql'));
await db.exec(migration('0197_tax_drafts.sql'));
ok(true, 'la migración corre dos veces');

// Perfil: casillas nuevas con su valor por defecto.
const {
  rows: [p],
} = await db.query(
  `insert into tax_profiles(organization_id, nit) values ('a', '900123456') returning *`,
);
ok(p.impuesto_patrimonio === false && p.vinculados_exterior === false, 'casillas nuevas en falso');
ok(Array.isArray(p.ica_activities) && p.ica_activities.length === 0, 'sin actividades de ICA');
await rejects(
  `update tax_profiles set simple_rate = 50 where organization_id = 'a'`,
  [],
  'tarifa SIMPLE absurda',
);

// Clases nuevas de obligación.
for (const kind of ['patrimonio', 'rub', 'precios_transferencia', 'iva'])
  await db.query(
    `insert into tax_obligations(organization_id, year, obligation_key, kind, period, title, authority, due_date, rule_version)
     values ('a', 2026, $1, $2, 'x', 'Título', 'DIAN', '2026-09-10', 'co-2026.1')`,
    [`${kind}:t`, kind],
  );
ok(true, 'acepta patrimonio, rub y precios de transferencia');
await rejects(
  `insert into tax_obligations(organization_id, year, obligation_key, kind, period, title, authority, due_date, rule_version)
   values ('a', 2026, 'x:y', 'inventada', 'x', 'Título', 'DIAN', '2026-09-10', 'co-2026.1')`,
  [],
  'rechaza una clase inventada',
);
const {
  rows: [ob],
} = await db.query(`select id from tax_obligations where obligation_key = 'iva:t'`);

// Borradores.
const ins = (status, extra = '') =>
  db.query(
    `insert into tax_drafts(organization_id, obligation_id, form_kind, period_start, period_end, period_label, status, figures, rules_version${extra ? `, ${extra.split('=')[0]}` : ''})
     values ('a', $1, 'iva', '2026-09-01', '2026-10-31', 'Sep–oct', $2, '{}'::jsonb, 'co-tarifas-2026.1'${extra ? `, ${extra.split('=')[1]}` : ''}) returning id`,
    [ob.id, status],
  );
const {
  rows: [d1],
} = await ins('borrador');
ok(d1.id, 'inserta un borrador');
await rejects(
  `insert into tax_drafts(organization_id, obligation_id, form_kind, period_start, period_end, period_label, figures, rules_version)
   values ('a', '${ob.id}', 'iva', '2026-09-01', '2026-10-31', 'x', '{}'::jsonb, 'v')`,
  [],
  'un borrador vivo por obligación',
);
await rejects(
  `update tax_drafts set status = 'revisado' where id = '${d1.id}'`,
  [],
  'revisado sin quién/cuándo',
);
await db.query(
  `update tax_drafts set status = 'revisado', reviewed_at = now(), reviewed_by = $1 where id = $2`,
  [USER, d1.id],
);
await rejects(
  `update tax_drafts set status = 'presentado', presented_at = now() where id = '${d1.id}'`,
  [],
  'presentado sin evidencia',
);
await db.query(
  `update tax_drafts set status = 'presentado', presented_at = now(), evidence_document_id = $1 where id = $2`,
  [DOC, d1.id],
);
ok(true, 'presentado con el formulario');
await db.query(`update tax_drafts set status = 'anulado' where id = $1`, [d1.id]);
const {
  rows: [d2],
} = await ins('borrador');
ok(d2.id, 'anulado el anterior, se puede armar otro');
await rejects(
  `insert into tax_drafts(organization_id, form_kind, period_start, period_end, period_label, figures, rules_version)
   values ('a', 'iva', '2026-10-31', '2026-09-01', 'x', '{}'::jsonb, 'v')`,
  [],
  'periodo al revés',
);
await rejects(
  `insert into tax_drafts(organization_id, form_kind, period_start, period_end, period_label, figures, rules_version)
   values ('a', 'iva', '2026-09-01', '2026-10-31', 'x', '[]'::jsonb, 'v')`,
  [],
  'figures tiene que ser un objeto',
);

// Certificados.
const cert = (period, nit = '900555666') =>
  db.query(
    `insert into tax_withholding_certificates(organization_id, supplier_nit, supplier_name, kind, year, period, base, withheld)
     values ('a', $1, 'Ferretería', 'iva', 2026, $2, 100, 15)`,
    [nit, period],
  );
await cert(5);
await rejects(
  `insert into tax_withholding_certificates(organization_id, supplier_nit, supplier_name, kind, year, period, base, withheld)
   values ('a', '900555666', 'Ferretería', 'iva', 2026, 5, 1, 1)`,
  [],
  'un certificado por proveedor, clase y periodo',
);
await cert(6);
ok(true, 'otro bimestre sí');
await db.query(
  `insert into tax_withholding_certificates(organization_id, supplier_nit, supplier_name, kind, year, period, base, withheld)
   values ('b', '900555666', 'Ferretería', 'iva', 2026, 5, 1, 1)`,
);
ok(true, 'otra empresa, mismo proveedor');
await rejects(
  `insert into tax_withholding_certificates(organization_id, supplier_name, kind, year, base, withheld) values ('a', 'X', 'renta', 2026, -1, 0)`,
  [],
  'base negativa',
);

// Proveedores: concepto de retención.
await db.query(
  `insert into suppliers(organization_id, name, withholding_concept) values ('a', 'S', 'honorarios')`,
);
await rejects(
  `insert into suppliers(organization_id, name, withholding_concept) values ('a', 'S', 'inventado')`,
  [],
  'concepto inventado',
);

// Acceso.
const grants = await db.query(
  `select grantee, privilege_type from information_schema.role_table_grants where table_name in ('tax_drafts', 'tax_withholding_certificates')`,
);
ok(
  !grants.rows.some((g) => g.grantee === 'anon' || g.grantee === 'authenticated'),
  'nada para anon/authenticated',
);
ok(
  grants.rows.some((g) => g.grantee === 'service_role'),
  'service_role sí',
);
const rls = await db.query(
  `select relname, relrowsecurity from pg_class where relname in ('tax_drafts', 'tax_withholding_certificates')`,
);
ok(rls.rows.length === 2 && rls.rows.every((r) => r.relrowsecurity), 'RLS encendido');

console.log(`0197 tax_drafts: ${checks} comprobaciones ok`);
