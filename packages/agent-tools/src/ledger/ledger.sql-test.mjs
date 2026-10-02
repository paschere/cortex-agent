import assert from 'node:assert/strict';
// Migración 0172 contra PostgreSQL real (PGlite): el libro de plata, sus
// cuentas, sus reglas y su estado de sincronización.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/ledger/ledger.sql-test.mjs
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
await db.exec(migration('0172_money_ledger.sql'));

const insert = (over = {}) => {
  const row = {
    organization_id: 'a',
    direction: 'out',
    kind: 'expense',
    status: 'settled',
    amount: 2000000,
    currency: 'COP',
    date: '2026-10-01',
    description: 'Fletes',
    source_kind: 'chat',
    source_system: '',
    source_ref: 'h:1',
    ...over,
  };
  const cols = Object.keys(row);
  return db.query(
    `insert into ledger_movements(${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
    Object.values(row),
  );
};

const {
  rows: [first],
} = await insert();
ok(
  first.id && first.duplicate_of === null && first.category === null,
  'un movimiento nace sin duplicado ni categoría',
);
await rejects(
  `insert into ledger_movements(organization_id, direction, kind, status, amount, currency, date, description, source_kind, source_ref)
   values ('a', 'out', 'expense', 'settled', 1, 'COP', '2026-10-01', 'x', 'chat', 'h:1')`,
  [],
  'la misma fuente, sistema y referencia no entra dos veces (source_system vacío por defecto)',
);
await insert({ organization_id: 'b' });
ok(true, 'otra empresa puede tener la misma referencia');
await insert({ source_ref: 'h:2', source_system: 'hoja · gastos' });
ok(true, 'otro sistema, otra fila');

await rejects(
  `insert into ledger_movements(organization_id, direction, kind, status, amount, currency, date, description, source_kind, source_ref)
   values ('a', 'out', 'expense', 'settled', -5, 'COP', '2026-10-01', 'x', 'chat', 'neg')`,
  [],
  'los montos son positivos: el sentido lo pone direction',
);
await rejects(
  `insert into ledger_movements(organization_id, direction, kind, status, amount, currency, date, description, source_kind, source_ref)
   values ('a', 'out', 'expense', 'settled', 5, 'pesos', '2026-10-01', 'x', 'chat', 'cur')`,
  [],
  'la moneda son tres letras',
);
await rejects(
  `insert into ledger_movements(organization_id, direction, kind, status, amount, currency, date, description, source_kind, source_ref)
   values ('a', 'out', 'expense', 'settled', 5, 'COP', '2026-10-01', 'x', 'twitter', 'src')`,
  [],
  'sólo las fuentes del contrato',
);
await rejects(
  `insert into ledger_movements(organization_id, direction, kind, status, amount, currency, date, description, source_kind, source_ref, outstanding)
   values ('a', 'out', 'expense', 'settled', 5, 'COP', '2026-10-01', 'x', 'chat', 'out1', 3)`,
  [],
  'el saldo pendiente es sólo de facturas',
);
await rejects(
  `insert into ledger_movements(organization_id, direction, kind, status, amount, currency, date, description, source_kind, source_ref, category)
   values ('a', 'out', 'expense', 'settled', 5, 'COP', '2026-10-01', 'x', 'chat', 'cat1', 'nomina')`,
  [],
  'una categoría sin quién la puso no entra',
);
await rejects(
  `insert into ledger_movements(organization_id, direction, kind, status, amount, currency, date, description, source_kind, source_ref, category, category_source)
   values ('a', 'out', 'expense', 'settled', 5, 'COP', '2026-10-01', 'x', 'chat', 'cat2', 'Nómina', 'person')`,
  [],
  'la categoría es una clave, no una etiqueta',
);
await rejects(
  `insert into ledger_movements(organization_id, direction, kind, status, amount, currency, date, description, source_kind, source_ref, counterparty_tax_id)
   values ('a', 'out', 'expense', 'settled', 5, 'COP', '2026-10-01', 'x', 'chat', 'nit1', '900.123.456-7')`,
  [],
  'el NIT se guarda en dígitos',
);
const {
  rows: [invoice],
} = await insert({
  direction: 'in',
  kind: 'receivable',
  status: 'expected',
  amount: 5000000,
  outstanding: 2000000,
  due_date: '2026-10-15',
  source_kind: 'accounting',
  source_system: 'siigo',
  source_ref: 'invoice:88',
  link_key: 'invoice:in:FE88',
  category: 'ventas',
  category_source: 'rule',
});
ok(Number(invoice.outstanding) === 2000000, 'una factura guarda su saldo');

// El mismo hecho por dos fuentes: la que sobra apunta a la que manda.
const {
  rows: [twin],
} = await insert({ source_kind: 'bank', source_system: 'extracto · b', source_ref: 'd:1' });
await db.query('update ledger_movements set duplicate_of = $1 where id = $2', [twin.id, first.id]);
const {
  rows: [linked],
} = await db.query('select duplicate_of from ledger_movements where id = $1', [first.id]);
ok(linked.duplicate_of === twin.id, 'duplicate_of enlaza dos filas del mismo movimiento');
await rejects(
  'update ledger_movements set duplicate_of = id where id = $1',
  [twin.id],
  'una fila no es duplicado de sí misma',
);
await db.query('delete from ledger_movements where id = $1', [twin.id]);
const {
  rows: [released],
} = await db.query('select duplicate_of from ledger_movements where id = $1', [first.id]);
ok(released.duplicate_of === null, 'si la que mandaba desaparece, la otra vuelve a contar');
await rejects(
  `update ledger_movements set excluded_reason = 'otra' where id = $1`,
  [first.id],
  'sólo la disputa excluye',
);

// Cuentas.
const {
  rows: [account],
} = await db.query(
  `insert into ledger_accounts(organization_id, name, name_key, currency, balance, balance_at, balance_source, source_kind, source_ref)
   values ('a', 'Bancolombia corriente', 'bancolombia corriente', 'COP', -150000, '2026-10-01', 'manual', 'manual', 'bancolombia corriente') returning *`,
);
ok(Number(account.balance) === -150000, 'un sobregiro es un saldo');
await rejects(
  `insert into ledger_accounts(organization_id, name, name_key, currency, balance_at, balance_source, source_kind, source_ref)
   values ('a', 'BANCOLOMBIA CORRIENTE', 'bancolombia corriente', 'COP', '2026-10-01', 'bank', 'bank', 'x')`,
  [],
  'una cuenta por nombre y empresa',
);
await insert({ source_ref: 'acc1', account_id: account.id });
await db.query('delete from ledger_accounts where id = $1', [account.id]);
const {
  rows: [orphan],
} = await db.query(`select account_id from ledger_movements where source_ref = 'acc1'`);
ok(orphan.account_id === null, 'borrar la cuenta no borra sus movimientos');

// Reglas.
const {
  rows: [rule],
} = await db.query(
  `insert into ledger_category_rules(organization_id, pattern, category) values ('a', 'rappi', 'mercadeo') returning *`,
);
ok(rule.field === 'any' && rule.direction === 'any' && rule.hits === 0, 'una regla nace general');
await rejects(
  `insert into ledger_category_rules(organization_id, pattern, category) values ('a', 'rappi', 'software')`,
  [],
  'una regla por patrón, campo y sentido: cambiarla es actualizarla',
);
await insert({
  source_ref: 'ruled',
  category: 'mercadeo',
  category_source: 'rule',
  category_rule_id: rule.id,
});
await db.query('delete from ledger_category_rules where id = $1', [rule.id]);
const {
  rows: [kept],
} = await db.query(
  `select category, category_rule_id from ledger_movements where source_ref = 'ruled'`,
);
ok(
  kept.category === 'mercadeo' && kept.category_rule_id === null,
  'borrar la regla deja la categoría',
);

// Estado de la sincronización.
await db.query(
  `insert into ledger_sync_state(organization_id, cursors) values ('a', '{"payments": {"at": "x", "id": "y"}}')`,
);
await rejects(
  `insert into ledger_sync_state(organization_id) values ('a')`,
  [],
  'un estado por empresa',
);
await rejects(
  `insert into ledger_sync_state(organization_id, cursors) values ('c', '[]')`,
  [],
  'los cursores son un objeto',
);

// Acceso: sólo el servidor.
for (const table of [
  'ledger_movements',
  'ledger_accounts',
  'ledger_category_rules',
  'ledger_sync_state',
]) {
  const {
    rows: [rls],
  } = await db.query('select relrowsecurity from pg_class where relname = $1', [table]);
  ok(rls.relrowsecurity, `${table} tiene RLS`);
  const { rows: grants } = await db.query(
    'select grantee, privilege_type from information_schema.role_table_grants where table_name = $1',
    [table],
  );
  ok(
    !grants.some((g) => g.grantee === 'anon' || g.grantee === 'authenticated'),
    `${table}: nada para anon ni authenticated`,
  );
  ok(
    ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].every((p) =>
      grants.some((g) => g.grantee === 'service_role' && g.privilege_type === p),
    ),
    `${table}: service_role lee y escribe`,
  );
}

console.log(`0172 · ${checks} comprobaciones en PGlite: ok`);
