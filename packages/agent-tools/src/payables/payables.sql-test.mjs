import assert from 'node:assert/strict';
// Migración 0181 (cuentas por pagar) contra PostgreSQL real (PGlite):
// proveedores, facturas con su flujo y dedupe, y el registro de lo revisado.
// PGLITE_MODULE=/ruta/a/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/payables/payables.sql-test.mjs
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const mig = (n) =>
  readFileSync(new URL(`../../../../infra/supabase/migrations/${n}`, import.meta.url), 'utf8');
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.ba_organization (id text primary key);
  create table public.users (id uuid primary key);
  create table public.document_extractions (id uuid primary key);
  insert into public.ba_organization values ('a'), ('b');
  insert into public.users values ('00000000-0000-4000-8000-000000000001');
`);
await db.exec(mig('0172_money_ledger.sql'));
await db.exec(mig('0181_payables.sql'));
// Dos veces: la migración es re-ejecutable donde dice «if not exists».
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
const U = '00000000-0000-4000-8000-000000000001';

// Proveedores ---------------------------------------------------------------
const sup =
  'insert into suppliers(organization_id,nit,name,name_key) values ($1,$2,$3,$4) returning id';
const s1 = (await db.query(sup, ['a', '900373115', 'Papelería El Cóndor', 'papeleriaelcondor']))
  .rows[0].id;
await rejects(sup, ['a', '900373115', 'Otra', 'otra'], 'un NIT, un proveedor por empresa');
await db.query(sup, ['b', '900373115', 'Papelería', 'papeleria']);
ok(true, 'otra empresa puede tener el mismo proveedor');
await db.query(sup, ['a', null, 'Sin NIT', 'sinnit']);
await db.query(sup, ['a', null, 'Sin NIT 2', 'sinnit2']);
ok(true, 'varios sin NIT');
await rejects(sup, ['a', '90-12', 'x', 'x'], 'NIT en dígitos');
await rejects(
  'update suppliers set retefuente_rate = 150 where id = $1',
  [s1],
  'una tarifa de retención va de 0 a 100',
);

// Facturas --------------------------------------------------------------------
const inv = `insert into payable_invoices(organization_id,supplier_id,source,source_ref,cufe,doc_number,dedupe_key,supplier_nit,supplier_name,currency,issue_date,due_date,total,retefuente,status)
  values ($1,$2,'correo',$3,$4,$5,$6,'900373115','Papelería El Cóndor','COP','2026-09-28','2026-10-28',$7,$8,'por_aprobar') returning id, net_amount`;
const r1 = (
  await db.query(inv, [
    'a',
    s1,
    'gmail:m1:FEPA-451',
    'cufe-0000000001',
    'FEPA-451',
    '900373115:FEPA451',
    2380000,
    50000,
  ])
).rows[0];
ok(Number(r1.net_amount) === 2330000, 'el neto es el total menos retenciones (columna generada)');
await rejects(
  inv,
  ['a', s1, 'gmail:m2:FEPA-451', 'cufe-0000000002', 'FEPA-0451', '900373115:FEPA451', 1, 0],
  'misma factura por proveedor + número',
);
await rejects(
  inv,
  ['a', s1, 'gmail:m3:X', 'cufe-0000000001', 'X-1', '900373115:X1', 1, 0],
  'mismo CUFE',
);
await rejects(
  inv,
  ['a', s1, 'gmail:m1:FEPA-451', null, 'Y-1', '900373115:Y1', 1, 0],
  'misma referencia de la fuente',
);
await db.query(inv, [
  'b',
  null,
  'gmail:m1:FEPA-451',
  'cufe-0000000001',
  'FEPA-451',
  '900373115:FEPA451',
  1,
  0,
]);
ok(true, 'otra empresa recibe la misma factura');

// El flujo exige quién y cuándo.
await rejects(
  `update payable_invoices set status='aprobada' where id=$1`,
  [r1.id],
  'aprobada exige approved_at',
);
await db.query(
  `update payable_invoices set status='aprobada', approved_at=now(), approved_by=$2 where id=$1`,
  [r1.id, U],
);
await rejects(
  `update payable_invoices set status='programada' where id=$1`,
  [r1.id],
  'programada exige el día',
);
await db.query(
  `update payable_invoices set status='programada', scheduled_pay_date='2026-10-28' where id=$1`,
  [r1.id],
);
await rejects(
  `update payable_invoices set status='pagada' where id=$1`,
  [r1.id],
  'pagada exige la fecha',
);
await db.query(
  `update payable_invoices set status='pagada', paid_at='2026-10-27', paid_evidence='{"kind":"bank"}' where id=$1`,
  [r1.id],
);
await rejects(
  `update payable_invoices set status='rechazada' where id=$1`,
  [r1.id],
  'rechazada exige cuándo',
);
await rejects(
  `update payable_invoices set status='perdida' where id=$1`,
  [r1.id],
  'estado conocido',
);
await rejects(
  `update payable_invoices set checks='{}' where id=$1`,
  [r1.id],
  'checks es una lista',
);
await rejects(
  'update payable_invoices set retefuente=-1 where id=$1',
  [r1.id],
  'retención no negativa',
);

// El libro: se enlaza y, si la fila del libro desaparece, queda sin enlace.
const mv = (
  await db.query(
    `insert into ledger_movements(organization_id,direction,kind,status,amount,currency,date,description,source_kind,source_system,source_ref)
     values ('a','out','payable','expected',2380000,'COP','2026-09-28','Factura de compra FEPA-451','document','correo · factura electrónica','payable:x') returning id`,
  )
).rows[0].id;
await db.query('update payable_invoices set ledger_movement_id=$2 where id=$1', [r1.id, mv]);
await db.query('delete from ledger_movements where id=$1', [mv]);
ok(
  (await db.query('select ledger_movement_id from payable_invoices where id=$1', [r1.id])).rows[0]
    .ledger_movement_id === null,
  'borrar la fila del libro suelta el enlace',
);

// Lo revisado al recibir.
const log =
  'insert into payable_intake_log(organization_id,channel,ref,outcome) values ($1,$2,$3,$4)';
await db.query(log, ['a', 'correo', 'gmail:m1:fe.zip', 'creada']);
await rejects(
  log,
  ['a', 'correo', 'gmail:m1:fe.zip', 'duplicada'],
  'cada adjunto se anota una vez',
);
await db.query(
  `insert into payable_intake_log(organization_id,channel,ref,outcome) values ('a','correo','gmail:m1:fe.zip','duplicada')
   on conflict (organization_id,channel,ref) do update set outcome = excluded.outcome`,
);
ok(true, 'el upsert del registro funciona con su índice único');
await rejects(log, ['a', 'fax', 'x', 'creada'], 'canal conocido');

// Borrar la empresa se lleva todo.
await db.query(`delete from ba_organization where id='b'`);
ok(
  (await db.query(`select count(*)::int c from payable_invoices where organization_id='b'`)).rows[0]
    .c === 0,
  'en cascada con la empresa',
);

// Re-ejecutar la migración no rompe (create … if not exists).
await db.exec(
  mig('0181_payables.sql').replace(/^alter table .* enable row level security;$/gm, ''),
);
ok(true, 'la migración se puede volver a correr');
console.log(`0181 payables: ${n} comprobaciones OK`);
