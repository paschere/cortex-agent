-- Brain Knowledge can be opened and read fragment by fragment.
--
-- WHAT IS MISSING TODAY. The page shows documents: how many went in, which
-- source they came through, how they relate. But a document is not what Cortex
-- recalls. Asked about the Saturday agreement with Coltrans it does not read a
-- forty-page contract — it retrieves four or five FRAGMENTS and answers with
-- those. So the document list shows what somebody handed over, and nothing on
-- screen shows what was actually understood. When an answer comes out wrong,
-- there is no way to see that the passage it needed was cut in half.
--
-- Three things become answerable here, and only the third needs new state:
--
--   1. WHAT IS IN A FRAGMENT — already stored. `kb_chunks` has the text, the
--      token count and the provenance (`{speaker, startMs, endMs}` for anything
--      spoken, `{pages}` for a PDF). Reading it needs no migration, only a
--      route that asks. Nothing here.
--
--   2. WHICH FRAGMENTS ARE BADLY CUT — derivable. A three-word fragment
--      ("listo"), the same paragraph stored twice, a fragment that stops in the
--      middle of a sentence: all three are visible in the rows themselves and
--      all three quietly ruin semantic search. `kb_fragment_health` below
--      counts them and hands back examples. Derived on demand rather than
--      stored, because a stored verdict goes stale the moment a document is
--      re-indexed and nothing would notice.
--
--   3. WHICH FRAGMENTS HAVE NEVER BEEN USED — NOT derivable, and the reason
--      this migration exists. Nothing in the schema has ever recorded that a
--      chunk came back in an answer. `audit_events` stores a hash of the tool
--      input and nothing of the output; `messages.tool_results` keeps the hits
--      but 0066's tool drops `chunkId` before returning them. So "this fragment
--      has never been used to answer anything" — the cost nobody sees, the
--      thousands of embedded fragments that were never worth embedding — has
--      been unaskable. Two columns make it askable.
--
-- WHAT IS DELIBERATELY NOT BUILT. No retrieval log table. An append-only row
-- per hit per search would be the more powerful answer — it could show trends,
-- which query pulled what, retrieval over time — and it would also be the
-- largest-growing table in the product within a month, for a question the
-- counter already answers. Two columns on the row that is already being read
-- cost nothing to keep and nothing to query. If the trend is ever wanted, the
-- log can be added then, by somebody who knows what they want from it.

-- ---------------------------------------------------------------------------
-- 1. A fragment remembers whether it was ever used
-- ---------------------------------------------------------------------------
-- Both default to "never", which is the truthful starting state and also the
-- awkward one: on the day this ships, every fragment in the corpus reads as
-- unused, because nothing was counting. The interface handles that in words
-- rather than by guessing a backfill — it prints how many retrievals have been
-- recorded at all, and says so plainly when the answer is none. A backfill
-- would have had to invent history, and an invented figure on a page whose
-- whole purpose is to be checkable is worse than an empty one.
alter table public.kb_chunks
  add column if not exists retrieval_count int not null default 0,
  add column if not exists last_retrieved_at timestamptz;

comment on column public.kb_chunks.retrieval_count is
  'How many times this fragment has come back from a retrieval that was actually answering someone. Counted only for the agent''s own searches — a person browsing Brain Knowledge or running the memory bench does not move it, because the question it answers is "does Cortex ever use this", not "has anyone ever looked at it".';
comment on column public.kb_chunks.last_retrieved_at is
  'The last time this fragment was retrieved to answer something. Null means never, which on a corpus indexed before this column existed is indistinguishable from "not yet counted" — the interface says which, from the corpus-wide total.';

-- Finding what was never used is the whole question, and on a healthy corpus
-- the answer shrinks over time, so the index is partial: it covers exactly the
-- rows still being asked about and disappears as they are used.
create index if not exists kb_chunks_never_retrieved_idx
  on public.kb_chunks (document_id)
  where retrieval_count = 0;

-- ---------------------------------------------------------------------------
-- 2. Recording a retrieval
-- ---------------------------------------------------------------------------
-- Called by `searchSpaces` when — and only when — the search was run to answer
-- somebody. Two callers deliberately do NOT pass the flag:
--
--   * the memory bench on the Brain Knowledge page, whose entire purpose is to
--     run the real retrieval WITHOUT it counting as one. A bench that marked
--     fragments as used would destroy the signal it exists to inspect.
--   * the search box on the same page. Somebody looking something up by hand
--     is not Cortex answering with it.
--
-- Scoped like everything else: the chunk ids are re-derived from the visible
-- set rather than trusted, so handing it an id from another workspace bumps
-- nothing and returns 0. That matters more here than on a read — this is the
-- one write in the KB surface that takes raw chunk ids from a caller.
create or replace function public.kb_note_retrieval(
  p_user_id uuid,
  p_chunk_ids uuid[]
)
returns int
language sql
volatile
as $$
  with allowed as (
    select ch.id
    from public.kb_chunks ch
    join public.kb_documents d on d.id = ch.document_id
    where ch.id = any(p_chunk_ids)
      and d.collection_id in (
        select v.space_id from public.kb_visible_space_ids(p_user_id) v
      )
  ),
  bumped as (
    update public.kb_chunks ch
    set retrieval_count = ch.retrieval_count + 1,
        last_retrieved_at = now()
    from allowed a
    where ch.id = a.id
    returning ch.id
  )
  select count(*)::int from bumped;
$$;

comment on function public.kb_note_retrieval(uuid, uuid[]) is
  'Record that these fragments were retrieved to answer something, for p_user_id. Ids are re-derived from the spaces that user may see, so an id from elsewhere is silently ignored rather than bumped. Returns how many rows were counted, which is how a caller can tell a scoping mistake from a no-op.';

revoke all on function public.kb_note_retrieval(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.kb_note_retrieval(uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 3. What is wrong with how the corpus got cut up
-- ---------------------------------------------------------------------------
-- Three defects, each of which quietly costs recall and none of which is
-- visible anywhere today:
--
--   TINY — a fragment of a handful of tokens ("listo", "ok", a stray heading).
--     Its embedding is dominated by whatever those few words happen to mean, so
--     it sits near a huge and arbitrary region of the space and turns up as a
--     mediocre match for questions about nothing in particular. It is noise
--     with a vector.
--
--   CUT — a written fragment that stops without the sentence ending, and is not
--     the last fragment of its document. That means the chunker ran out of
--     budget in a place the text did not offer a break, so half a statement is
--     embedded here and the other half next door. Retrieval then returns a
--     clause with no verb, and a model reading it fills in the rest.
--
--     SPOKEN FRAGMENTS ARE EXCLUDED FROM THIS TEST, and that exclusion is the
--     difference between a useful flag and a useless one. `chunkTranscript`
--     never breaks a speech turn, so a transcript fragment ends where somebody
--     stopped talking — and transcription rarely punctuates that. Applying the
--     written-text rule to speech would flag most of the audio corpus and the
--     signal would be worthless. A fragment counts as spoken when its metadata
--     carries `startMs`, which is exactly what the transcript chunker writes.
--
--   REPEATED — byte-identical text stored more than once: the same file
--     uploaded twice, a contract and its signed scan, a paragraph pasted into a
--     summary. Both copies compete for the same slot in every result set, so
--     one real answer can consume two of the five things retrieval is allowed
--     to return. Deliberately EXACT equality and not near-duplication: 0066
--     already finds near-identical passages, it costs an index probe per chunk,
--     and it produces judgement calls. This produces certainties.
--
-- WHY IT IS COMPUTED RATHER THAN STORED. Every one of these is a property of a
-- row that is rewritten wholesale on re-index. A stored verdict would survive
-- the re-index that fixed it and there would be nothing to notice.
--
-- WHAT IT COSTS. A scan of the fragments in the visible spaces, plus one hash
-- aggregate for the duplicate groups. Linear, no vector work, and nothing here
-- is on the answering path — it runs when somebody opens the analysis, and the
-- page streams it in rather than waiting on it.
create or replace function public.kb_fragment_health(
  p_user_id uuid,
  p_space_ids uuid[] default null,
  p_samples int default 6
)
returns jsonb
language sql
stable
as $$
  with targets as (
    -- Intersection, never union: p_space_ids narrows what this person can
    -- already see and can never widen it.
    select v.space_id as id
    from public.kb_visible_space_ids(p_user_id) v
    where p_space_ids is null or v.space_id = any(p_space_ids)
  ),
  -- Duplicate groups first, over hashes alone. Doing it as a window over the
  -- fragment rows would sort every chunk body in the corpus; this sorts 32-byte
  -- hashes and joins the answer back.
  dupes as (
    select md5(ch.content) as h, count(*)::int as copies
    from public.kb_chunks ch
    join public.kb_documents d on d.id = ch.document_id
    where d.collection_id in (select id from targets)
    group by 1
    having count(*) > 1
  ),
  scope as (
    select ch.id,
           ch.document_id,
           ch.chunk_index,
           ch.content,
           ch.tokens,
           ch.metadata,
           ch.retrieval_count,
           ch.last_retrieved_at,
           (ch.embedding is not null) as embedded,
           d.title as document_title,
           s.id as space_id,
           s.name as space_name,
           max(ch.chunk_index) over (partition by ch.document_id) as last_index,
           coalesce(dp.copies, 1) as copies
    from public.kb_chunks ch
    join public.kb_documents d on d.id = ch.document_id
    join public.kb_collections s on s.id = d.collection_id
    left join dupes dp on dp.h = md5(ch.content)
    where d.collection_id in (select id from targets)
  ),
  -- SIX TOKENS, measured against the chunker's own ruler (words x 1.3). The
  -- first cut written here was twelve, and running it over a real corpus showed
  -- what is wrong with that: "Los sábados no se hacen despachos" is eight
  -- tokens, a complete and perfectly retrievable statement, and it was being
  -- reported as noise. Six is roughly four words — "listo", "ok, gracias",
  -- "Anexo 3" — which is the actual failure: a fragment whose embedding is
  -- decided by two words and therefore sits near an enormous, arbitrary region
  -- of the space.
  marked as (
    select sc.*,
           -- The synthetic first fragment of a meeting or a WhatsApp window is
           -- a header the importer wrote, not something the chunker cut. It is
           -- short on purpose and flagging it would be a false alarm on every
           -- conversation in the corpus.
           jsonb_exists(sc.metadata, 'kind') as synthetic,
           jsonb_exists(sc.metadata, 'startMs') as spoken,
           (not jsonb_exists(sc.metadata, 'kind') and sc.tokens < 6) as tiny,
           -- A scrap is not also a truncated sentence. Without the `tokens >= 6`
           -- guard "listo" is reported under both headings, the three counts add
           -- up to more bad fragments than exist, and the panel starts
           -- overstating the problem — which is the fastest way for a number
           -- like this to stop being believed.
           (not jsonb_exists(sc.metadata, 'startMs')
             and not jsonb_exists(sc.metadata, 'kind')
             and sc.tokens >= 6
             and sc.chunk_index < sc.last_index
             and sc.content !~ '[.!?…:;")»]["»)]*\s*$') as cut,
           (sc.copies > 1) as repeated,
           (sc.retrieval_count = 0) as never_used
    from scope sc
  ),
  totals as (
    select count(*)::int as total,
           count(*) filter (where embedded)::int as embedded,
           count(*) filter (where not embedded)::int as unembedded,
           count(*) filter (where never_used)::int as never_used,
           coalesce(sum(retrieval_count), 0)::bigint as retrievals,
           min(last_retrieved_at) as first_used_at,
           max(last_retrieved_at) as last_used_at,
           count(*) filter (where tiny)::int as tiny,
           count(*) filter (where cut)::int as cut,
           count(*) filter (where repeated)::int as repeated,
           -- Distinct fragments with anything wrong with them. The three counts
           -- above overlap (a duplicate can also be truncated), so summing them
           -- overstates the damage; this is the number the headline uses.
           count(*) filter (where tiny or cut or repeated)::int as flagged,
           count(distinct document_id)::int as documents,
           coalesce(percentile_disc(0.5) within group (order by tokens), 0)::int as median_tokens
    from marked
  )
  select jsonb_build_object(
    'total', t.total,
    'documents', t.documents,
    'embedded', t.embedded,
    'unembedded', t.unembedded,
    'neverUsed', t.never_used,
    'retrievals', t.retrievals,
    'firstUsedAt', t.first_used_at,
    'lastUsedAt', t.last_used_at,
    'medianTokens', t.median_tokens,
    'tiny', t.tiny,
    'cut', t.cut,
    'repeated', t.repeated,
    'flagged', t.flagged,
    'samples', jsonb_build_object(
      'tiny', (
        select coalesce(jsonb_agg(q.row), '[]'::jsonb) from (
          select jsonb_build_object(
                     'chunkId', m.id,
                     'documentId', m.document_id,
                     'documentTitle', m.document_title,
                     'spaceId', m.space_id,
                     'spaceName', m.space_name,
                     'chunkIndex', m.chunk_index,
                     'tokens', m.tokens,
                     'copies', m.copies,
                     'retrievalCount', m.retrieval_count,
                     'spoken', m.spoken,
                     -- Truncated: a fragment can be two thousand characters and
                     -- no reading of six of them in a summary panel needs more
                     -- than the opening lines. The reader fetches the whole
                     -- thing when somebody opens one.
                     'content', left(m.content, 360)
                   ) as row
          from marked m where m.tiny
          order by m.tokens asc, m.chunk_index asc
          limit p_samples
        ) q
      ),
      'cut', (
        select coalesce(jsonb_agg(q.row), '[]'::jsonb) from (
          select jsonb_build_object(
                     'chunkId', m.id,
                     'documentId', m.document_id,
                     'documentTitle', m.document_title,
                     'spaceId', m.space_id,
                     'spaceName', m.space_name,
                     'chunkIndex', m.chunk_index,
                     'tokens', m.tokens,
                     'copies', m.copies,
                     'retrievalCount', m.retrieval_count,
                     'spoken', m.spoken,
                     -- Truncated: a fragment can be two thousand characters and
                     -- no reading of six of them in a summary panel needs more
                     -- than the opening lines. The reader fetches the whole
                     -- thing when somebody opens one.
                     'content', left(m.content, 360)
                   ) as row
          from marked m where m.cut
          order by m.tokens desc
          limit p_samples
        ) q
      ),
      'repeated', (
        select coalesce(jsonb_agg(d.row), '[]'::jsonb) from (
          -- One representative per duplicate group, biggest group first: the
          -- point is "this text is in the corpus four times", not four rows
          -- saying the same thing.
          select q.row, q.copies from (
            select distinct on (md5(m.content))
                   jsonb_build_object(
                     'chunkId', m.id,
                     'documentId', m.document_id,
                     'documentTitle', m.document_title,
                     'spaceId', m.space_id,
                     'spaceName', m.space_name,
                     'chunkIndex', m.chunk_index,
                     'tokens', m.tokens,
                     'copies', m.copies,
                     'retrievalCount', m.retrieval_count,
                     'spoken', m.spoken,
                     -- Truncated: a fragment can be two thousand characters and
                     -- no reading of six of them in a summary panel needs more
                     -- than the opening lines. The reader fetches the whole
                     -- thing when somebody opens one.
                     'content', left(m.content, 360)
                   ) as row, m.copies
            from marked m where m.repeated
            order by md5(m.content), m.chunk_index
          ) q
          order by q.copies desc
          limit p_samples
        ) d
      ),
      'deadDocuments', (
        -- Grouped by document rather than listed fragment by fragment: nobody
        -- acts on one unused fragment, they act on "this whole file has never
        -- been worth anything to an answer".
        select coalesce(jsonb_agg(q.row), '[]'::jsonb) from (
          select jsonb_build_object(
                   'documentId', m.document_id,
                   'documentTitle', m.document_title,
                   'spaceId', m.space_id,
                   'spaceName', m.space_name,
                   'never', count(*) filter (where m.never_used)::int,
                   'total', count(*)::int
                 ) as row,
                 count(*) filter (where m.never_used) as never
          from marked m
          group by m.document_id, m.document_title, m.space_id, m.space_name
          having count(*) filter (where m.never_used) > 0
          order by never desc, count(*) desc
          limit p_samples
        ) q
      )
    )
  )
  from totals t;
$$;

comment on function public.kb_fragment_health(uuid, uuid[], int) is
  'What is wrong with how the fragments in p_user_id''s visible spaces were cut, plus how much of the corpus has never been used to answer anything. Counts and a handful of real examples for each defect: fragments too short to mean anything, written fragments that stop mid-sentence (speech is excluded — a speech turn ends where the speaker stopped, and transcription does not punctuate), and byte-identical duplicates. Derived on every call rather than stored, because every one of these properties is rewritten when a document is re-indexed.';

revoke all on function public.kb_fragment_health(uuid, uuid[], int) from public, anon, authenticated;
grant execute on function public.kb_fragment_health(uuid, uuid[], int) to service_role;
