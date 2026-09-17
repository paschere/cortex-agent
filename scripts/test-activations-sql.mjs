import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const root = new URL('..', import.meta.url).pathname;
const db = new PGlite();
let checks = 0;
const ok = (v, msg) => {
  assert.ok(v, msg);
  checks++;
};
await db.exec(`create role anon;create role authenticated;create role service_role;
create table ba_organization(id text primary key);
create table ba_user(id text primary key,email text);
create table ba_member(id text primary key,"userId" text,"organizationId" text,role text);
create table users(id uuid primary key,organization_id text,email text,role text);
create table chat_attachments(id uuid primary key,organization_id text,created_by uuid,feed_kind text,feed_tables jsonb,feed_content_hash text,purge_at timestamptz);
insert into ba_organization values('a'),('b');
insert into ba_user values('auth-a','a@test.invalid'),('auth-b','b@test.invalid');
insert into ba_member values('member-a','auth-a','a','owner'),('member-b','auth-b','b','owner');`);
const actor = randomUUID();
const other = randomUUID();
await db.query(
  `insert into users values($1,'a','a@test.invalid','org_admin'),($2,'b','b@test.invalid','org_admin')`,
  [actor, other],
);
const management = await readFile(`${root}/infra/supabase/migrations/0130_management.sql`, 'utf8');
await db.exec(management.split('create function public.management_save_profile')[0]);
await db.exec(await readFile(`${root}/infra/supabase/migrations/0148_activation_runs.sql`, 'utf8'));
const snapshot = 'a'.repeat(64);
const source = randomUUID();
const tables = [
  {
    name: 'Facturas',
    rows: [
      ['invoice', 'issuer', 'amount', 'currency', 'date'],
      ['001', 'Acme', '100', 'COP', '2026-09-01'],
      ['001', 'Acme', '200', 'COP', '2026-09-02'],
    ],
  },
];
await db.query(
  `insert into chat_attachments values($1,'a',$2,'file',$3,'content',now()+interval '1 day')`,
  [source, actor, JSON.stringify(tables)],
);
const mapping = { invoiceNumber: 0, issuer: 1, amount: 2, currency: 3, issuedOn: 4 };
const invoiceDefinition = {
  version: 1,
  name: 'Duplicados de facturas',
  kind: 'invoice_duplicates',
  mapping,
};
const candidate = {
  invoiceNumber: '001',
  issuer: 'Acme',
  amount: '100',
  currency: 'COP',
  issuedOn: '2026-09-01',
  sourceKey: 'activation:invoice:fixture:001',
  status: 'matched',
  values: [
    { column: 0, header: 'invoice', value: '001' },
    { column: 1, header: 'issuer', value: 'Acme' },
    { column: 2, header: 'amount', value: '100' },
    { column: 3, header: 'currency', value: 'COP' },
    { column: 4, header: 'date', value: '2026-09-01' },
  ],
  reasons: ['Mismo emisor, número y moneda'],
  groupKey: 'acme:001:cop',
};
const candidates = [
  { ...candidate, rowIndex: 1 },
  {
    ...candidate,
    rowIndex: 2,
    amount: '200',
    issuedOn: '2026-09-02',
    values: candidate.values.map((v) =>
      v.header === 'amount'
        ? { ...v, value: '200' }
        : v.header === 'date'
          ? { ...v, value: '2026-09-02' }
          : v,
    ),
  },
  { ...candidate, rowIndex: 3, sourceKey: 'unique', status: 'unmatched', groupKey: null },
  { ...candidate, rowIndex: 4, sourceKey: 'invalid', status: 'invalid' },
];
async function run(
  rows = candidates,
  src = source,
  definition = invoiceDefinition,
  sourceName = 'facturas.csv',
  sheetName = 'Facturas',
) {
  const id = randomUUID();
  await db.query(
    `insert into activation_runs(id,organization_id,actor_id,source_id,source_name,source_snapshot,source_snapshot_data,sheet_index,sheet_name,definition,mapping,mapping_snapshot,candidates) values($1,'a',$2,$3,$4,$5,$6,0,$7,$8,$9,$5,$10)`,
    [
      id,
      actor,
      src,
      sourceName,
      snapshot,
      JSON.stringify({ contentHash: 'content', tables }),
      sheetName,
      JSON.stringify(definition),
      definition.kind === 'invoice_duplicates' ? JSON.stringify(mapping) : null,
      JSON.stringify(rows),
    ],
  );
  return id;
}
const commit = async (id, org = 'a', who = actor, hash = snapshot) =>
  (await db.query('select activation_commit_run($1,$2,$3,$4) result', [org, who, id, hash])).rows[0]
    .result;
async function rejects(fn, regex) {
  await assert.rejects(fn, regex);
  checks++;
}
const first = await run();
const result = await commit(first);
ok(result.created === 1 && result.caseIds.length === 1, 'one case per duplicate group');
const record = (await db.query('select * from management_cases')).rows[0];
ok(record.data.activationEvidence.rows.length === 2, 'all duplicate evidence retained');
ok(record.data.state === 'open', 'never verified');
ok(record.data.dueOn !== '2026-09-01', 'review date not invoice date');
ok(
  (await db.query('select * from management_events')).rows.length === 1,
  'immutable event recorded',
);
const retry = await commit(first);
ok(retry.created === 0 && retry.reused === 1, 'retry idempotent');
const reupload = await run();
const repeat = await commit(reupload);
ok(repeat.created === 0 && repeat.reused === 1, 'same identity reused between runs');
await rejects(() => commit(first, 'b', other), /no existe/);
await rejects(() => commit(first, 'a', other), /perteneces/);
const empty = await run(candidates.filter((r) => r.status !== 'matched'));
await rejects(() => commit(empty), /No hay/);
const pending = await run();
await rejects(() => commit(pending, 'a', actor, 'b'.repeat(64)), /cambió/);
await db.query(`update chat_attachments set purge_at=now()-interval '1 second' where id=$1`, [
  source,
]);
await rejects(() => commit(pending), /venció/);
await db.query(
  `update chat_attachments set purge_at=now()+interval '1 day',feed_tables='[]' where id=$1`,
  [source],
);
await rejects(() => commit(pending), /cambiaron/);
await db.query(
  `update chat_attachments set feed_tables=$2,feed_content_hash='changed' where id=$1`,
  [source, JSON.stringify(tables)],
);
await rejects(() => commit(pending), /cambiaron/);
await db.query(
  `update chat_attachments set feed_content_hash='content',created_by=$2 where id=$1`,
  [source, other],
);
await rejects(() => commit(pending), /disponible/);
await db.query('update chat_attachments set created_by=$2 where id=$1', [source, actor]);
await db.exec(`delete from ba_member where id='member-a'`);
await rejects(() => commit(first), /perteneces/);
await rejects(() => commit(pending), /perteneces/);
ok(
  (await db.query('select * from management_cases')).rows.length === 1,
  'failed operations created no cases',
);
await db.query('delete from chat_attachments where id=$1', [source]);
ok(
  (await db.query('select * from activation_runs')).rows.length === 0,
  'private snapshot cascades with source deletion',
);
ok(
  (await db.query('select * from management_cases')).rows.length === 1,
  'explicitly shared evidence survives source deletion',
);
await db.exec(`insert into ba_member values('member-a-restored','auth-a','a','owner')`);

// A non-financial condition shares only the selected/displayed cells, and one
// matched row becomes exactly one management case. Unmatched and invalid rows
// remain simulation evidence but never become work.
const genericSource = randomUUID();
const genericTables = [
  {
    name: 'Renovaciones',
    rows: [
      ['Cliente', 'Renueva', 'Nota privada'],
      ['Norte', '2026-01-01', 'no compartir'],
      ['Sur', '2099-01-01', 'no compartir'],
      ['', '', 'no compartir'],
    ],
  },
];
await db.query(
  `insert into chat_attachments values($1,'a',$2,'file',$3,'generic-content',now()+interval '1 day')`,
  [genericSource, actor, JSON.stringify(genericTables)],
);
const genericDefinition = {
  version: 1,
  name: 'Renovaciones vencidas',
  kind: 'table_rule',
  rule: 'conditions',
  conditions: [{ column: 1, operator: 'before_today' }],
  match: 'all',
  groupBy: [],
  caseTitle: 'Renovar {{Cliente}}',
  caseObjective: 'Confirmar renovación de {{Cliente}}',
  caseNextAction: 'Contactar a {{Cliente}}',
};
const genericRows = [
  {
    rowIndex: 1,
    sourceKey: 'activation:renewal:norte',
    status: 'matched',
    values: [
      { column: 0, header: 'Cliente', value: 'Norte' },
      { column: 1, header: 'Renueva', value: '2026-01-01' },
    ],
    reasons: ['Renueva es anterior a hoy'],
    groupKey: null,
  },
  {
    rowIndex: 2,
    sourceKey: 'activation:renewal:sur',
    status: 'unmatched',
    values: [
      { column: 0, header: 'Cliente', value: 'Sur' },
      { column: 1, header: 'Renueva', value: '2099-01-01' },
    ],
    reasons: [],
    groupKey: null,
  },
  {
    rowIndex: 3,
    sourceKey: 'activation:renewal:invalid',
    status: 'invalid',
    values: [{ column: 0, header: 'Cliente', value: '' }],
    reasons: ['Falta Renueva'],
    groupKey: null,
  },
];
const genericRun = await run(
  genericRows,
  genericSource,
  genericDefinition,
  'clientes.csv',
  'Renovaciones',
);
await db.query('update activation_runs set source_snapshot_data=$2 where id=$1', [
  genericRun,
  JSON.stringify({ contentHash: 'generic-content', tables: genericTables }),
]);
const genericResult = await commit(genericRun);
ok(genericResult.created === 1, 'conditions create one case for each matched row');
const genericCase = (
  await db.query(
    `select data from management_cases where data->>'sourceKey'='activation:renewal:norte'`,
  )
).rows[0].data;
ok(genericCase.title === 'Renovar Norte · fila 2', 'configured title template retained');
ok(
  genericCase.objective.startsWith('Confirmar renovación de Norte'),
  'configured objective retained',
);
ok(genericCase.nextAction === 'Contactar a Norte', 'configured next action retained');
ok(
  genericCase.activationEvidence.definition.kind === 'table_rule',
  'definition retained in evidence',
);
ok(genericCase.activationEvidence.rows.length === 1, 'only matched row shared in its case');
ok(
  genericCase.activationEvidence.rows[0].values.every((v) => v.header !== 'Nota privada'),
  'unselected source columns are not shared',
);
await db.query(
  `update management_cases set data=jsonb_set(data,'{activationEvidence}','{"spoof":true}'::jsonb) where data->>'sourceKey'='activation:renewal:norte'`,
);
const preservedEvidence = (
  await db.query(
    `select data->'activationEvidence' evidence from management_cases where data->>'sourceKey'='activation:renewal:norte'`,
  )
).rows[0].evidence;
ok(
  JSON.stringify(preservedEvidence) === JSON.stringify(genericCase.activationEvidence),
  'database trigger preserves server activation evidence on updates',
);

const duplicateDefinition = {
  ...genericDefinition,
  name: 'Clientes repetidos',
  rule: 'duplicates',
  conditions: [],
  groupBy: [0],
  caseTitle: 'Resolver repetición de {{Cliente}}',
};
const duplicateRows = [5, 7].map((rowIndex) => ({
  rowIndex,
  sourceKey: 'activation:customer:norte',
  status: 'matched',
  values: [{ column: 0, header: 'Cliente', value: 'Norte' }],
  reasons: ['Cliente aparece más de una vez'],
  groupKey: 'norte',
}));
const duplicateRun = await run(
  duplicateRows,
  genericSource,
  duplicateDefinition,
  'clientes.csv',
  'Renovaciones',
);
await db.query('update activation_runs set source_snapshot_data=$2 where id=$1', [
  duplicateRun,
  JSON.stringify({ contentHash: 'generic-content', tables: genericTables }),
]);
const duplicateResult = await commit(duplicateRun);
ok(
  duplicateResult.created === 1 && duplicateResult.caseIds.length === 1,
  'generic duplicate group creates one case',
);
const duplicateCase = (
  await db.query(
    `select data from management_cases where data->>'sourceKey'='activation:customer:norte'`,
  )
).rows[0].data;
ok(
  duplicateCase.activationEvidence.rows.length === 2,
  'generic duplicate keeps the complete group',
);
console.log(`${checks} real SQL assertions passed (PGlite, synthetic schema dependencies).`);
await db.close();
