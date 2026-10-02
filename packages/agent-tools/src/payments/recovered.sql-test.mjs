import assert from 'node:assert/strict';
// Migración 0166 contra PostgreSQL real (PGlite): lo que se debía al avisar, las
// caídas de saldo vistas y la forma de lo recuperado en un asunto de Gerencia.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/payments/recovered.sql-test.mjs
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
await db.exec(
  'create table public.document_extractions (id uuid primary key default gen_random_uuid());',
);
// De la 0130 sólo hace falta la tabla de asuntos con su documento JSON.
await db.exec(`create table public.management_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  data jsonb not null
);`);
const m159 = migration('0159_receivable_notices.sql');
await db.exec(m159.slice(0, m159.indexOf('alter table public.notifications')));
await db.exec(migration('0165_accounting_connectors.sql'));
await db.exec(migration('0166_money_recovered.sql'));

const {
  rows: [inv],
} = await db.query(
  `insert into accounting_invoices(organization_id, source_system, source_ref, doc_number, currency, total, balance, issued_on)
   values ('a', 'siigo', 'i-1', 'FV-1', 'COP', 2000000, 1200000, '2026-07-01') returning id`,
);

// 1. Lo que se debía al avisar.
const {
  rows: [notice],
} = await db.query(
  `insert into receivable_notices(organization_id, accounting_invoice_id, stage, sent_on, balance, currency)
   values ('a', $1, 1, '2026-09-01', 1200000, 'COP') returning id, balance, currency`,
  [inv.id],
);
ok(Number(notice.balance) === 1200000 && notice.currency === 'COP', 'el aviso guarda el saldo');
ok(
  (
    await db.query(
      `insert into receivable_notices(organization_id, accounting_invoice_id, stage, sent_on)
       values ('a', $1, 30, '2026-10-01') returning balance`,
      [inv.id],
    )
  ).rows[0].balance === null,
  'un aviso sin saldo sigue valiendo (los anteriores a la 0166)',
);
await rejects(
  `insert into receivable_notices(organization_id, accounting_invoice_id, stage, sent_on, balance) values ('a', $1, 60, '2026-10-01', -1)`,
  [inv.id],
  'un saldo negativo no entra',
);
await rejects(
  `insert into receivable_notices(organization_id, accounting_invoice_id, stage, sent_on, currency) values ('a', $1, 90, '2026-10-01', 'pesos')`,
  [inv.id],
  'la moneda son tres letras',
);

// 2. Las caídas de saldo.
const drop = (over = {}) => {
  const row = {
    before: 1200000,
    after: 500000,
    seen: '2026-09-01',
    observed: '2026-09-05',
    ...over,
  };
  return db.query(
    `insert into receivable_balance_drops(organization_id, accounting_invoice_id, notice_id, currency, balance_before, balance_after, seen_before_on, observed_on)
     values ('a', $1, $2, 'COP', $3, $4, $5, $6) returning id`,
    [inv.id, notice.id, row.before, row.after, row.seen, row.observed],
  );
};
ok((await drop()).rows.length === 1, 'una caída se anota');
await rejects(
  `insert into receivable_balance_drops(organization_id, accounting_invoice_id, currency, balance_before, balance_after, seen_before_on, observed_on) values ('a', $1, 'COP', 1200000, 500000, '2026-09-01', '2026-09-05')`,
  [inv.id],
  'una caída por factura y día',
);
await rejects(
  `insert into receivable_balance_drops(organization_id, accounting_invoice_id, currency, balance_before, balance_after, seen_before_on, observed_on) values ('a', $1, 'COP', 500000, 600000, '2026-09-05', '2026-09-06')`,
  [inv.id],
  'una «caída» que sube no es caída',
);
await rejects(
  `insert into receivable_balance_drops(organization_id, accounting_invoice_id, currency, balance_before, balance_after, seen_before_on, observed_on) values ('a', $1, 'COP', 500000, 0, '2026-09-10', '2026-09-07')`,
  [inv.id],
  'el saldo de antes se vio antes de verlo bajar',
);
ok(
  (
    await db.query(
      `insert into receivable_balance_drops(organization_id, accounting_invoice_id, currency, balance_before, balance_after, seen_before_on, observed_on) values ('b', $1, 'COP', 500000, 0, '2026-09-05', '2026-09-05') returning id`,
      [inv.id],
    )
  ).rows.length === 1,
  'el índice es por empresa',
);
await db.query('delete from receivable_notices where id = $1', [notice.id]);
ok(
  (
    await db.query('select notice_id from receivable_balance_drops where organization_id = $1', [
      'a',
    ])
  ).rows[0].notice_id === null,
  'borrar el aviso no borra la caída',
);
await db.query('delete from accounting_invoices where id = $1', [inv.id]);
ok(
  (await db.query('select count(*)::int as n from receivable_balance_drops')).rows[0].n === 0,
  'borrar la factura borra sus caídas',
);

// 3. Lo recuperado en el asunto.
const caseWith = (recovered) =>
  db.query(
    `insert into management_cases(organization_id, data) values ('a', $1::jsonb) returning id`,
    [
      JSON.stringify({
        title: 'x',
        state: 'verified',
        ...(recovered === undefined ? {} : { recovered }),
      }),
    ],
  );
ok((await caseWith(undefined)).rows.length === 1, 'un asunto sin el campo sigue valiendo');
ok((await caseWith(null)).rows.length === 1, 'null también');
ok(
  (await caseWith({ amountCop: 1500000, note: 'Multa evitada' })).rows.length === 1,
  'pesos enteros con nota',
);
for (const [bad, why] of [
  [{ amountCop: 0, note: 'x' }, 'cero no'],
  [{ amountCop: -10, note: 'x' }, 'negativo no'],
  [{ amountCop: 10.5, note: 'x' }, 'centavos no'],
  [{ amountCop: '1000', note: 'x' }, 'texto no'],
  [{ amountCop: 1000 }, 'sin nota no'],
  [{ amountCop: 1000, note: '   ' }, 'nota vacía no'],
  [{ amountCop: 1000, note: 'x'.repeat(301) }, 'nota larga no'],
  [{ note: 'x' }, 'sin valor no'],
  ['1000', 'no es un objeto'],
])
  await rejects(
    `insert into management_cases(organization_id, data) values ('a', $1::jsonb)`,
    [JSON.stringify({ title: 'x', state: 'verified', recovered: bad })],
    `lo recuperado: ${why}`,
  );

const grants = await db.query(
  `select grantee, privilege_type from information_schema.role_table_grants where table_name = 'receivable_balance_drops'`,
);
ok(
  grants.rows.every((g) => g.grantee !== 'anon' && g.grantee !== 'authenticated'),
  'ni anon ni authenticated',
);
ok(
  grants.rows.some((g) => g.grantee === 'service_role' && g.privilege_type === 'INSERT'),
  'service_role escribe',
);
ok(
  (await db.query(`select relrowsecurity from pg_class where relname = 'receivable_balance_drops'`))
    .rows[0].relrowsecurity === true,
  'RLS encendida',
);

console.log(`0166 money_recovered: ${checks} comprobaciones`);
