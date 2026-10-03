import assert from 'node:assert/strict';
// Migración 0182 contra PostgreSQL real (PGlite): cotizaciones, pedidos y
// facturas; el consecutivo por empresa; y las reglas que la base defiende sola.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/sales/sales.sql-test.mjs
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
  new URL('../../../../infra/supabase/migrations/0182_sales_documents.sql', import.meta.url),
  'utf8',
);

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.ba_organization (id text primary key);
  create table public.users (id uuid primary key);
  create table public.clients (id uuid primary key default gen_random_uuid());
  insert into public.ba_organization values ('a'), ('b');
`);
await db.exec(migration);
// Idempotente: correrla otra vez no rompe nada.
await db.exec(migration);
ok(true, 'la migración corre dos veces');

const next = async (org, kind) =>
  (await db.query('select public.sales_next_number($1, $2) as n', [org, kind])).rows[0].n;
ok((await next('a', 'quote')) === 1, 'la primera cotización es la 1');
ok((await next('a', 'quote')) === 2, 'la segunda es la 2');
ok((await next('a', 'order')) === 1, 'cada clase lleva su propia cuenta');
ok((await next('b', 'quote')) === 1, 'cada empresa lleva su propia cuenta');
await rejects(
  'select public.sales_next_number($1, $2)',
  ['a', 'receipt'],
  'una clase desconocida no tiene número',
);

const insertDoc = (org, kind, number, status, extra = {}) => {
  const cols = [
    'organization_id',
    'kind',
    'number',
    'status',
    'client_name',
    ...Object.keys(extra),
  ];
  const vals = [org, kind, number, status, 'Nexa Logística', ...Object.values(extra)];
  return db.query(
    `insert into public.sales_documents (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
    vals,
  );
};

const {
  rows: [quote],
} = await insertDoc('a', 'quote', 1, 'borrador');
ok(quote.currency === 'COP' && quote.payment_form === 'credito', 'nace en pesos y a crédito');
ok(quote.issue_date !== null, 'la fecha de emisión se pone sola');
await rejects(
  "insert into public.sales_documents (organization_id, kind, number, status, client_name) values ('a', 'quote', 1, 'borrador', 'Otra')",
  [],
  'el número no se repite en la misma empresa y clase',
);
await insertDoc('b', 'quote', 1, 'borrador');
ok(true, 'otra empresa sí puede tener su COT-1');
await rejects(
  "insert into public.sales_documents (organization_id, kind, number, status, client_name) values ('a', 'order', 9, 'enviada', 'X')",
  [],
  'un pedido no puede estar «enviada»',
);
await rejects(
  "insert into public.sales_documents (organization_id, kind, number, status, client_name) values ('a', 'invoice', 9, 'emitida', 'X')",
  [],
  'una factura «emitida» sin id del programa no se puede escribir',
);
await rejects(
  "insert into public.sales_documents (organization_id, kind, number, status, client_name, client_tax_id) values ('a', 'quote', 9, 'borrador', 'X', '900.123')",
  [],
  'el NIT se guarda sólo en dígitos',
);

const {
  rows: [order],
} = await insertDoc('a', 'order', 1, 'pedido', { source_id: quote.id });
const {
  rows: [invoice],
} = await insertDoc('a', 'invoice', 1, 'borrador', { source_id: order.id });
await rejects(
  "insert into public.sales_documents (organization_id, kind, number, status, client_name, source_id) values ('a', 'invoice', 2, 'borrador', 'X', $1)",
  [order.id],
  'una sola factura viva por documento de origen',
);
await db.query("update public.sales_documents set status = 'anulada' where id = $1", [invoice.id]);
await insertDoc('a', 'invoice', 2, 'borrador', { source_id: order.id });
ok(true, 'anulada la primera, se puede preparar otra');

const {
  rows: [emitted],
} = await db.query(
  "update public.sales_documents set status = 'emitida', provider = 'siigo', provider_invoice_id = 'abc', cufe = 'c' where kind = 'invoice' and number = 2 and organization_id = 'a' returning *",
);
ok(emitted.status === 'emitida', 'con id del programa sí queda emitida');
await rejects(
  "update public.sales_documents set provider = 'quickbooks' where id = $1",
  [emitted.id],
  'sólo Siigo o Alegra emiten',
);

await db.query(
  `insert into public.sales_document_lines (organization_id, document_id, position, description, quantity, unit_price, tax_rate)
   values ('a', $1, 1, 'Flete', 10, 1200000, 'iva_19')`,
  [quote.id],
);
await rejects(
  `insert into public.sales_document_lines (organization_id, document_id, position, description, quantity, unit_price, tax_rate)
   values ('a', $1, 2, 'Flete', 1, 1, 'iva_16')`,
  [quote.id],
  'sólo tarifas de IVA colombianas',
);
await rejects(
  `insert into public.sales_document_lines (organization_id, document_id, position, description, quantity, unit_price)
   values ('a', $1, 1, 'Otra', 1, 1)`,
  [quote.id],
  'una posición por línea',
);
await rejects(
  `insert into public.sales_document_lines (organization_id, document_id, position, description, quantity, unit_price)
   values ('a', $1, 3, 'Gratis', 0, 1)`,
  [quote.id],
  'la cantidad es positiva',
);
await db.query(
  "insert into public.sales_document_events (organization_id, document_id, kind, actor_label) values ('a', $1, 'accepted', 'Carlos (desde el enlace)')",
  [quote.id],
);
await rejects(
  "insert into public.sales_document_events (organization_id, document_id, kind) values ('a', $1, 'paid')",
  [quote.id],
  'sólo clases de evento conocidas',
);
await rejects(
  "update public.sales_documents set share_token = 'corto' where id = $1",
  [quote.id],
  'un token de enlace corto no se acepta',
);

await db.query('delete from public.sales_documents where id = $1', [quote.id]);
const left = await db.query('select count(*)::int as n from public.sales_document_lines');
ok(left.rows[0].n === 0, 'borrar el documento borra sus líneas');
const orphan = await db.query('select source_id from public.sales_documents where id = $1', [
  order.id,
]);
ok(orphan.rows[0].source_id === null, 'el pedido sobrevive sin su cotización');

const grants = await db.query(
  "select count(*)::int as n from information_schema.role_table_grants where table_name like 'sales_%' and grantee in ('anon', 'authenticated')",
);
ok(grants.rows[0].n === 0, 'ni anon ni authenticated tocan estas tablas');

console.log(`0182_sales_documents: ${checks} comprobaciones en verde`);
