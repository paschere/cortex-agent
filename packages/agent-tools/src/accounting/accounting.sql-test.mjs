import assert from 'node:assert/strict';
// Migración 0165 contra PostgreSQL real (PGlite): la conexión con un programa
// contable, la cartera que trae y los avisos de mora de sus facturas.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/accounting/accounting.sql-test.mjs
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

await db.exec('create role anon; create role authenticated; create role service_role;');
// De la 0076 sólo hace falta que exista la extracción a la que apunta el aviso.
await db.exec(
  'create table public.document_extractions (id uuid primary key default gen_random_uuid());',
);
const m159 = migration('0159_receivable_notices.sql');
await db.exec(m159.slice(0, m159.indexOf('alter table public.notifications')));
await db.exec(migration('0165_accounting_connectors.sql'));

const user = '11111111-1111-4111-a111-111111111111';
const insertConn = (org, provider, entities = null) =>
  db.query(
    `insert into accounting_connections(organization_id, provider, created_by, account_label, credentials_enc${entities ? ', entities' : ''})
     values ($1, $2, $3, 'contabilidad@andina.co', 'Y2lmcmFkby1jaWZyYWRvLWNpZnJhZG8='${entities ? ', $4' : ''})
     returning id, interval_minutes, entities, enabled, cursors, trackers`,
    entities ? [org, provider, user, entities] : [org, provider, user],
  );

const {
  rows: [conn],
} = await insertConn('a', 'siigo');
ok(
  conn.id && conn.interval_minutes === 60 && conn.enabled,
  'una conexión nace activa, cada 60 minutos',
);
ok(conn.entities.length === 4, 'trae las cuatro cosas por defecto');
ok(
  JSON.stringify(conn.cursors) === '{}' && JSON.stringify(conn.trackers) === '{}',
  'sin cursores ni tablas',
);
await rejects(
  `insert into accounting_connections(organization_id, provider, created_by, account_label, credentials_enc) values ('a', 'siigo', $1, 'otra', 'Y2lmcmFkby1jaWZyYWRvLWNpZnJhZG8=')`,
  [user],
  'una sola conexión por programa y empresa',
);
ok(
  (await insertConn('a', 'alegra')).rows.length === 1,
  'la misma empresa puede conectar otro programa',
);
ok((await insertConn('b', 'siigo')).rows.length === 1, 'otra empresa conecta su propio Siigo');
await rejects(
  `insert into accounting_connections(organization_id, provider, created_by, account_label, credentials_enc) values ('c', 'world_office', $1, 'x', 'Y2lmcmFkby1jaWZyYWRvLWNpZnJhZG8=')`,
  [user],
  'un programa que no está en la lista no entra',
);
await rejects(
  `insert into accounting_connections(organization_id, provider, created_by, account_label, credentials_enc, entities) values ('d', 'siigo', $1, 'x', 'Y2lmcmFkby1jaWZyYWRvLWNpZnJhZG8=', '{invoices,nomina}')`,
  [user],
  'sólo clientes, productos, facturas y pagos',
);
await rejects(
  `insert into accounting_connections(organization_id, provider, created_by, account_label, credentials_enc, interval_minutes) values ('e', 'siigo', $1, 'x', 'Y2lmcmFkby1jaWZyYWRvLWNpZnJhZG8=', 5)`,
  [user],
  'no más seguido que cada 15 minutos',
);
await rejects(
  `update accounting_connections set last_status = 'running' where id = $1`,
  [conn.id],
  'el estado es ok, partial o error',
);
await db.query(`update accounting_connections set last_status = 'partial' where id = $1`, [
  conn.id,
]);
ok(true, 'partial es un estado válido');

const insertInvoice = (org, ref, balance = 1200000, total = 2000000) =>
  db.query(
    `insert into accounting_invoices(organization_id, source_system, source_ref, doc_number, currency, total, balance, issued_on, due_on)
     values ($1, 'siigo', $2, 'FV-2-22', 'COP', $3, $4, '2026-07-15', '2026-08-14') returning id`,
    [org, ref, total, balance],
  );
const {
  rows: [inv],
} = await insertInvoice('a', 'i-1');
ok(inv.id, 'una factura de Siigo entra a la cartera');
await rejects(
  `insert into accounting_invoices(organization_id, source_system, source_ref, doc_number, currency, total, balance, issued_on) values ('a', 'siigo', 'i-1', 'FV-2-22', 'COP', 1, 1, '2026-07-15')`,
  [],
  'la misma factura del mismo programa no se duplica',
);
ok(
  (await insertInvoice('b', 'i-1')).rows.length === 1,
  'el mismo id en otra empresa es otra factura',
);
await rejects(
  `insert into accounting_invoices(organization_id, source_system, source_ref, doc_number, currency, total, balance, issued_on) values ('a', 'siigo', 'i-9', 'FV-9', 'pesos', 1, 1, '2026-07-15')`,
  [],
  'la moneda son tres letras',
);
await rejects(
  `insert into accounting_invoices(organization_id, source_system, source_ref, doc_number, currency, total, balance, issued_on) values ('a', 'siigo', 'i-8', 'FV-8', 'COP', 1, -5, '2026-07-15')`,
  [],
  'un saldo nunca es negativo',
);
const upserted = await db.query(
  `insert into accounting_invoices(organization_id, source_system, source_ref, doc_number, currency, total, balance, issued_on)
   values ('a', 'siigo', 'i-1', 'FV-2-22', 'COP', 2000000, 0, '2026-07-15')
   on conflict (organization_id, source_system, source_ref) do update set balance = excluded.balance
   returning id, balance`,
);
ok(
  upserted.rows[0].id === inv.id && Number(upserted.rows[0].balance) === 0,
  'traerla otra vez actualiza el saldo',
);

// Los avisos de mora: exactamente una de las dos facturas, y una vez por escalón.
const {
  rows: [ext],
} = await db.query('insert into document_extractions default values returning id');
await db.query(
  `insert into receivable_notices(organization_id, extraction_id, stage, sent_on) values ('a', $1, 30, '2026-10-01')`,
  [ext.id],
);
ok(true, 'un aviso de una extracción sigue como siempre');
await db.query(
  `insert into receivable_notices(organization_id, accounting_invoice_id, stage, sent_on) values ('a', $1, 30, '2026-10-01')`,
  [inv.id],
);
ok(true, 'un aviso de una factura de Siigo entra por su columna');
await rejects(
  `insert into receivable_notices(organization_id, accounting_invoice_id, stage, sent_on) values ('a', $1, 30, '2026-10-02')`,
  [inv.id],
  'el mismo escalón de la misma factura de Siigo se avisa una vez',
);
await rejects(
  `insert into receivable_notices(organization_id, stage, sent_on) values ('a', 60, '2026-10-01')`,
  [],
  'un aviso sin factura no existe',
);
await rejects(
  `insert into receivable_notices(organization_id, extraction_id, accounting_invoice_id, stage, sent_on) values ('a', $1, $2, 60, '2026-10-01')`,
  [ext.id, inv.id],
  'ni uno que nombre las dos',
);
await db.query('delete from accounting_invoices where id = $1', [inv.id]);
const left = await db.query(
  'select count(*)::int as n from receivable_notices where accounting_invoice_id is not null',
);
ok(left.rows[0].n === 0, 'borrar la factura borra sus avisos');

const rls = await db.query(
  `select relname, relrowsecurity from pg_class where relname in ('accounting_connections', 'accounting_invoices') order by relname`,
);
ok(
  rls.rows.length === 2 && rls.rows.every((r) => r.relrowsecurity),
  'RLS activo en las dos tablas',
);
const grants = await db.query(
  `select grantee from information_schema.role_table_grants where table_name in ('accounting_connections', 'accounting_invoices') and grantee in ('anon', 'authenticated')`,
);
ok(grants.rows.length === 0, 'ni anon ni authenticated pueden tocarlas');

console.log(`0165 accounting connectors: ${checks} comprobaciones, todas bien.`);
