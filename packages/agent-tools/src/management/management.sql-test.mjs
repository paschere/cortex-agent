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
  let a = await save(owner, base);
  assert.equal(a.revision, 1);
  checks++;
  await fails(() => save(outsider, base), /perteneces/);
  await fails(() => save(other, { ...base, state: 'working' }, a), /responsable/);
  await fails(() => save(owner, { ...base, ownerId: outsider }, a), /responsable no pertenece/);
  await fails(() => save(outsider, base, a, false, 'other'), /no encontrado/);
  await fails(() => save(owner, { ...base, state: 'review' }, a), /evidencia/);
  await fails(() => save(owner, { ...base, state: 'blocked' }, a), /bloqueo/);
  const evidence = {
    reference: 'https://example.com/comprobante',
    observation: 'Pago conciliado',
    observedOn: '2020-01-01',
  };
  const reviewed = { ...base, state: 'review', evidence };
  a = await save(owner, reviewed, a);
  await fails(() => save(owner, reviewed, { ...a, revision: 1 }), /cambió/);
  await fails(
    () => save(admin, { ...reviewed, state: 'verified', reviewNote: 'Conciliado' }, a, false),
    /revisión humana/,
  );
  await fails(
    () => save(owner, { ...reviewed, state: 'verified', reviewNote: 'Conciliado' }, a, true),
    /revisión humana/,
  );
  await fails(
    () => save(admin, { ...reviewed, state: 'verified', reviewNote: '' }, a, true),
    /revisión humana/,
  );
  a = await save(
    admin,
    { ...reviewed, state: 'verified', reviewNote: 'Confirmé el ingreso en el registro' },
    a,
    true,
  );
  assert.equal(a.data.state, 'verified');
  checks++;
  await fails(() => save(admin, { ...a.data, title: 'Cambiar cierre' }, a, true), /Reabre/);
  a = await save(owner, { ...base, state: 'open' }, a);
  const b = await save(owner, { ...base, title: 'Segundo asunto', dependsOn: a.id });
  await fails(() => save(owner, { ...base, dependsOn: b.id }, a), /ciclo/);
  let c = await save(owner, { ...base, title: 'Tercer asunto', dependsOn: b.id });
  c = await save(owner, { ...c.data, state: 'review', evidence }, c);
  await fails(
    () => save(admin, { ...c.data, state: 'verified', reviewNote: 'Listo' }, c, true),
    /Primero verifica/,
  );
  await save(owner, { ...base, sourceKey: 'commitment:123' });
  await fails(() => save(owner, { ...base, sourceKey: 'commitment:123' }), /duplicate key/);
  await fails(() => db.exec('update management_cases set revision=999'), /permission denied/);
  await fails(() => db.exec('delete from management_events'), /permission denied/);
  const journal = await db.query(
    'select * from management_events where case_id=$1 order by revision',
    [a.id],
  );
  assert.deepEqual(
    journal.rows.map((r) => r.revision),
    [1, 2, 3, 4],
  );
  checks++;
  const config = {
    scope: 'Operaciones',
    priorities: 'Vencimientos',
    successMeasures: 'Cierres',
    escalationOwnerId: admin,
    reviewAfterDays: 2,
    playbooks: [],
  };
  const profile = async (actor, revision, extra = {}) =>
    db.query('select * from management_save_profile($1,$2,$3,$4::jsonb)', [
      'acme',
      actor,
      revision,
      JSON.stringify({ ...config, ...extra }),
    ]);
  await fails(() => profile(owner, 0), /administrador/);
  await fails(() => profile(admin, 0, { escalationOwnerId: outsider }), /no pertenece/);
  assert.equal((await profile(admin, 0)).rows[0].revision, 1);
  checks++;
  await fails(() => profile(admin, 0), /configuración cambió/);
  const daily = async (actor) =>
    db.query("select * from management_start_daily($1,$2,now()+interval '1 day')", ['acme', actor]);
  const first = (await daily(owner)).rows[0];
  assert.equal((await daily(owner)).rows[0].job_id, first.job_id);
  checks++;
  await fails(() => daily(outsider), /perteneces/);
  await db.exec('reset role');
  const scheduled = (await db.query('select * from scheduled_jobs')).rows;
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].notify_email, false);
  assert.equal(scheduled[0].allow_unattended_writes, false);
  checks++;
  await db.exec('set role authenticated');
  await fails(() => save(owner, base), /permission denied/);
  await fails(() => db.exec('select * from management_cases'), /permission denied/);
  await db.exec('reset role');
  await db.exec(`create table document_extractions(id uuid primary key,organization_id text,doc_type text,review_state text);
    create table actions(id uuid primary key default gen_random_uuid(),organization_id text,user_id uuid,origin_kind text,origin_id text,state text);
    insert into document_extractions values('${admin}','acme','invoice','confirmed'),('${outsider}','other','invoice','confirmed');`);
  await db.exec(
    readFileSync(
      new URL(
        '../../../../infra/supabase/migrations/0131_management_workflows.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const fresh = await save(owner, base);
  const begin = async (org = 'acme', who = owner, inv = admin, email = 'client@example.com') =>
    (
      await db.query('select * from management_workflow_start($1,$2,$3,$4,$5)', [
        org,
        who,
        fresh.id,
        inv,
        email,
      ])
    ).rows[0];
  const workflow = await begin();
  assert.equal((await begin()).id, workflow.id);
  checks++;
  await fails(() => begin('other', outsider, outsider), /no encontrado/);
  await fails(() => begin('acme', owner, outsider), /factura confirmada/);
  await fails(() => begin('acme', owner, admin, 'different@example.com'), /otros datos/);
  const claim = async (token = admin, org = 'acme') =>
    (await db.query('select * from management_workflow_claim($1,$2,$3)', [org, workflow.id, token]))
      .rows[0];
  assert.equal((await claim(admin, 'other')).id, null);
  checks++;
  assert.equal((await claim()).id, workflow.id);
  checks++;
  assert.equal((await claim(other)).id, null);
  checks++;
  const checkpoint = (token) =>
    db.query('select management_workflow_checkpoint($1,$2,$3,$4,$5::jsonb)', [
      'acme',
      workflow.id,
      token,
      100,
      '{"balance":100}',
    ]);
  await fails(() => checkpoint(other), /perdió/);
  await checkpoint(admin);
  const settle = (token, evidence) =>
    db.query('select * from management_workflow_settle($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [
      'acme',
      workflow.id,
      token,
      'approval',
      'Borrador listo',
      null,
      100,
      JSON.stringify(evidence),
    ]);
  await fails(() => settle(other, {}), /Otro proceso/);
  const revision = (await settle(admin, { balance: 100, checkedAt: 'one' })).rows[0].revision;
  await claim();
  assert.equal(
    (await settle(admin, { balance: 100, checkedAt: 'two' })).rows[0].revision,
    revision,
  );
  checks++;
  const insert = () =>
    db.query(
      "insert into actions(organization_id,user_id,origin_kind,origin_id,state) values('acme',$1,'manual',$2,'approved')",
      [owner, workflow.id],
    );
  await insert();
  await fails(insert, /ya tiene/);
  await claim();
  await fails(
    () => db.query('select management_workflow_cancel($1,$2,$3)', ['acme', other, workflow.id]),
    /Solo quien/,
  );
  await db.query('select management_workflow_cancel($1,$2,$3)', ['acme', owner, workflow.id]);
  await fails(() => checkpoint(admin), /perdió/);
  await fails(() => settle(admin, {}), /Otro proceso/);
  await fails(insert, /detenido/);
  assert.equal((await claim()).id, null);
  checks++;
  await db.exec('set role service_role');
  await fails(() => db.exec("update management_workflows set state='ready'"), /permission denied/);
  console.log(
    `${checks} PostgreSQL assertions passed: tenant isolation, roles, evidence, optimistic concurrency, dependency cycles, duplicate source, immutable journal, configuration.`,
  );
} finally {
  await db.close();
}
