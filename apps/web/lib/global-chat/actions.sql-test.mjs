import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`
 create role anon; create role authenticated; create role service_role;
 create table ba_user(id text primary key);
 create table ba_organization(id text primary key);
 create table ba_member(id text primary key,"organizationId" text,"userId" text,role text);
 create table global_conversations(id uuid primary key default gen_random_uuid(),account_id text references ba_user(id),workspace_ids text[] not null);
 insert into ba_user values('owner'),('worker'); insert into ba_organization values('a'),('b');
 insert into ba_member values('oa','a','owner','owner'),('ob','b','owner','owner'),('wa','a','worker','member');
 insert into global_conversations(account_id,workspace_ids) values('owner',array['a','b']) returning id;
`);
await db.exec(
  await readFile(
    new URL(
      '../../../../infra/supabase/migrations/0141_global_action_proposals.sql',
      import.meta.url,
    ),
    'utf8',
  ),
);
const conversation = (
  await db.query(`select id from global_conversations where account_id='owner'`)
).rows[0].id;
const insert = () =>
  db.query(
    `insert into global_action_proposals(account_id,conversation_id,workspace_id,workspace_name,source_workspace_ids,tool_id,input) values('owner',$1,'a','Empresa A',array['a','b'],'gmail.send_message','{"to":"x"}') returning id`,
    [conversation],
  );
const id = (await insert()).rows[0].id;
await assert.rejects(
  db.exec(`update global_action_proposals set input='{}' where id='${id}'`),
  /immutable/,
);
assert.equal(
  (
    await db.query(
      `update global_action_proposals set state='executing' where id=$1 and state='pending' returning id`,
      [id],
    )
  ).rows.length,
  1,
);
assert.equal(
  (
    await db.query(
      `update global_action_proposals set state='executing' where id=$1 and state='pending' returning id`,
      [id],
    )
  ).rows.length,
  0,
);
await db.exec(
  `update global_action_proposals set state='succeeded',result='{"ok":true}' where id='${id}'`,
);
await assert.rejects(
  db.exec(`update global_action_proposals set state='pending' where id='${id}'`),
  /state transition/,
);
await assert.rejects(
  db.exec(
    `insert into global_action_proposals(account_id,conversation_id,workspace_id,workspace_name,source_workspace_ids,tool_id,input) values('worker','${conversation}','a','A',array['a'],'x.y','{}')`,
  ),
  /scope must match/,
);
for (let i = 1; i < 30; i++) await insert();
await assert.rejects(insert(), /límite de 30/);
console.log('global action proposal SQL: 7 checks passed');
await db.close();
