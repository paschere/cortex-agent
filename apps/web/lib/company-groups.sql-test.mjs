import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.ba_user(id text primary key);
  create table public.ba_organization(id text primary key,name text not null,kind text not null);
  create table public.ba_member(id text primary key,"organizationId" text not null references ba_organization(id),"userId" text not null references ba_user(id),role text not null);
  insert into ba_user values('founder'),('stranger');
  insert into ba_organization values('mine','Mía','company'),('foreign','Ajena','company'),('personal','Personal','personal');
  insert into ba_member values('m1','mine','founder','owner'),('m2','foreign','stranger','owner'),('m3','personal','founder','owner');
`);
const migration = await readFile(new URL('../../../infra/supabase/migrations/0140_company_groups.sql', import.meta.url), 'utf8');
await db.exec(migration);
await db.exec(`insert into company_groups(id,name,created_by_account_id) values('00000000-0000-4000-8000-000000000001','Holding','founder'); insert into company_group_admins values('00000000-0000-4000-8000-000000000001','founder',now())`);

await db.exec(`insert into company_group_companies values('00000000-0000-4000-8000-000000000001','mine','founder',now())`);
assert.equal((await db.query(`select count(*)::int n from company_group_companies`)).rows[0].n, 1);
await assert.rejects(db.exec(`insert into company_group_companies values('00000000-0000-4000-8000-000000000001','foreign','founder',now())`), /company owner required/);
await assert.rejects(db.exec(`insert into company_group_companies values('00000000-0000-4000-8000-000000000001','personal','founder',now())`), /company owner required/);

await db.exec(`insert into company_groups(id,name,created_by_account_id) values('00000000-0000-4000-8000-000000000002','Otro','founder'); insert into company_group_admins values('00000000-0000-4000-8000-000000000002','founder',now())`);
await assert.rejects(db.exec(`insert into company_group_companies values('00000000-0000-4000-8000-000000000002','mine','founder',now())`), /unique/);

await db.exec(`update ba_member set role='member' where id='m1'`);
assert.equal((await db.query(`select count(*)::int n from company_group_companies`)).rows[0].n, 0);
console.log('company groups SQL: 5 checks passed');
await db.close();
