import assert from 'node:assert/strict';
// Real PostgreSQL (PGlite) integration test, isolated from any customer database.
// PGLITE_MODULE=/tmp/cortex-management-db/node_modules/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/management/management.sql-test.mjs
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
let checks = 0;
const fails = async (fn, pattern) => {
  await assert.rejects(fn, pattern);
  checks++;
};
const admin = '11111111-1111-4111-a111-111111111111';
const owner = '22222222-2222-4222-a222-222222222222';
const other = '33333333-3333-4333-a333-333333333333';
const outsider = '44444444-4444-4444-a444-444444444444';
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table ba_organization(id text primary key);
    create table users(id uuid primary key,organization_id text,role text);
    create table agents(id uuid default gen_random_uuid(), organization_id text, slug text, allowed_tool_ids text[],archived boolean default false);
    create table scheduled_jobs(id uuid default gen_random_uuid(),organization_id text,user_id uuid,agent_id uuid,name text,kind text,tool_id text,tool_input jsonb,schedule_kind text,cron text,timezone text,next_run_at timestamptz,allow_unattended_writes boolean,notify_conversation boolean,notify_email boolean,status text default 'active',created_at timestamptz default now());
    insert into agents(organization_id,slug,allowed_tool_ids) values('acme','cortex',array['kb.*']);
    insert into ba_organization values('acme'),('other');
    insert into users values('${admin}','acme','org_admin'),('${owner}','acme','member'),('${other}','acme','member'),('${outsider}','other','org_admin');`);
  await db.exec(
    readFileSync(
      new URL('../../../../infra/supabase/migrations/0130_management.sql', import.meta.url),
      'utf8',
    ),
  );
  await db.exec('create table goals(id uuid primary key, organization_id text, state text)');
  await db.exec(readFileSync(new URL('../../../../infra/supabase/migrations/0135_management_operations.sql',import.meta.url),'utf8'));
  await db.exec('set role service_role');
  const base = {
    title: 'Verificar recaudo',
    objective: 'Confirmar el ingreso',
    successCriteria: 'Comprobante conciliado',
    ownerId: owner,
    dueOn: '2026-09-05',
    nextReviewOn: '2026-09-05',
    impact: 'high',
    nextAction: 'Consultar registro',
    blocker: '',
    state: 'open',
    sourceKey: null,
    sourceUrl: null,
    dependsOn: null,
    evidence: null,
    reviewNote: '',
  };
  const save = async (actor, data, item = null, human = false, org = 'acme') =>
    (
      await db.query('select * from management_save_case($1,$2,$3,$4,$5::jsonb,$6)', [
        org,
        actor,
        item?.id ?? null,
        item?.revision ?? 0,
        JSON.stringify(data),
        human,
      ])
    ).rows[0];
  const today=(await db.query("select (now() at time zone 'America/Bogota')::date::text as day")).rows[0].day;
  let a=await save(owner,{...base,dueOn:today,nextReviewOn:today});
  const command=async(actor,cmd,op=null,org='acme')=>(await db.query('select * from management_operate($1,$2,$3,$4,$5::jsonb)',[org,actor,op?.id??null,op?.revision??0,JSON.stringify(cmd)])).rows[0];
  const plan={name:'Reducir pendientes',outcome:'Resolver pedidos pendientes',baseline:'Diez pedidos por verificar',target:'Cero pedidos sin verificar',measurement:'Conteo diario de pendientes',source:'Hoja de pedidos con responsable',boundaries:'Cada envío requiere aprobación',ownerId:owner,startOn:today,goalId:null,caseIds:[a.id],notifyInApp:false};
  await fails(()=>command(owner,{kind:'create',plan}),/administrador/);
  await fails(()=>command(outsider,{kind:'create',plan}),/perteneces/);
  await fails(()=>command(admin,{kind:'create',plan:{...plan,ownerId:outsider}}),/responsable/);
  await fails(()=>command(admin,{kind:'create',plan:{...plan,caseIds:[outsider]}}),/asunto/);
  let op=await command(admin,{kind:'create',plan});
  await fails(()=>command(admin,{kind:'create',plan}),/ciclo abierto/);
  await fails(()=>command(owner,{kind:'progress',caseId:a.id,caseRevision:1,status:'accepted',note:'Acepto revisar los pedidos',nextReviewOn:today},{...op,revision:0}),/cambió/);
  await fails(()=>command(other,{kind:'progress',caseId:a.id,caseRevision:1,status:'accepted',note:'Acepto revisar los pedidos',nextReviewOn:today},op),/responsable/);
  await fails(()=>command(outsider,{kind:'pause',note:'Pausar temporalmente'},op,'other'),/no encontrada/);
  op=await command(owner,{kind:'progress',caseId:a.id,caseRevision:1,status:'accepted',note:'Acepto revisar los pedidos',nextReviewOn:today},op);
  a=(await db.query('select * from management_cases where id=$1',[a.id])).rows[0];assert.equal(a.data.state,'working');assert.equal(a.revision,2);checks+=2;
  const decision={question:'Cómo resolvemos los pedidos pendientes',options:[{label:'Equipo actual',consequence:'Reasignar personas esta semana'},{label:'Otro proveedor',consequence:'Pedir cotización y confirmar el costo'}],evidence:'https://example.com/pedidos',uncertainty:'Confirmar capacidad del proveedor',dueOn:today};
  op=await command(owner,{kind:'decision',decision},op);
  const de=(await db.query("select id from management_operation_events where operation_id=$1 and kind='decision'",[op.id])).rows[0];
  await fails(()=>command(owner,{kind:'resolve',decisionId:de.id,option:0,note:'El equipo tiene disponibilidad'},op),/administrador/);
  await fails(()=>command(admin,{kind:'resolve',decisionId:outsider,option:0,note:'El equipo tiene disponibilidad'},op),/no pertenece/);
  op=await command(admin,{kind:'resolve',decisionId:de.id,option:0,note:'El equipo tiene disponibilidad'},op);
  await fails(()=>command(admin,{kind:'resolve',decisionId:de.id,option:1,note:'Cambiar de alternativa ahora'},op),/veredicto/);
  const checkpoint={day:7,measurement:'Quedan cinco pedidos pendientes',observation:'Se resolvieron cinco pedidos',evidence:'https://example.com/revision',nextAction:'Consultar los cinco restantes',lesson:'Revisar los pendientes cada día'};
  await fails(()=>command(admin,{kind:'checkpoint',checkpoint},op),/todavía/);
  await fails(()=>command(admin,{kind:'complete',note:'Consideramos que terminó el ciclo'},op),/cuatro revisiones/);
  op=await command(admin,{kind:'pause',note:'Pausa para revisar las fuentes'},op);
  await fails(()=>command(owner,{kind:'decision',decision},op),/Reanuda/);
  op=await command(admin,{kind:'resume',note:'Fuentes disponibles nuevamente'},op);
  // Simulate elapsed time only in the isolated database as its owner.
  await db.exec('reset role');await db.query("update management_operations set data=jsonb_set(data,'{startOn}',to_jsonb(((now() at time zone 'America/Bogota')::date-29)::text)) where id=$1",[op.id]);await db.exec('set role service_role');
  for(const day of [7,14,21,30])op=await command(admin,{kind:'checkpoint',checkpoint:{...checkpoint,day}},op);
  await fails(()=>command(admin,{kind:'checkpoint',checkpoint},op),/ya fue revisado/);
  await fails(()=>command(admin,{kind:'complete',note:'El ciclo ya tiene todas las revisiones'},op),/sin cierre verificado/);
  const proof={reference:'https://example.com/prueba',observation:'Pedidos entregados y revisados',observedOn:today};
  a=await save(owner,{...a.data,state:'review',evidence:proof},a);
  a=await save(admin,{...a.data,state:'verified',reviewNote:'Verifiqué cada entrega'},a,true);
  op=await command(admin,{kind:'complete',note:'Todos los pedidos fueron verificados'},op);assert.equal(op.state,'completed');checks++;
  await fails(()=>command(admin,{kind:'pause',note:'Intentar cambiar el cierre'},op),/ya terminó/);
  await fails(()=>db.query("update management_operations set state='active' where id=$1",[op.id]),/permission denied/);
  await fails(()=>db.query('delete from management_operation_events where operation_id=$1',[op.id]),/permission denied/);
  a=await save(admin,{...base,dueOn:today,nextReviewOn:today});
  let second=await command(admin,{kind:'create',plan:{...plan,caseIds:[a.id]}});
  second=await command(admin,{kind:'cancel',note:'Cambió el objetivo de la empresa'},second);assert.equal(second.state,'cancelled');checks++;
  console.log(`PASS ${checks} operation SQL checks: tenancy, ownership, atomic case progress, decisions, dates, verified closure, immutable history, cancellation.`);
}finally{await db.close();}
