-- The chat stops being a place things scroll past.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS ADDS, AND WHY IT IS TWO TABLES AND NOT ONE
-- ---------------------------------------------------------------------------
-- Two things a conversation can now produce that outlive the message they were
-- produced in: a chart somebody may want to keep, and a file somebody dropped
-- in. They look adjacent and they are not the same shape at all.
--
-- A CHART is an assertion about data. Its whole value is that it does not move,
-- so what is stored is the resolved document -- every figure computed, every
-- source stamped with the instant it was read -- exactly as public.reports
-- stores one. Keeping it is then a copy from this table into that one, with no
-- query in between. See packages/agent-tools/src/reports/chat-chart.ts.
--
-- An ATTACHMENT is a decision about privacy. Its whole value is that somebody
-- chose, at the moment of dropping the file, whether it joins the company's
-- memory or is only read for this turn. What is stored is that decision and
-- enough to act on it.
--
-- Folding them into one "chat artifacts" table would mean a row where half the
-- columns are always null and a `kind` column deciding which half, which is how
-- two features start constraining each other.
--
-- ---------------------------------------------------------------------------
-- BOTH TABLES EXPIRE, AND THE REASON IS THE SAME
-- ---------------------------------------------------------------------------
-- Most charts a model draws are glanced at once. Most files dropped into a chat
-- to ask one question are never referred to again. Neither is a record of
-- anything; both exist to serve a conversation that is happening now. So both
-- carry a `purge_at`, both are swept by public.chat_surface_purge(), and in
-- both cases the sweep skips exactly the rows somebody acted on -- a chart that
-- became an informe, a file that entered Brain Knowledge. What was kept is kept
-- in the table that keeps things; this one is scratch.
--
-- ===========================================================================
-- 1. A fourth kind of report
-- ===========================================================================
-- Migration 0079 wrote `check (kind in ('expiries','fleet','client_activity'))`
-- with the comment "Three, and only three. A fourth is a code change plus a
-- migration, which is the correct amount of friction". This is that migration,
-- and the friction did its job: it is worth saying why the fourth is not a
-- fourth report.
--
-- The three are RECIPES. Each is a kind plus some parameters, and build.ts
-- turns them into a document by querying. That is what the picker on /reports
-- offers and what reports.generate lets the model ask for.
--
-- 'chart' is not a recipe and can never be generated. It is a document that
-- already exists -- drawn in a conversation from numbers a tool had already
-- returned -- which somebody decided to keep. There are no parameters to re-run
-- because there was never a query. So the code keeps two lists: the three
-- GENERATED_REPORT_KINDS the builder accepts, and the four REPORT_KINDS a
-- stored row may have. Only the second one widens here, and the compiler
-- refuses 'chart' anywhere the first is expected.
--
-- Rewritten rather than widened in place because an inline check has no name to
-- alter; the drop is `if exists` so a re-run finds nothing to do.

alter table public.reports
  drop constraint if exists reports_kind_check;

alter table public.reports
  add constraint reports_kind_check
  check (kind in ('expiries', 'fleet', 'client_activity', 'chart'));

comment on column public.reports.kind is
  'Which report this is. The first three are recipes the builder computes from parameters; ''chart'' is a chart kept out of a conversation, which has no parameters because it was never a query. See migration 0088 section 1.';

-- ===========================================================================
-- 2. Charts drawn in a conversation
-- ===========================================================================

create table if not exists public.chat_charts (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  -- Nullable, and it has to be: a chart outlives the thread it was drawn in
  -- once somebody keeps it, and deleting a conversation must not delete an
  -- informe that was saved out of it. This is also why the table is registered
  -- as `tenant` rather than `derived` in tenancy/tables.ts -- a derived table
  -- whose parent key can be null has no tenancy at all.
  conversation_id uuid references public.conversations(id) on delete set null,
  -- Copied out of the document so a listing does not have to deserialize it.
  title text not null,
  -- The resolved ReportDocument: figures already computed, sources already
  -- stamped. Validated by validateDocument() before it is written and again
  -- before it is rendered, so a citation that points nowhere cannot reach a
  -- page even if the row is restored from a backup or edited by hand.
  document jsonb not null,
  -- Set once, when somebody presses "conservar". Its presence is also what
  -- exempts the row from the retention sweep, and what makes a second press
  -- return the existing informe instead of making a duplicate.
  saved_report_id uuid references public.reports(id) on delete set null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  purge_at timestamptz not null default (now() + interval '30 days')
);

comment on table public.chat_charts is
  'A chart drawn inside a conversation, stored as the resolved document rather than as the question behind it. That is the whole design: keeping it costs no second query, so the informe saved in November shows what the chat showed in August because it is the same bytes. Unsaved rows expire -- see public.chat_surface_purge().';

comment on column public.chat_charts.document is
  'The ReportDocument, identical in shape to public.reports.document. Every figure carries a sourceId that must resolve to a declared source, checked on the way in and on the way out.';

comment on column public.chat_charts.saved_report_id is
  'The informe this chart became, or null. Also the retention flag: a chart somebody kept is never swept.';

create index if not exists chat_charts_conversation_idx
  on public.chat_charts (organization_id, conversation_id, created_at desc);

-- The sweep reads exactly this: expired and never kept.
create index if not exists chat_charts_purge_idx
  on public.chat_charts (purge_at)
  where saved_report_id is null;

-- ===========================================================================
-- 3. Files dropped into a conversation
-- ===========================================================================
--
-- `disposition` IS NOT NULLABLE AND HAS NO DEFAULT, AND THAT IS THE POINT.
--
-- This is the third time this product has answered "where does an uploaded
-- thing land", and the answer has to be consistent with the other two or the
-- rule stops being a rule. import-transcript.ts files a Meet call into the
-- importer's OWN space by default; migration 0068 section 3 requires a WhatsApp
-- group to name its space explicitly before archiving can be switched on. Both
-- rest on the same asymmetry: something that should have been shared is one
-- drag away, and something that should have stayed private and was published
-- cannot be un-read.
--
-- The uncomfortable case here is concrete. Somebody drags a client's contract
-- into the chat to ask one question about a clause. If that silently joins the
-- company-wide memory, every colleague's Cortex can now quote that contract,
-- and there is no undo that reaches the answers already given. So there is no
-- default: the person who dropped the file says, in the moment, which of two
-- things is happening. Nothing is inferred and nothing is remembered as a
-- preference, because a preference is exactly how the wrong answer gets applied
-- to the one file it must not be applied to.
--
--   'memory' -- it joins Brain Knowledge, in a space the person picked. The
--             picker offers their own notes first, and a company-wide space
--             only to an org admin, because assertCanWriteToSpace refuses it to
--             anyone else. From then on it is an ordinary document: it is
--             indexed, it is searchable, and it is citable with provenance.
--
--   'turn'   -- it is read for this conversation and never indexed. The text is
--             extracted, kept here, handed to the model labelled as an
--             attachment rather than as knowledge, and deleted with the row.
--             It never becomes a kb_documents row, so it never counts against
--             the plan and never appears in anybody else's answer.

create table if not exists public.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  disposition text not null check (disposition in ('memory', 'turn')),
  filename text not null,
  mime text not null,
  byte_size bigint not null default 0,
  -- sha256 of the bytes. Used to refuse the same file twice into the same
  -- space: an upload that matches an existing document reuses it instead of
  -- indexing a second copy, which would also bill the workspace twice.
  sha256 text not null,
  -- Set on the 'memory' path once the document row exists. The chat polls it to
  -- show what happened after "guardar" -- indexing takes long enough that
  -- silence reads as failure.
  kb_document_id uuid references public.kb_documents(id) on delete set null,
  -- Which space it went into, on the 'memory' path. Recorded here as well as on
  -- the document so the message can say where it landed without a join.
  space_id uuid references public.kb_collections(id) on delete set null,
  -- Only ever populated on the 'turn' path, and capped by the writer. This is
  -- the text the model reads instead of a document it was never given.
  extracted_text text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  purge_at timestamptz not null default (now() + interval '7 days'),
  -- A row cannot claim both destinations, and cannot claim neither.
  constraint chat_attachments_disposition_shape check (
    (disposition = 'turn' and kb_document_id is null)
    or (disposition = 'memory' and extracted_text is null)
  )
);

comment on table public.chat_attachments is
  'A file dropped into a chat, and the decision the person made about it in the moment: join the company memory, or be read for this conversation only. There is deliberately no default disposition -- see the note above this table in migration 0088, and the same argument in import-transcript.ts and migration 0068 section 3.';

comment on column public.chat_attachments.disposition is
  '''memory'': indexed into Brain Knowledge in a space the uploader chose, citable from then on. ''turn'': text extracted, read for this conversation, never indexed, deleted with the row.';

comment on column public.chat_attachments.extracted_text is
  'The document as plain text, on the ''turn'' path only. It is handed to the model labelled as an attachment rather than as knowledge, so an answer cannot cite it as though it lived in the brain.';

comment on column public.chat_attachments.sha256 is
  'Digest of the bytes. The ''memory'' path looks for an existing document with the same digest in the same space and reuses it -- indexing twice would double the workspace''s document count for one file.';

create index if not exists chat_attachments_conversation_idx
  on public.chat_attachments (organization_id, conversation_id, created_at desc);

-- What the turn reads: this conversation's still-live ephemeral attachments.
create index if not exists chat_attachments_turn_idx
  on public.chat_attachments (conversation_id, created_at)
  where disposition = 'turn';

create index if not exists chat_attachments_purge_idx
  on public.chat_attachments (purge_at);

-- ===========================================================================
-- 4. Retention
-- ===========================================================================
-- One function for both tables, on the same cadence as the other retention
-- sweeps in this schema (turn_context_purge, turn_latency_purge). Install-wide
-- maintenance: no tenant argument, nothing tenant-visible returned, just a
-- count so a failing sweep is visible in the job log.

create or replace function public.chat_surface_purge()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charts bigint;
  v_files  bigint;
begin
  -- A chart somebody kept is not scratch any more, whatever its purge_at says.
  delete from public.chat_charts
   where purge_at < now()
     and saved_report_id is null;
  get diagnostics v_charts = row_count;

  -- The 'memory' rows are a receipt for a document that lives elsewhere, so
  -- letting them expire loses nothing; the document is not touched. The 'turn'
  -- rows ARE the text, and expiring them is the point.
  delete from public.chat_attachments
   where purge_at < now();
  get diagnostics v_files = row_count;

  return v_charts + v_files;
end;
$$;

comment on function public.chat_surface_purge() is
  'Retention sweep for the chat surface: drops expired charts nobody kept and expired attachments, and returns how many rows went. Deleting a ''memory'' attachment never touches the kb_documents row it points at -- that document was kept on purpose and lives under Brain Knowledge''s own retention.';

revoke all on function public.chat_surface_purge() from public;

-- ===========================================================================
-- 5. Row level security
-- ===========================================================================
--
-- Same posture as every table since 0064: RLS on, nothing granted to anon or
-- authenticated, and the service role reaching them only through
-- createOrgScopedClient, which pins the workspace onto every statement. An
-- auth.uid() policy would be theatre here -- no browser ever holds a Postgres
-- session in this application.

alter table public.chat_charts enable row level security;
revoke all on table public.chat_charts from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_charts to service_role;

alter table public.chat_attachments enable row level security;
revoke all on table public.chat_attachments from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_attachments to service_role;
