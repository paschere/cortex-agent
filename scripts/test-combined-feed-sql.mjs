import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const root = new URL('..', import.meta.url).pathname;
const db = new PGlite();
let checks = 0;
const ok = (value, message) => {
  assert.ok(value, message);
  checks += 1;
};
const rejects = async (work, message) => {
  await assert.rejects(work, /cambi|dependencia|venci|desactiv|perdi/i, message);
  checks += 1;
};

const actor = randomUUID();
const otherActor = randomUUID();
const sourceA = randomUUID();
const sourceB = randomUUID();
const combinedSource = randomUUID();
const attachmentA = randomUUID();
const attachmentB = randomUUID();
const combinedAttachment = randomUUID();
const config = {
  version: 1,
  sourceIds: [sourceA, sourceB],
  approvedHeaders: [
    { sourceId: sourceA, sheetIndex: 0, headers: ['id'] },
    { sourceId: sourceB, sheetIndex: 0, headers: ['id'] },
  ],
  mappings: [
    {
      left: { sourceId: sourceA, sheetIndex: 0, column: 0, header: 'id' },
      right: { sourceId: sourceB, sheetIndex: 0, column: 0, header: 'id' },
    },
  ],
};

await db.exec(`
create role anon;
create role authenticated;
create role service_role;
create table ba_organization(id text primary key);
create table users(id uuid primary key, organization_id text);
create table chat_attachments(
  id uuid primary key,
  organization_id text not null,
  created_by uuid not null,
  feed_kind text constraint chat_attachments_feed_kind_check check (feed_kind in ('file','url','text','api')),
  feed_source_id uuid,
  feed_content_hash text,
  feed_tables jsonb,
  feed_truncated boolean not null default false,
  purge_at timestamptz not null,
  extracted_text text,
  feed_source_dummy text
);
create table feed_sources(
  id uuid primary key,
  organization_id text not null,
  actor_id uuid not null,
  kind text constraint feed_sources_kind_check check (kind in ('file','text','url','google_sheet','api')),
  name text not null,
  config jsonb not null default '{}'::jsonb,
  latest_attachment_id uuid,
  enabled boolean not null default true,
  last_changed_at timestamptz,
  updated_at timestamptz default now()
);
create table activation_runs(
  id uuid primary key,
  organization_id text not null,
  actor_id uuid not null,
  source_id uuid not null,
  status text not null,
  candidates jsonb not null
);
create or replace function public.activation_commit_run(
  p_organization_id text,p_actor_id uuid,p_run_id uuid,p_expected_source_snapshot text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  return jsonb_build_object('ok', true, 'run', p_run_id);
end;
$$;
`);
await db.exec(await readFile(`${root}infra/supabase/migrations/0152_combined_feed_sources.sql`, 'utf8'));

await db.query(`insert into ba_organization values('a')`);
await db.query(`insert into users values($1,'a'),($2,'a')`, [actor, otherActor]);
const future = '2099-01-01T00:00:00Z';
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
await db.query(
  `insert into feed_sources(id,organization_id,actor_id,kind,name,config,latest_attachment_id,last_changed_at)
   values($1,'a',$3,'file','A','{}',$4,now()),($2,'a',$3,'file','B','{}',$5,now())`,
  [sourceA, sourceB, actor, attachmentA, attachmentB],
);
await db.query(
  `insert into feed_sources(id,organization_id,actor_id,kind,name,config,latest_attachment_id,last_changed_at)
   values($1,'a',$2,'combined','A + B',$3,$4,now())`,
  [combinedSource, actor, JSON.stringify(config), combinedAttachment],
);
await db.query(
  `insert into chat_attachments(id,organization_id,created_by,feed_kind,feed_source_id,feed_content_hash,purge_at,feed_tables)
   values($1,'a',$4,'file',$2,$5,$6,'[]'),($3,'a',$4,'file',$7,$8,$6,'[]')`,
  [attachmentA, sourceA, attachmentB, actor, hashA, future, sourceB, hashB],
);
await db.query(
  `insert into chat_attachments(id,organization_id,created_by,feed_kind,feed_source_id,feed_content_hash,purge_at,feed_tables,feed_combined_dependencies,feed_combined_provenance)
   values($1,'a',$2,'combined',$3,$4,$5,'[]',$6,$7)`,
  [
    combinedAttachment,
    actor,
    combinedSource,
    'c'.repeat(64),
    future,
    JSON.stringify([
      { sourceId: sourceA, attachmentId: attachmentA, contentHash: hashA },
      { sourceId: sourceB, attachmentId: attachmentB, contentHash: hashB },
    ]),
    JSON.stringify([
      {
        rowIndex: 1,
        status: 'matched',
        provenance: [
          {
            sourceId: sourceA,
            sourceName: 'A',
            attachmentId: attachmentA,
            sheetIndex: 0,
            sheetName: 'A rows',
            rowIndex: 1,
            quote: 'PRIVATE NOTE A ROW 1',
          },
        ],
      },
      {
        rowIndex: 2,
        status: 'matched',
        provenance: [
          {
            sourceId: sourceB,
            sourceName: 'B',
            attachmentId: attachmentB,
            sheetIndex: 0,
            sheetName: 'B rows',
            rowIndex: 2,
            quote: 'PRIVATE NOTE B ROW 2',
          },
        ],
      },
    ]),
  ],
);
await db.query(
  `insert into feed_combined_dependencies(organization_id,combined_source_id,combined_attachment_id,dependency_source_id,dependency_attachment_id,dependency_content_hash,dependency_purge_at,dependency_last_changed_at)
   values('a',$1,$2,$3,$4,$5,$6,(select last_changed_at from feed_sources where id=$3)),
         ('a',$1,$2,$7,$8,$9,$6,(select last_changed_at from feed_sources where id=$7))`,
  [combinedSource, combinedAttachment, sourceA, attachmentA, hashA, future, sourceB, attachmentB, hashB],
);

const run = randomUUID();
await db.query(
  `insert into activation_runs values($1,'a',$2,$3,'simulated',$4)`,
  [
    run,
    actor,
    combinedAttachment,
    JSON.stringify([
      { rowIndex: 1, status: 'matched', values: [] },
      { rowIndex: 2, status: 'matched', values: [] },
    ]),
  ],
);
const commit = async () => (await db.query('select activation_commit_run($1,$2,$3,$4) result', ['a', actor, run, 'd'.repeat(64)])).rows[0].result;
ok((await commit()).ok === true, 'current dependencies allow combined commit');
const committedCandidates = (await db.query('select candidates from activation_runs where id=$1', [run])).rows[0]
  .candidates;
ok(
  committedCandidates[0]?.provenance?.[0]?.sourceId === sourceA &&
    committedCandidates[0]?.provenance?.[0]?.quote === undefined &&
    committedCandidates[0]?.provenance?.[0]?.rowIndex === 1 &&
    committedCandidates[1]?.provenance?.[0]?.sourceId === sourceB &&
    committedCandidates[1]?.provenance?.[0]?.rowIndex === 2,
  'matched candidate keeps row provenance metadata without private quotes',
);

await db.query(`update feed_sources set latest_attachment_id=$2 where id=$1`, [sourceB, randomUUID()]);
await rejects(commit, 'latest pointer fences an old combined capture');
await db.query(`update feed_sources set latest_attachment_id=$2 where id=$1`, [sourceB, attachmentB]);
await db.query(`update chat_attachments set feed_content_hash=$2 where id=$1`, [attachmentB, 'd'.repeat(64)]);
await rejects(commit, 'content hash fences changed dependency');
await db.query(`update chat_attachments set feed_content_hash=$2 where id=$1`, [attachmentB, hashB]);
await db.query(`update feed_sources set enabled=false where id=$1`, [sourceB]);
await rejects(commit, 'disabled dependency fences publication');
await db.query(`update feed_sources set enabled=true where id=$1`, [sourceB]);
await db.query(`update chat_attachments set purge_at=now()-interval '1 second' where id=$1`, [attachmentB]);
await rejects(commit, 'expired dependency fences publication');
await db.query(`update chat_attachments set purge_at=$2 where id=$1`, [attachmentB, future]);
await db.query(`delete from feed_combined_dependencies where dependency_source_id=$1`, [sourceB]);
await rejects(commit, 'missing dependency row fences publication');

console.log(`combined Feed SQL checks: ${checks}`);
