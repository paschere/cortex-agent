-- Audio in the Knowledge Base.
--
-- WHAT CHANGES. Until now a document was something you could read: a PDF, a
-- Word file, a note. The most valuable thing this company knows, though, is
-- said out loud and never written down — what a client actually promised on a
-- call, what was agreed in a standup, the voice memo someone dictated walking
-- out of a meeting. This migration makes a recording a first-class document:
-- uploaded or captured in the browser, transcribed, and indexed so Cortex can
-- answer "what did they commit to?" and point at the person and the minute.
--
-- THE POINT IS THE PROVENANCE, not the file. A transcript with no idea who
-- said what, when, is a wall of text: it can be searched but it cannot be
-- trusted or checked. So three things travel with the audio and they are the
-- reason this is a migration rather than a new MIME type in an allowlist:
--
--   1. `kb_documents` learns where the recording came from and how long it is,
--      which is what turns "a file in a bucket" into a memory with a date.
--   2. `kb_chunks.metadata` — which already existed and only ever held {pages}
--      — starts carrying {speaker, startMs, endMs} per chunk, written by the
--      transcript chunker.
--   3. `kb_search_scoped` starts RETURNING that metadata. Without this last
--      step the timestamps are stored and unreachable: retrieval hands back a
--      chunk of text with no way to say which minute it came from, and the
--      citation degrades to "somewhere in this 50-minute call".
--
-- RLS. `kb_documents` and `kb_chunks` already have row-level policies from
-- 0008 and they key off `collection_id` / `document_id`, never off a column
-- list. New columns inherit them with nothing to add. The access boundary is
-- unchanged: audio lands in a space, and a space is who may read it.

-- ---------------------------------------------------------------------------
-- 1. Where a recording came from
-- ---------------------------------------------------------------------------
-- `source` answers "how did this arrive", and audio arrives two ways that are
-- worth telling apart in the UI and in an answer: a file someone had already
-- (a Zoom export, a phone memo) versus something captured in the browser right
-- here. `media_kind` stays the switch that the ingestion worker branches on —
-- source is provenance, media_kind is what has to be done with the bytes.
--
-- ADD VALUE runs outside any use of the new labels in this same migration,
-- which is the one thing Postgres forbids inside a transaction block.
alter type document_source add value if not exists 'audio';
alter type document_source add value if not exists 'recording';

alter table public.kb_documents
  -- 'text' rather than nullable: every existing row IS a text document, and a
  -- worker that has to treat null as "probably text" is a worker that will one
  -- day treat an unset audio row as text and index the raw bytes.
  add column if not exists media_kind text not null default 'text',
  add column if not exists media_path text,
  add column if not exists duration_seconds int,
  add column if not exists recorded_at timestamptz,
  add column if not exists speakers text[],
  add column if not exists transcript_status text,
  add column if not exists transcript_error text;

alter table public.kb_documents drop constraint if exists kb_documents_media_kind_check;
alter table public.kb_documents
  add constraint kb_documents_media_kind_check check (media_kind in ('text', 'audio'));

-- Transcription is a separate, slower failure surface from ingestion: a
-- recording can transcribe perfectly and still fail to embed, and a missing
-- Deepgram key is a configuration problem the person should be told about in
-- those words rather than as "couldn't be read". Hence its own status column
-- next to `status`, not folded into it.
alter table public.kb_documents drop constraint if exists kb_documents_transcript_status_check;
alter table public.kb_documents
  add constraint kb_documents_transcript_status_check check (
    transcript_status is null
    or transcript_status in ('pending', 'transcribing', 'ready', 'failed')
  );

comment on column public.kb_documents.media_kind is
  'What the stored bytes are. ''text'' documents are parsed; ''audio'' documents are transcribed first. The ingestion worker branches on this, not on mime, because the same audio/mp4 container can arrive from an upload or from a browser recording.';
comment on column public.kb_documents.media_path is
  'Storage path of the original audio in the kb-uploads bucket. Kept after transcription so the recording can be played back next to the transcript — a quoted promise is worth much more when you can hear it.';
comment on column public.kb_documents.duration_seconds is
  'Length of the recording, from the transcript. Null until transcription succeeds.';
comment on column public.kb_documents.recorded_at is
  'When the conversation happened, which is rarely when the file was uploaded. This is the date an answer should cite.';
comment on column public.kb_documents.speakers is
  'Speaker labels found by diarization, in first-heard order. Diarization gives numbered speakers, not names, so these start as "Speaker 1"… and exist to be renamed to real people later.';
comment on column public.kb_documents.transcript_status is
  'Transcription lifecycle, separate from `status` because it fails for different reasons and on a different timescale. Null on text documents.';

-- The KB page lists audio and text side by side but only audio needs the
-- duration/speaker columns fetched, and only audio rows are ever re-driven
-- after a transcription outage. Partial, because the vast majority of rows
-- are and will remain text.
create index if not exists kb_documents_audio_idx
  on public.kb_documents (collection_id, recorded_at desc)
  where media_kind = 'audio';

-- ---------------------------------------------------------------------------
-- 2. Retrieval returns the chunk's metadata
-- ---------------------------------------------------------------------------
-- This is the change that makes audio citable. Everything above is bookkeeping
-- on the document; a citation is built from the CHUNK, and the chunk's speaker
-- and offsets live in `kb_chunks.metadata`, which the search function has
-- never returned.
--
-- The body below keeps everything the version it replaces did — the same
-- targets/vec/fts CTEs and the same 0.7 semantic / 0.3 keyword blend, so
-- result ordering does not move on the day audio ships — plus the keyword-only
-- fallback for a null query embedding, so a rebuild of this function cannot
-- quietly take that behaviour back out.
--
-- Two more deliberate details:
--
--   * `p_query_embedding` stays vector(1024), matching 0057. Postgres does not
--     carry the typmod in a function's signature, so this could have been
--     written as a bare `vector` and still replaced the same function — but
--     pgvector enforces the modifier at call time, and 0057 relies on that to
--     make a caller with the wrong dimensions fail loudly instead of returning
--     nonsense. Rebuilding this function is not a reason to give that up.
--   * DROP before CREATE, because the return type gains a column and
--     `create or replace` refuses to change an existing function's shape.

drop function if exists public.kb_search_scoped(uuid, vector, text, int, uuid[]);

create function public.kb_search_scoped(
  p_user_id uuid,
  p_query_embedding vector(1024),
  p_query_text text,
  p_limit int default 8,
  p_space_ids uuid[] default null
)
returns table (
  document_id uuid,
  document_title text,
  space_id uuid,
  space_name text,
  space_scope kb_scope,
  chunk_index int,
  content text,
  score double precision,
  metadata jsonb
)
language sql
stable
as $$
  with targets as (
    -- The intersection is the whole guarantee: p_space_ids filters this set,
    -- it does not define it.
    select v.space_id as id
    from public.kb_visible_space_ids(p_user_id) v
    where p_space_ids is null or v.space_id = any(p_space_ids)
  ),
  vec as (
    select ch.document_id as doc_id, ch.chunk_index as idx, ch.content as body,
           ch.metadata as meta,
           1 - (ch.embedding <=> p_query_embedding) as vec_score
    from public.kb_chunks ch
    join public.kb_documents d on d.id = ch.document_id
    -- A null embedding means the caller could not embed the query at all (no
    -- provider key, provider down). Skipping the semantic arm entirely gives
    -- keyword-only results, which is a degraded answer; letting the null
    -- through would instead pull p_limit*4 arbitrary chunks at score zero and
    -- present them as if they had been ranked.
    where p_query_embedding is not null
      and ch.embedding is not null
      and d.collection_id in (select id from targets)
    order by ch.embedding <=> p_query_embedding
    limit p_limit * 4
  ),
  fts as (
    select ch.document_id as doc_id, ch.chunk_index as idx, ch.content as body,
           ch.metadata as meta,
           ts_rank(to_tsvector('simple', ch.content),
                   plainto_tsquery('simple', p_query_text)) as fts_score
    from public.kb_chunks ch
    join public.kb_documents d on d.id = ch.document_id
    where d.collection_id in (select id from targets)
      and to_tsvector('simple', ch.content) @@ plainto_tsquery('simple', p_query_text)
    order by fts_score desc
    limit p_limit * 4
  ),
  combined as (
    select coalesce(v.doc_id, f.doc_id) as doc_id,
           coalesce(v.idx, f.idx) as idx,
           coalesce(v.body, f.body) as body,
           coalesce(v.meta, f.meta) as meta,
           coalesce(v.vec_score, 0) * 0.7 + coalesce(f.fts_score, 0) * 0.3 as blended
    from vec v
    full outer join fts f on v.doc_id = f.doc_id and v.idx = f.idx
  )
  select cb.doc_id,
         d.title,
         s.id,
         s.name,
         s.scope,
         cb.idx,
         cb.body,
         cb.blended,
         coalesce(cb.meta, '{}'::jsonb)
  from combined cb
  join public.kb_documents d on d.id = cb.doc_id
  join public.kb_collections s on s.id = d.collection_id
  order by cb.blended desc
  limit p_limit;
$$;

comment on function public.kb_search_scoped(uuid, vector, text, int, uuid[]) is
  'Hybrid Knowledge Base search restricted to what p_user_id may see. Query embeddings are voyage-3-large at 1024 dims, produced with input_type "query"; passing a null embedding degrades the call to keyword-only rather than failing it. p_space_ids narrows the result to a subset of the visible spaces and can never widen it. Returns each chunk''s metadata, so a hit from a recording can be cited with the speaker and the offset it came from; text chunks carry {pages} or nothing.';

-- Same posture as 0049: PostgREST publishes everything in `public` under
-- /rpc/, and this function takes the user id as a plain argument, so anything
-- holding an anon key could otherwise ask it for someone else's notes.
revoke all on function public.kb_search_scoped(uuid, vector, text, int, uuid[]) from public, anon, authenticated;
grant execute on function public.kb_search_scoped(uuid, vector, text, int, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The bucket has to be able to hold a phone call
-- ---------------------------------------------------------------------------
-- 10 MB was sized for a PDF. An hour of speech is roughly 30 MB at a 64 kbps
-- mono MP3, and the browser recorder writes Opus-in-WebM which is smaller
-- still — but people also drop in whatever their conferencing tool exported,
-- and an uncompressed 48 kHz WAV of the same hour is about 330 MB. 200 MB is
-- the deliberate middle: it takes any reasonable compressed recording of a
-- long meeting, and it rejects raw WAV dumps at the door with a clear error
-- instead of accepting a quarter-gigabyte upload that then has to be paid for,
-- signed, and pushed through a transcription API.
--
-- audio/x-m4a and audio/mp4 are both listed because the same .m4a file is
-- labelled one way by Safari and the other by Chrome; audio/webm is what
-- MediaRecorder produces in the browser recorder.
update storage.buckets
set file_size_limit = 209715200,
    allowed_mime_types = array[
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/markdown',
      'audio/mpeg',
      'audio/mp4',
      'audio/wav',
      'audio/x-wav',
      'audio/webm',
      'audio/ogg',
      'audio/x-m4a'
    ]
where id = 'kb-uploads';
