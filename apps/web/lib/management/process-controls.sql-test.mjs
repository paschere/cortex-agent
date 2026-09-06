import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const a='11111111-1111-4111-a111-111111111111',b='22222222-2222-4222-a222-222222222222',c='33333333-3333-4333-a333-333333333333';
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create table ba_organization(id text primary key);insert into ba_organization values('a'),('b');create table users(id uuid primary key,organization_id text);insert into users values('${a}','a');create table scheduled_jobs(id uuid primary key,organization_id text);insert into scheduled_jobs values('${a}','a'),('${b}','b');create table mandates(id uuid primary key default gen_random_uuid(),organization_id text,revoked_at timestamptz);create table kb_documents(id uuid primary key,organization_id text);insert into kb_documents values('${a}','a'),('${b}','a'),('${c}','b');`);
 for(const name of ['0133_routine_mandates.sql','0134_knowledge_reviews.sql']) await db.exec(readFileSync(new URL(`../../../../infra/supabase/migrations/${name}`,import.meta.url),'utf8'));
 await assert.rejects(()=>db.query("insert into mandates(organization_id,routine_id) values('a',$1)",[b]),/no pertenece/);
 const grant=(await db.query("insert into mandates(organization_id,routine_id) values('a',$1) returning id",[a])).rows[0];
 assert.equal((await db.query('select mandate_only from scheduled_jobs where id=$1',[a])).rows[0].mandate_only,true);
 await db.query('update mandates set revoked_at=now() where id=$1',[grant.id]);
 assert.equal((await db.query('select mandate_only from scheduled_jobs where id=$1',[a])).rows[0].mandate_only,true);
 await assert.rejects(()=>db.query('update mandates set routine_id=null where id=$1',[grant.id]),/no se puede cambiar/);
 const insert=(right)=>db.query("insert into knowledge_reviews(organization_id,user_id,left_document,right_document,finding) values('a',$1,$1,$2,'{}') returning id",[a,right]);
 await assert.rejects(()=>insert(c),/Fuentes fuera/);
 const review=(await insert(b)).rows[0];
 await assert.rejects(()=>db.query("update knowledge_reviews set resolution='left',resolved_at=now() where id=$1",[review.id]),/check constraint/);
 await db.query("update knowledge_reviews set resolution='context',note='Falta contexto para decidir',resolved_at=now() where id=$1",[review.id]);
 await assert.rejects(()=>db.query("update knowledge_reviews set note='Cambiar la revisión' where id=$1",[review.id]),/no se pueden sobrescribir/);
 console.log('PASS: routine scope, irreversible return to approval after revocation, cross-company isolation, required review note and immutable resolved evidence.');
}finally{await db.close();}
