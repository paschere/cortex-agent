import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table ba_user(id text primary key);
  create table ba_organization(id text primary key);
  create table ba_member(id text primary key, "organizationId" text not null, "userId" text not null, role text not null);
  create table global_conversations(id uuid primary key default gen_random_uuid(), account_id text not null references ba_user(id), workspace_ids text[] not null);
  insert into ba_user values ('alice'),('bob');
  insert into ba_organization values ('a'),('b');
  insert into ba_member values ('alice-a','a','alice','owner'),('alice-b','b','alice','owner'),('bob-a','a','bob','member');
  insert into global_conversations(account_id,workspace_ids) values ('alice',array['a','b']),('bob',array['a']);
`);
const migration = await readFile(new URL('../../../../infra/supabase/migrations/0142_global_chat_attachments.sql', import.meta.url),'utf8');
await db.exec(migration);
const conversation = (await db.query(`select id from global_conversations where account_id='alice'`)).rows[0].id;
const insert = (name='a.txt') => db.query(`insert into global_chat_attachments(account_id,conversation_id,source_workspace_ids,filename,mime,byte_size,sha256,extracted_text)
 values('alice',$1,array['a','b'],$2,'text/plain',10,$3,'contenido')`,[conversation,name,'a'.repeat(64)]);
await insert(); await insert('b.txt');
assert.equal((await db.query(`select count(*)::int n from global_chat_attachments`)).rows[0].n,2);
await assert.rejects(()=>insert('c.txt'),/límite de 2/);
await assert.rejects(()=>db.query(`insert into global_chat_attachments(account_id,conversation_id,source_workspace_ids,filename,mime,byte_size,sha256,extracted_text)
 values('bob',$1,array['a'],'x.txt','text/plain',10,$2,'contenido')`,[conversation,'b'.repeat(64)]),/scope/i);
await db.exec(`delete from ba_member where id='alice-b'`);
await db.exec(`delete from global_chat_attachments`);
await assert.rejects(()=>db.query(`insert into global_chat_attachments(account_id,conversation_id,source_workspace_ids,filename,mime,byte_size,sha256,extracted_text)
 values('alice','${conversation}',array['a','b'],'x.txt','text/plain',10,'${'c'.repeat(64)}','contenido')`),/scope/i);
await db.exec(`set role authenticated`);
await assert.rejects(()=>db.query(`select * from global_chat_attachments`),/permission denied/i);
console.log('global attachment SQL checks passed (scope, cap, revocation, RLS)');
