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
create table chat_attachments(id uuid primary key,organization_id text,conversation_id uuid,disposition text default 'turn',filename text default 'fixture',mime text default 'text/plain',byte_size bigint default 0,sha256 text default '',created_by uuid,feed_kind text,source_url text,feed_tables jsonb,feed_truncated boolean default false,feed_content_hash text,purge_at timestamptz,extracted_text text,created_at timestamptz default now());
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
await db.exec(
  await readFile(`${root}/infra/supabase/migrations/0149_feed_prepared_views.sql`, 'utf8'),
);
await db.exec(await readFile(`${root}/infra/supabase/migrations/0150_feed_sources.sql`, 'utf8'));
await db.exec(
  await readFile(`${root}/infra/supabase/migrations/0151_activation_automations.sql`, 'utf8'),
);
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
  `insert into chat_attachments(id,organization_id,created_by,feed_kind,feed_tables,feed_content_hash,purge_at,extracted_text) values($1,'a',$2,'file',$3,'content',now()+interval '1 day','facturas')`,
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
await rejects(() => commit(first, 'a', other), /no existe/);
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
  `insert into chat_attachments(id,organization_id,created_by,feed_kind,feed_tables,feed_content_hash,purge_at,extracted_text) values($1,'a',$2,'file',$3,'generic-content',now()+interval '1 day','renovaciones originales')`,
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

const preparedTable = { name: 'Renovaciones filtradas', rows: genericTables[0].rows };
const preparedSnapshot = 'c'.repeat(64);
const preparedView = randomUUID();
await db.query(
  `insert into feed_prepared_views(id,organization_id,actor_id,source_id,name,prompt,table_data,evidence,source_snapshot,source_snapshot_data)
   values($1,'a',$2,$3,'Renovaciones filtradas','Filtra renovaciones',$4,'[]',$5,$6)`,
  [
    preparedView,
    actor,
    genericSource,
    JSON.stringify(preparedTable),
    preparedSnapshot,
    JSON.stringify({ extractedText: 'renovaciones originales' }),
  ],
);
const preparedRun = await run(
  genericRows,
  genericSource,
  genericDefinition,
  'clientes.csv',
  'Renovaciones filtradas',
);
await db.query(
  'update activation_runs set prepared_view_id=$2,source_snapshot=$3,source_snapshot_data=$4 where id=$1',
  [
    preparedRun,
    preparedView,
    preparedSnapshot,
    JSON.stringify({
      contentHash: 'generic-content',
      tables: genericTables,
      extractedText: 'renovaciones originales',
      preparedTable,
    }),
  ],
);
await db.query(`update chat_attachments set extracted_text='contenido manipulado' where id=$1`, [
  genericSource,
]);
await rejects(() => commit(preparedRun, 'a', actor, preparedSnapshot), /vista preparada/);
await db.query(`update chat_attachments set extracted_text='renovaciones originales' where id=$1`, [
  genericSource,
]);
const foreignView = randomUUID();
await db.query(
  `insert into feed_prepared_views(id,organization_id,actor_id,source_id,name,prompt,table_data,evidence,source_snapshot,source_snapshot_data)
   values($1,'a',$2,$3,'Vista ajena','Filtra',$4,'[]',$5,$6)`,
  [
    foreignView,
    other,
    genericSource,
    JSON.stringify(preparedTable),
    preparedSnapshot,
    JSON.stringify({ extractedText: 'renovaciones originales' }),
  ],
);
await db.query('update activation_runs set prepared_view_id=$2 where id=$1', [
  preparedRun,
  foreignView,
]);
await rejects(() => commit(preparedRun, 'a', actor, preparedSnapshot), /vista preparada/);

const feedSource = randomUUID();
await db.query(
  `insert into feed_sources(id,organization_id,actor_id,kind,name,config,config_hash,latest_attachment_id)
   values($1,'a',$2,'file','Clientes','{}',$3,$4)`,
  [feedSource, actor, 'd'.repeat(64), genericSource],
);
async function automation(definition = genericDefinition, sourceId = feedSource) {
  const id = randomUUID();
  await db.query(
    `insert into activation_automations(id,organization_id,actor_id,source_connection_id,approval_run_id,name,definition,approved_schema,trigger,interval_minutes,status,next_run_at)
     values($1,'a',$2,$3,$4,'Renovaciones',$5,'{}','scheduled',60,'active',now()-interval '1 minute')`,
    [id, actor, sourceId, randomUUID(), JSON.stringify(definition)],
  );
  return id;
}
const claim = async (id, org = 'a') =>
  (await db.query('select activation_automation_claim($1,$2) result', [org, id])).rows[0].result;
const recurring = await automation();
const firstClaim = await claim(recurring);
ok(Boolean(firstClaim?.lease_token), 'due authorized automation receives a lease');
ok((await claim(recurring)) === null, 'active lease prevents a duplicate claim');
ok((await claim(recurring, 'b')) === null, 'automation claim is tenant scoped');
await db.query(`update activation_automations set status='paused' where id=$1`, [recurring]);
await rejects(
  () =>
    db.query(`select activation_automation_finish('a',$1,$2,'fingerprint','{}',false,null)`, [
      recurring,
      firstClaim.lease_token,
    ]),
  /pausada|perdió/,
);

const disabledAutomation = await automation();
await db.query('update feed_sources set enabled=false where id=$1', [feedSource]);
ok((await claim(disabledAutomation)) === null, 'disabled source cannot be claimed');
ok(
  (await db.query('select status from activation_automations where id=$1', [disabledAutomation]))
    .rows[0].status === 'needs_review',
  'disabled source moves automation to needs review',
);
await db.query('update feed_sources set enabled=true where id=$1', [feedSource]);
const missingMemberAutomation = await automation();
await db.exec(`delete from ba_member where "organizationId"='a'`);
ok((await claim(missingMemberAutomation)) === null, 'removed member cannot claim automation');
ok(
  (
    await db.query('select status from activation_automations where id=$1', [
      missingMemberAutomation,
    ])
  ).rows[0].status === 'needs_review',
  'removed member moves automation to needs review',
);
await db.exec(`insert into ba_member values('member-a-final','auth-a','a','owner')`);

async function automationRun(automationId, definition = genericDefinition) {
  const id = await run(
    genericRows.map((row) => ({ ...row, sourceKey: `${row.sourceKey}:${automationId}` })),
    genericSource,
    definition,
    'clientes.csv',
    'Renovaciones',
  );
  await db.query(
    'update activation_runs set identity_namespace=$2,source_snapshot_data=$3 where id=$1',
    [
      id,
      `automation:${automationId}`,
      JSON.stringify({ contentHash: 'generic-content', tables: genericTables }),
    ],
  );
  return id;
}
const authorizedAutomation = await automation();
const authorizedClaim = await claim(authorizedAutomation);
const authorizedRun = await automationRun(authorizedAutomation);
const finished = (
  await db.query(
    `select activation_automation_finish('a',$1,$2,'stable','{"checked":true}',false,$3) result`,
    [authorizedAutomation, authorizedClaim.lease_token, authorizedRun],
  )
).rows[0].result;
ok(finished.created === 1, 'authorized recurring run publishes its matched case');
ok(
  (
    await db.query('select lease_token from activation_automations where id=$1', [
      authorizedAutomation,
    ])
  ).rows[0].lease_token === null,
  'successful finish releases the lease',
);

const changedAutomation = await automation();
const changedClaim = await claim(changedAutomation);
const changedRun = await automationRun(changedAutomation);
const newerAttachment = randomUUID();
await db.query(
  `insert into chat_attachments(id,organization_id,created_by,feed_kind,feed_tables,feed_content_hash,purge_at,extracted_text)
   values($1,'a',$2,'file',$3,'new-content',now()+interval '1 day','nueva versión')`,
  [newerAttachment, actor, JSON.stringify(genericTables)],
);
await db.query('update feed_sources set latest_attachment_id=$2 where id=$1', [
  feedSource,
  newerAttachment,
]);
await rejects(
  () =>
    db.query(`select activation_automation_finish('a',$1,$2,'changed','{}',false,$3)`, [
      changedAutomation,
      changedClaim.lease_token,
      changedRun,
    ]),
  /fuente cambió/,
);
await db.query('update feed_sources set latest_attachment_id=$2 where id=$1', [
  feedSource,
  genericSource,
]);
const definitionAutomation = await automation();
const definitionClaim = await claim(definitionAutomation);
const differentDefinition = { ...genericDefinition, name: 'Otra regla' };
const unauthorizedRun = await automationRun(definitionAutomation, differentDefinition);
await rejects(
  () =>
    db.query(`select activation_automation_finish('a',$1,$2,'definition','{}',false,$3)`, [
      definitionAutomation,
      definitionClaim.lease_token,
      unauthorizedRun,
    ]),
  /regla no coincide/,
);
console.log(`${checks} real SQL assertions passed (PGlite, synthetic schema dependencies).`);
await db.close();
