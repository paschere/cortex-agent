import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`
  create role anon;
  create table public.ba_user (id text primary key, email text not null, name text);
  create table public.ba_organization (
    id text primary key, name text not null, slug text unique, logo text, metadata text,
    "createdAt" timestamptz not null default now()
  );
  create table public.ba_member (
    id text primary key,
    "organizationId" text not null references public.ba_organization(id) on delete cascade,
    "userId" text not null references public.ba_user(id) on delete cascade,
    role text not null default 'member', "createdAt" timestamptz not null default now()
  );
  create unique index ba_member_org_user_uidx on public.ba_member ("organizationId", "userId");
  create table public.ba_invitation (
    id text primary key,
    "organizationId" text not null references public.ba_organization(id) on delete cascade,
    email text not null, role text, status text not null default 'pending',
    "expiresAt" timestamptz not null, "inviterId" text not null references public.ba_user(id)
  );
  insert into public.ba_user values ('founder', 'founder@example.com', 'Fundadora'), ('worker', 'worker@example.com', 'Trabajador');
  insert into public.ba_organization (id,name,slug) values ('existing-company','Empresa existente','empresa-existente');
  insert into public.ba_member values ('old-owner','existing-company','founder','owner',now()), ('old-worker','existing-company','worker','member',now());
`);

const migration = await readFile(
  new URL('../../../infra/supabase/migrations/0137_personal_workspaces.sql', import.meta.url),
  'utf8',
);
await db.exec(migration);

const personal = await db.query(
  `select id, personal_owner_user_id from ba_organization where kind='personal' order by personal_owner_user_id`,
);
assert.equal(personal.rows.length, 2);
assert.deepEqual(
  personal.rows.map((r) => r.personal_owner_user_id),
  ['founder', 'worker'],
);
assert.equal(
  (await db.query(`select kind from ba_organization where id='existing-company'`)).rows[0].kind,
  'company',
);
assert.equal(
  (
    await db.query(
      `select count(*)::int as n from ba_member m join ba_organization o on o.id=m."organizationId" where o.kind='personal' and m.role='owner'`,
    )
  ).rows[0].n,
  2,
);

const personalId = personal.rows[0].id;
await assert.rejects(
  db.exec(`insert into ba_member values ('intruder','${personalId}','worker','member',now())`),
  /belongs exclusively/,
);
await assert.rejects(
  db.exec(
    `insert into ba_invitation values ('invite','${personalId}','other@example.com','member','pending',now()+interval '1 day','founder')`,
  ),
  /cannot invite/,
);
await assert.rejects(
  db.exec(`update ba_organization set personal_owner_user_id='worker' where id='${personalId}'`),
  /cannot be transferred/,
);
await assert.rejects(
  db.exec(
    `update ba_organization set kind='personal', personal_owner_user_id='founder' where id='existing-company'`,
  ),
  /kind cannot be changed/,
);
await assert.rejects(
  db.exec(`delete from ba_member where "organizationId"='${personalId}'`),
  /cannot be removed/,
);
await assert.rejects(
  db.exec(
    `update ba_member set "organizationId"='existing-company' where "organizationId"='${personalId}'`,
  ),
  /cannot be transferred/,
);
await assert.rejects(
  db.exec(`delete from ba_organization where id='${personalId}'`),
  /cannot be deleted/,
);

// Re-applying is safe and creates no duplicates.
await db.exec(migration);
assert.equal(
  (await db.query(`select count(*)::int as n from ba_organization where kind='personal'`)).rows[0]
    .n,
  2,
);

// Runtime provisioning uses a data-modifying CTE. Its membership trigger must
// see the organization inserted by the earlier CTE and enforce its owner.
await db.exec(
  `insert into ba_user values ('fresh', 'fresh@example.com', 'Fresh'), ('owner2', 'owner2@example.com', 'Owner 2')`,
);
await db.exec(`
  with new_org as (
    insert into ba_organization (id,name,slug,kind,personal_owner_user_id,"createdAt")
    values ('personal:fresh','Fresh','personal-fresh','personal','fresh',now())
    returning id
  ), new_member as (
    insert into ba_member (id,"organizationId","userId",role,"createdAt")
    select 'personal-member:fresh',id,'fresh','owner',now() from new_org
    returning id
  )
  select * from new_member
`);
assert.equal(
  (
    await db.query(
      `select count(*)::int as n from ba_member where "organizationId"='personal:fresh'`,
    )
  ).rows[0].n,
  1,
);
await assert.rejects(
  db.exec(`
    with new_org as (
      insert into ba_organization (id,name,slug,kind,personal_owner_user_id,"createdAt")
      values ('personal:wrong','Wrong','personal-wrong','personal','owner2',now())
      returning id
    )
    insert into ba_member (id,"organizationId","userId",role,"createdAt")
    select 'personal-member:wrong',id,'worker','owner',now() from new_org
  `),
  /belongs exclusively/,
);

// Account deletion remains possible; its FK cascade may remove the personal
// tenant even though deleting that tenant directly is forbidden.
await db.exec(`delete from ba_user where id='founder'`);
assert.equal(
  (await db.query(`select count(*)::int as n from ba_organization where kind='personal'`)).rows[0]
    .n,
  2,
);

console.log('personal workspace SQL: 15 checks passed');
await db.close();
