import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {PGlite}=await import(process.env.PGLITE_MODULE);
const db=new PGlite();let checks=0;
const owner='11111111-1111-4111-a111-111111111111',other='22222222-2222-4222-a222-222222222222',admin='33333333-3333-4333-a333-333333333333',personal='44444444-4444-4444-a444-444444444444',shared='55555555-5555-4555-a555-555555555555';
try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table ba_organization(id text primary key);insert into ba_organization values('org'),('foreign');
 create table users(id uuid primary key,organization_id text,role text);insert into users values('${owner}','org','member'),('${other}','foreign','org_admin'),('${admin}','org','org_admin');
 create table gmail_sync_state(organization_id text,user_id uuid);
 create type kb_scope as enum('user','global');
 create table kb_collections(id uuid primary key,organization_id text,scope kb_scope,scope_id uuid);
 insert into kb_collections values('${personal}','org','user','${owner}'),('${shared}','org','global',null);
 create table kb_documents(id uuid primary key default gen_random_uuid(),organization_id text,collection_id uuid,source text,title text,mime text,uploaded_by uuid,status text,sha256 text not null);
 create table kb_chunks(document_id uuid,chunk_index int,content text,tokens int,metadata jsonb);
 create function kb_space_level(uuid,uuid) returns text language sql as $$ select 'admin'::text $$;`);
 const migration=readFileSync(new URL('../../../../infra/supabase/migrations/0136_mail_knowledge_boundary.sql',import.meta.url),'utf8');
 await db.exec(migration.split('create or replace function public.kb_search_scoped')[0]);
 assert.equal((migration.match(/not d.mail_reference/g)??[]).length,2);checks++;
 await db.exec('set role service_role');
 const proposal=async(user=owner)=>(await db.query("insert into mail_learning_proposals(organization_id,user_id,thread_id,fingerprint,draft) values('org',$1,gen_random_uuid()::text,'hash',$2::jsonb) returning id",[user,JSON.stringify({title:'Requisitos de certificado',content:'Borrador privado',citations:[{quote:'CONFIDENTIAL SOURCE'}]})])).rows[0].id;
 const review=(id,user=owner,decision='approved',space=personal,org='org')=>db.query('select mail_review_learning($1,$2,$3,$4,$5,$6,$7,$8) as id',[org,user,id,decision,'Confirmado con el responsable','Se requieren dos firmas según el proceso confirmado.',space,'Requisito confirmado']);
 const fails=async(fn,pattern)=>{await assert.rejects(fn,pattern);checks++;};
 const id=await proposal();
 await fails(()=>review(id,other),/perteneces/);
 await fails(()=>review(id,admin),/no encontrada/);
 await fails(()=>review(id,owner,'approved',shared),/publicar/);
 await fails(()=>review(id,owner,'approved',personal,'foreign'),/perteneces/);
 const result=await review(id);assert.ok(result.rows[0].id);checks++;
 await fails(()=>review(id),/ya fue revisada/);
 await db.exec('reset role');
 const content=(await db.query('select content from kb_chunks')).rows[0].content;assert.ok(!content.includes('CONFIDENTIAL SOURCE'));checks++;
 const doc=(await db.query('select * from kb_documents')).rows[0];assert.equal(doc.status,'pending');assert.equal(doc.mail_reference,false);checks+=2;
 await db.exec('set role service_role');
 for(const decision of ['case_only','discarded']){const pid=await proposal();assert.equal((await review(pid,owner,decision,null)).rows[0].id,null);checks++;}
 await fails(()=>db.exec("update mail_learning_proposals set state='approved'"),/permission denied/);
 const aid=await proposal(admin);await review(aid,admin,'approved',shared);checks++;
 console.log(`PASS ${checks} mail-learning SQL checks: owner and tenant isolation, sharing authority, atomic approval, replay prevention, private evidence, non-knowledge decisions, retrieval boundary.`);
}finally{await db.close();}
