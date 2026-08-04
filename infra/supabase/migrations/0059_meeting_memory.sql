-- Meetings become memory.
--
-- WHAT WAS WRONG. Cortex could already read a Google Meet transcript
-- (`meetings.get_transcript`) and even cross-reference it with the Knowledge
-- Base before a call (`meetings.prepare_briefing`). It read them live and threw
-- them away. Nothing in packages/agent-tools/src/meetings ever wrote a row. So
-- the single most valuable thing this company produces — what a client actually
-- agreed to, out loud, with a date on it — survived exactly as long as Google's
-- retention and the memory of whoever happened to be on the call. Three months
-- later "what did we promise them?" had no answer, and the transcript that held
-- it was one API call away from being permanent.
--
-- WHAT THIS ADDS. One table, `meeting_imports`, whose entire job is to be the
-- ledger of which conferences have already been turned into KB documents. It
-- deliberately does NOT store the conversation: the transcript is a normal
-- `kb_documents` row with normal `kb_chunks`, so it is searched, cited, moved
-- between spaces and deleted by the machinery that already exists. What lives
-- here is the bit that machinery has nowhere to put — the Meet conference
-- record id — and everything you would want when auditing an automatic import
-- you did not ask for: what it was, when it ran, who it ran as, what broke.
--
-- THE UNIQUE INDEX IS THE FEATURE. A cron sweep that re-reads the last two days
-- of conferences every half hour will see the same meeting dozens of times.
-- Without a unique key on the conference record, "import recent meetings" means
-- "fill the Knowledge Base with forty copies of Tuesday's standup", and every
-- copy costs an embedding call. With it, a re-import is an update of one
-- document in place: the row is found, its `document_id` is reused, its chunks
-- are replaced. Idempotency is not a property of the importer's code here, it
-- is a property of the schema — which is the only version of it that survives
-- someone rewriting the importer.
--
-- ORDERING. This runs after 0057 (Voyage embeddings) and 0058 (audio). It reuses
-- 0058's provenance columns on `kb_documents` rather than adding a parallel set:
-- a meeting has a `recorded_at`, a `duration_seconds`, a `speakers[]` and a
-- `transcript_status` in exactly the sense 0058 defined them, and the KB page
-- should not have to know whether a spoken document arrived as a file or as a
-- conference record to show when it happened and who was in it.

-- ---------------------------------------------------------------------------
-- 1. A meeting is a way a document can arrive
-- ---------------------------------------------------------------------------
-- `source` answers "how did this get here", and a Meet transcript is neither an
-- upload (nobody chose a file), a gdrive sync (deliberately not: Meet writes a
-- Doc, but the Meet REST API serves the same text with only the Meet scope —
-- see meetings/client.ts for why that route was refused), nor a url fetch.
--
-- ADD VALUE, like in 0058, is not used anywhere in this same migration, which
-- is the one thing Postgres forbids inside a transaction block.
alter type document_source add value if not exists 'meeting';

-- 0058 constrained `media_kind` to ('text', 'audio') because those were the two
-- things bytes could be. A meeting is a third: there are no bytes at all. Google
-- hands over the transcript already written, so a meeting document must never
-- reach the transcription worker — it has nothing to transcribe and would fail
-- on a null `media_path` forever. Keeping it out of 'audio' is what makes that
-- structural instead of a special case someone has to remember.
alter table public.kb_documents drop constraint if exists kb_documents_media_kind_check;
alter table public.kb_documents
  add constraint kb_documents_media_kind_check check (media_kind in ('text', 'audio', 'meeting'));

comment on column public.kb_documents.media_kind is
  'What the stored bytes are, and therefore what has to be done with them. ''text'' is parsed, ''audio'' is transcribed first, ''meeting'' arrives already transcribed from Google Meet and has no media_path at all. The ingestion worker branches on this, not on mime.';

-- The KB page and the import sweep both want "the meetings in this space,
-- newest conversation first". Partial for the same reason 0058's audio index is:
-- almost every row in this table is and will remain a text document.
create index if not exists kb_documents_meeting_idx
  on public.kb_documents (collection_id, recorded_at desc)
  where media_kind = 'meeting';

-- ---------------------------------------------------------------------------
-- 2. The ledger
-- ---------------------------------------------------------------------------
create table if not exists public.meeting_imports (
  id uuid primary key default gen_random_uuid(),

  -- The Meet REST API v2 resource name, "conferenceRecords/xxx". This is the
  -- identity of one actual sitting of a meeting — not of the recurring calendar
  -- entry, and not of the Meet link, both of which are reused every week. It is
  -- the only identifier in the whole flow that means "this conversation, once".
  conference_record text not null,

  -- The joinable code from the invite ("abc-defg-hij"). Not unique on purpose:
  -- a weekly call has one code and fifty conference records. It is here so a
  -- person searching for the meeting they know by its link can find every
  -- sitting of it.
  meeting_code text,

  -- The Google Meet SPACE resource name, "spaces/xxx" — NOT a Knowledge Base
  -- space. The collision of the word is unfortunate and deliberate: this column
  -- mirrors the Meet API's own field name. Which KB space the transcript landed
  -- in is `kb_documents.collection_id`, reachable through `document_id`.
  space_name text,

  title text,
  started_at timestamptz,
  ended_at timestamptz,

  -- Resolved display names, not participant resource names, because the point
  -- of the audit row is that a human can read it without calling Google back.
  participants text[] not null default '{}',

  -- The document this became. `set null` rather than cascade: if someone deletes
  -- the transcript from the Knowledge Base, that is a decision about the
  -- CONTENT, and erasing the record that it was ever imported would let the next
  -- sweep silently import it again. A row with a null document_id and a 'ready'
  -- status reads correctly as "this was imported and later removed on purpose".
  document_id uuid references public.kb_documents(id) on delete set null,

  -- Whose Google credentials read it, which is also whose personal space it
  -- landed in by default. Kept for the audit question that actually gets asked
  -- about an automatic import — "who could see this call?" — so it must survive
  -- the account being deleted; hence `set null`, not cascade.
  imported_by uuid references public.users(id) on delete set null,
  imported_at timestamptz not null default now(),

  -- 'ready'  — the transcript is in the KB and searchable.
  -- 'failed' — it was found but could not be ingested (embedding outage, a
  --            revoked scope mid-run). The sweep retries these; a meeting with
  --            no transcript yet is NOT recorded at all, because Meet can take
  --            minutes to finish writing one and a row here would turn "not
  --            ready yet" into "never look again".
  status text not null default 'ready' check (status in ('ready', 'failed')),
  error text
);

-- THE point of this table. See the header.
create unique index if not exists meeting_imports_conference_record_idx
  on public.meeting_imports (conference_record);

-- The sweep's query: "recent conferences, have I done these yet".
create index if not exists meeting_imports_started_at_idx
  on public.meeting_imports (started_at desc);

-- "Show me what my last import run did", and the retry scan for failures.
create index if not exists meeting_imports_importer_idx
  on public.meeting_imports (imported_by, imported_at desc);

comment on table public.meeting_imports is
  'Which Google Meet conferences have already been written into the Knowledge Base. One row per sitting of a meeting, keyed uniquely by the Meet conference record so re-running an import updates the existing document instead of duplicating it. Holds no conversation text — that is a normal kb_documents row.';
comment on column public.meeting_imports.conference_record is
  'Meet API v2 resource name of one sitting, "conferenceRecords/xxx". Unique: this is what makes importing idempotent.';
comment on column public.meeting_imports.space_name is
  'The Google Meet space ("spaces/xxx") the conference ran in. Not a Knowledge Base space — for that, follow document_id to kb_documents.collection_id.';
comment on column public.meeting_imports.status is
  '''ready'' = in the Knowledge Base. ''failed'' = a transcript existed but ingestion broke, and the sweep should try again. A conference with no transcript yet gets no row, so it is retried rather than written off.';

-- ---------------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------------
-- Deny-all with no policies: service-role only, the same posture as every other
-- operational table in this schema (0055's orchestration tables, 0022's sync
-- state). The visibility rule for the CONTENT is unchanged and lives where it
-- always has — the transcript is in a KB space, and a space is who may read it.
-- This ledger is reached only through code that has already resolved the space.
alter table public.meeting_imports enable row level security;
