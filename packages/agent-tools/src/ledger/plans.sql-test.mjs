import assert from 'node:assert/strict';
// Migración 0173 contra PostgreSQL real (PGlite): escenarios guardados,
// recurrentes declarados o decididos, y facturas por pagar saldadas por una
// salida del banco.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/ledger/plans.sql-test.mjs
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const mig = (n) =>
  readFileSync(new URL(`../../../../infra/supabase/migrations/${n}`, import.meta.url), 'utf8');
await db.exec('create role anon; create role authenticated; create role service_role;');
await db.exec(mig('0172_money_ledger.sql'));
await db.exec(mig('0173_ledger_plans.sql'));
let n = 0;
const ok = (v, m) => {
  assert.ok(v, m);
  n++;
};
const rejects = async (sql, p, m) => {
  let f = false;
  try {
    await db.query(sql, p);
  } catch {
    f = true;
  }
  ok(f, m);
};

await db.query(
  `insert into ledger_scenarios(organization_id,label,label_key,adjustments) values ('a','Nexa','nexa','[{"kind":"drop_counterparty","counterpartyName":"Nexa"}]')`,
);
await rejects(
  `insert into ledger_scenarios(organization_id,label,label_key) values ('a','NEXA','nexa')`,
  [],
  'etiqueta única por empresa',
);
await db.query(
  `insert into ledger_scenarios(organization_id,label,label_key) values ('b','Nexa','nexa')`,
);
ok(true, 'otra empresa puede usar la misma etiqueta');
await rejects(
  `insert into ledger_scenarios(organization_id,label,label_key,adjustments) values ('a','x','x','{}')`,
  [],
  'ajustes tiene que ser lista',
);

const rec = `insert into ledger_recurring(organization_id,status,detected_key,label,direction,amount,currency,every,anchor) values ($1,$2,$3,'Arriendo','out',100,'COP',$4,$5)`;
await db.query(rec, ['a', 'declared', null, 'month', 5]);
await rejects(rec, ['a', 'ignored', null, 'month', 5], 'decidir exige detected_key');
await db.query(rec, ['a', 'ignored', 'det-1', 'month', 5]);
await rejects(rec, ['a', 'confirmed', 'det-1', 'month', 5], 'una decisión por llave');
await db.query(rec, ['b', 'confirmed', 'det-1', 'month', 5]);
await rejects(rec, ['a', 'declared', null, 'week', 9], 'día de la semana 1–7');
await rejects(
  `insert into ledger_recurring(organization_id,status,label,direction,amount,currency,every,anchor) values ('a','declared','x','out',0,'COP','month',1)`,
  [],
  'monto positivo',
);

const mv = async (over) => {
  const row = {
    organization_id: 'a',
    direction: 'out',
    kind: 'expense',
    status: 'settled',
    amount: 100,
    currency: 'COP',
    date: '2026-10-01',
    description: 'x',
    source_kind: 'bank',
    source_ref: Math.random().toString(),
    ...over,
  };
  const cols = Object.keys(row);
  return (
    await db.query(
      `insert into ledger_movements(${cols}) values (${cols.map((_, i) => `$${i + 1}`)}) returning id`,
      Object.values(row),
    )
  ).rows[0].id;
};
const debit = await mv({});
const debit2 = await mv({});
const payable = await mv({ kind: 'payable', status: 'expected', source_kind: 'document' });
const payable2 = await mv({ kind: 'payable', status: 'expected', source_kind: 'document' });
await db.query(
  `update ledger_movements set status='settled', settled_by=$1, settled_by_outstanding=100 where id=$2`,
  [debit, payable],
);
ok(true, 'una factura por pagar se salda con una salida');
await rejects(
  'update ledger_movements set settled_by=$1 where id=$2',
  [debit, payable2],
  'una salida salda una sola factura',
);
await rejects(
  'update ledger_movements set settled_by=$1 where id=$2',
  [debit2, debit],
  'sólo las facturas por pagar llevan settled_by',
);
await rejects(
  'update ledger_movements set settled_by=$1 where id=$1',
  [payable2],
  'no se salda consigo misma',
);

for (const t of ['ledger_scenarios', 'ledger_recurring']) {
  const { rows } = await db.query('select relrowsecurity from pg_class where relname=$1', [t]);
  ok(rows[0].relrowsecurity, `${t}: RLS encendido`);
  const g = await db.query(
    'select grantee, privilege_type from information_schema.role_table_grants where table_name=$1',
    [t],
  );
  ok(
    !g.rows.some((r) => ['anon', 'authenticated'].includes(r.grantee)),
    `${t}: nada para anon/authenticated`,
  );
  ok(
    g.rows.some((r) => r.grantee === 'service_role' && r.privilege_type === 'SELECT'),
    `${t}: service_role lee`,
  );
}
console.log(`0173 · ${n} comprobaciones en PGlite: ok`);
