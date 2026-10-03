import assert from 'node:assert/strict';
// Migración 0183 contra PostgreSQL real (PGlite): productos, bodegas, el libro
// de existencias con su vista y las órdenes de compra con sus estados.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/inventory/inventory.sql-test.mjs
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
  create table public.ba_organization (id text primary key);
  insert into public.ba_organization values ('a'), ('b');
  create table public.users (id uuid primary key);
  insert into public.users values ('${OWNER}');
  create table public.suppliers (id uuid primary key default gen_random_uuid(), organization_id text, name text);
  create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end $$;
`);
await db.exec(migration('0183_inventory.sql'));
await db.exec(migration('0183_inventory.sql'));
ok(true, 'la migración corre dos veces');

// --- Bodegas ----------------------------------------------------------------
const {
  rows: [main],
} = await db.query(
  `insert into stock_locations(organization_id, name, is_default) values ('a', 'Principal', true) returning *`,
);
await rejects(
  `insert into stock_locations(organization_id, name, is_default) values ('a', 'Otra', true)`,
  [],
  'una sola bodega por defecto',
);
await rejects(
  `insert into stock_locations(organization_id, name) values ('a', ' principal ')`,
  [],
  'nombre de bodega repetido',
);
await db.query(
  `insert into stock_locations(organization_id, name, is_default) values ('b', 'Principal', true)`,
);
ok(true, 'otra empresa con su bodega por defecto');

// --- Productos ----------------------------------------------------------------
const {
  rows: [p],
} = await db.query(
  `insert into products(organization_id, sku, name, min_stock, reorder_qty) values ('a', 'TOR-10', 'Tornillo 10mm', 50, 200) returning *`,
);
ok(p.unit === 'und' && p.stock_from === 'cortex' && p.track_stock === true, 'valores por defecto');
await rejects(
  `insert into products(organization_id, sku, name) values ('a', 'tor-10', 'Otro')`,
  [],
  'código repetido sin importar mayúsculas',
);
await db.query(
  `insert into products(organization_id, sku, name) values ('b', 'TOR-10', 'Tornillo')`,
);
ok(true, 'el mismo código en otra empresa');
await rejects(
  `insert into products(organization_id, name, stock_from) values ('a', 'X', 'accounting')`,
  [],
  'existencias del programa sin programa: no',
);
await rejects(
  `insert into products(organization_id, name, source_system) values ('a', 'X', 'siigo')`,
  [],
  'programa sin id: no',
);
await db.query(
  `insert into products(organization_id, name, source, source_system, source_ref, stock_from) values ('a', 'Del programa', 'accounting', 'siigo', 'abc', 'accounting')`,
);
await rejects(
  `insert into products(organization_id, name, source, source_system, source_ref) values ('a', 'Dup', 'accounting', 'siigo', 'abc')`,
  [],
  'el mismo id del programa dos veces: no',
);
await rejects('update products set reorder_qty = 0 where id = $1', [p.id], 'cantidad a pedir > 0');

// --- Movimientos y existencias ------------------------------------------------
const move = (kind, qty, extra = '') =>
  db.query(
    `insert into stock_movements(organization_id, product_id, location_id, kind, qty, unit_cost${extra ? ', dedupe_key' : ''})
     values ('a', $1, $2, $3, $4, 100${extra ? `, '${extra}'` : ''})`,
    [p.id, main.id, kind, qty],
  );
await move('entrada', 120, 'oc:1:l1');
await move('salida', -30);
await move('ajuste', -5);
await rejects(
  `insert into stock_movements(organization_id, product_id, location_id, kind, qty) values ('a', $1, $2, 'entrada', -1)`,
  [p.id, main.id],
  'una entrada negativa no',
);
await rejects(
  `insert into stock_movements(organization_id, product_id, location_id, kind, qty) values ('a', $1, $2, 'salida', 3)`,
  [p.id, main.id],
  'una salida positiva no',
);
await rejects(
  `insert into stock_movements(organization_id, product_id, location_id, kind, qty) values ('a', $1, $2, 'traslado', 3)`,
  [p.id, main.id],
  'un traslado sin id de traslado no',
);
await rejects(
  `insert into stock_movements(organization_id, product_id, location_id, kind, qty) values ('a', $1, $2, 'ajuste', 0)`,
  [p.id, main.id],
  'cantidad cero no',
);
let failedDup = false;
try {
  await move('entrada', 120, 'oc:1:l1');
} catch {
  failedDup = true;
}
ok(failedDup, 'la misma línea recibida dos veces no');
const {
  rows: [level],
} = await db.query('select * from stock_levels where product_id = $1', [p.id]);
ok(
  Number(level.on_hand) === 85 && level.organization_id === 'a',
  'la vista suma el libro: 120 − 30 − 5',
);
ok(level.movements === 3, 'cuenta los movimientos');

// --- Órdenes de compra ------------------------------------------------------
const {
  rows: [po],
} = await db.query(
  `insert into purchase_orders(organization_id, number, supplier_name, total) values ('a', 1, 'Ferretería Central', 1000) returning *`,
);
ok(po.status === 'borrador' && po.payment_terms_days === 30, 'nace en borrador, 30 días');
await rejects(
  `insert into purchase_orders(organization_id, number, supplier_name) values ('a', 1, 'Otro')`,
  [],
  'consecutivo repetido',
);
await db.query(
  `insert into purchase_orders(organization_id, number, supplier_name) values ('b', 1, 'Otro')`,
);
ok(true, 'el mismo consecutivo en otra empresa');
await rejects(
  `update purchase_orders set status = 'aprobada' where id = $1`,
  [po.id],
  'aprobada sin aprobación',
);
await db.query(
  `update purchase_orders set status = 'aprobada', approved_at = now(), approved_by = $2 where id = $1`,
  [po.id, OWNER],
);
await rejects(
  `update purchase_orders set status = 'enviada' where id = $1`,
  [po.id],
  'enviada sin fecha de envío',
);
await rejects(
  `update purchase_orders set status = 'facturada' where id = $1`,
  [po.id],
  'facturada sin factura',
);
await rejects(
  `update purchase_orders set status = 'inventada' where id = $1`,
  [po.id],
  'estado desconocido',
);
await rejects(
  `update purchase_orders set supplier_tax_id = '12a' where id = $1`,
  [po.id],
  'NIT en dígitos',
);

await db.query(
  `insert into purchase_order_lines(organization_id, purchase_order_id, product_id, description, qty, unit_cost) values ('a', $1, $2, 'Tornillo', 10, 5)`,
  [po.id, p.id],
);
await rejects(
  'update purchase_order_lines set qty_received = 11',
  [],
  'no se recibe más de lo pedido',
);
await rejects(
  `insert into purchase_order_lines(organization_id, purchase_order_id, description, qty) values ('a', $1, 'x', 0)`,
  [po.id],
  'línea sin cantidad',
);
await db.query('delete from purchase_orders where id = $1', [po.id]);
const { rows: orphan } = await db.query(
  'select 1 from purchase_order_lines where purchase_order_id = $1',
  [po.id],
);
ok(orphan.length === 0, 'las líneas se van con su orden');

// --- Acceso -----------------------------------------------------------------
for (const t of [
  'products',
  'stock_locations',
  'stock_movements',
  'purchase_orders',
  'purchase_order_lines',
]) {
  const {
    rows: [r],
  } = await db.query('select relrowsecurity from pg_class where relname = $1', [t]);
  ok(r.relrowsecurity === true, `RLS en ${t}`);
  const { rows: anon } = await db.query(
    `select has_table_privilege('anon', 'public.${t}', 'select') as a, has_table_privilege('service_role', 'public.${t}', 'select') as s`,
  );
  ok(anon[0].a === false && anon[0].s === true, `${t}: anon no, service_role sí`);
}
const { rows: view } = await db.query(
  `select has_table_privilege('authenticated', 'public.stock_levels', 'select') as a`,
);
ok(view[0].a === false, 'la vista tampoco se abre a authenticated');

console.log(`0183 ok: ${checks} comprobaciones`);
