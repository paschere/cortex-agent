-- Brain Knowledge learns what it does NOT know, and when what it knows expired.
--
-- WHAT IS WRONG TODAY. `kb_search_scoped` always answers. Ask it about the
-- rate card and it returns the rate card; ask it about a recipe for arepas and
-- it returns the rate card too, a little lower down, and the model reads that
-- as evidence. Retrieval that cannot say "nothing here is about that" is a
-- search box, not a brain: the caller receives a list and has no way to tell a
-- confident answer from the least-bad row in an index.
--
-- The information needed to tell them apart already exists inside this
-- function and is thrown away on the way out. `vec_score` — the cosine
-- similarity between the question and the passage — is the only number in the
-- pipeline that means the same thing from one query to the next. It gets
-- multiplied by 0.7, added to a `ts_rank` that is 0 for most rows and unbounded
-- for the rest, and the caller is handed the sum. So every threshold anyone has
-- ever set on that sum (0.55 in kb/context.ts, 0.65 in the chat route) was set
-- on a quantity that nobody could interpret. This migration returns the two
-- components alongside the blend, so relevance can be judged on the axis that
-- has a meaning and ranking can keep using the blend that has a tuning.
--
-- THREE THINGS CHANGE, all of them additive:
--
--   1. `kb_search_scoped` returns `chunk_id`, `vec_score`, `fts_score`, and the
--      document's own date, expiry and replacement. Same rows, same order.
--   2. `kb_documents` learns that a document can be REPLACED by another one or
--      can simply run out (`superseded_by`, `superseded_at`, `valid_until`).
--   3. `kb_conflict_candidates` — given the chunks a search just returned, find
--      passages elsewhere in the corpus that say almost the same thing from a
--      document of a different date. That is what a contradiction looks like
--      from the vectors' side: the March contract and the July call are near
--      neighbours precisely BECAUSE they are about the same rate.
--
-- WHAT DELIBERATELY DOES NOT CHANGE: the ranking. It would have been easy to
-- demote expired and superseded documents here, and it would have been wrong.
-- A demoted policy falls off the end of `p_limit` and the person who asked
-- about their policy gets silence instead of "this one expired in January" —
-- which is the worse failure of the two, and the exact failure this whole
-- change exists to prevent. Age is returned so the CITATION can carry it. The
-- model weighs it; the index does not hide it.

-- ---------------------------------------------------------------------------
-- 1. A document can be replaced, and a document can run out
-- ---------------------------------------------------------------------------
-- Two different facts that both make a document stop being true, kept apart
-- because they are learned in different ways and mean different things in an
-- answer:
--
--   * `valid_until` is written INTO the document. An insurance policy says on
--     its face that it covers until 31 January. Nobody has to notice anything
--     for it to expire; the date passes on its own.
--   * `superseded_by` is a judgement someone makes later: this new rate card
--     replaces that old one. It cannot be derived — two rate cards for
--     different clients are not replacements of each other — so it is set
--     explicitly, by whoever saves the replacement.
--
-- Both are nullable and both default to null, which is the honest default: the
-- overwhelming majority of documents neither expire nor get replaced, and a
-- guessed expiry would be worse than none.
alter table public.kb_documents
  add column if not exists valid_until timestamptz,
  add column if not exists superseded_by uuid references public.kb_documents(id) on delete set null,
  add column if not exists superseded_at timestamptz;

-- A document cannot replace itself. Without this a bad update makes retrieval
-- report every citation as replaced by itself, which reads as "nothing here is
-- current" — the silence failure again, arrived at by accident.
alter table public.kb_documents drop constraint if exists kb_documents_supersede_not_self;
alter table public.kb_documents
  add constraint kb_documents_supersede_not_self check (superseded_by is null or superseded_by <> id);

comment on column public.kb_documents.valid_until is
  'The date the document itself says it stops being true — a policy period, a quoted rate that holds until a date. Null means the document does not carry an expiry, NOT that it is eternal; age is still returned on every hit so a citation can be weighed.';
comment on column public.kb_documents.superseded_by is
  'The document that replaced this one. Set by whoever saves the replacement, never inferred: two rate cards for two clients are not versions of each other. Retrieval still returns superseded documents — it labels them, because "this was replaced by X" is a better answer than nothing.';
comment on column public.kb_documents.superseded_at is
  'When the replacement was recorded. Distinct from the replacement''s own date: a contract signed in March can be superseded by a call in July that somebody only files in September.';

-- Finding "what did this replace" is a page-level lookup on a column that is
-- null for nearly every row, so the index is partial.
create index if not exists kb_documents_superseded_idx
  on public.kb_documents (superseded_by)
  where superseded_by is not null;

-- ---------------------------------------------------------------------------
-- 2. Retrieval returns the evidence for its own confidence
-- ---------------------------------------------------------------------------
-- The body is the 0058 body — same targets/vec/fts CTEs, same 0.7/0.3 blend,
-- same keyword-only fallback on a null embedding, same intersection with
-- `kb_visible_space_ids` — with columns added to the projection. Nothing about
-- which rows come back, or in what order, moves on the day this ships.
--
-- `vec_score` is null, not 0, when the semantic arm did not run for that row.
-- Zero is a real cosine similarity (an orthogonal passage) and callers now
-- threshold on this number; handing them a 0 that means "not measured" would
-- make every keyword-only result look like a certain miss.
--
-- DROP before CREATE: the return type gains columns and `create or replace`
-- refuses to change an existing function's shape.

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
  metadata jsonb,
  chunk_id uuid,
  vec_score double precision,
  fts_score double precision,
  dated_at timestamptz,
  valid_until timestamptz,
  superseded_by uuid,
  superseded_by_title text
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
    select ch.id as chunk_id, ch.document_id as doc_id, ch.chunk_index as idx,
           ch.content as body, ch.metadata as meta,
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
    select ch.id as chunk_id, ch.document_id as doc_id, ch.chunk_index as idx,
           ch.content as body, ch.metadata as meta,
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
    select coalesce(v.chunk_id, f.chunk_id) as chunk_id,
           coalesce(v.doc_id, f.doc_id) as doc_id,
           coalesce(v.idx, f.idx) as idx,
           coalesce(v.body, f.body) as body,
           coalesce(v.meta, f.meta) as meta,
           v.vec_score as vec_score,
           coalesce(f.fts_score, 0) as fts_score,
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
         coalesce(cb.meta, '{}'::jsonb),
         cb.chunk_id,
         cb.vec_score,
         cb.fts_score,
         -- When the conversation happened beats when the file was uploaded:
         -- a call recorded in March and filed in July is March-old, and a
         -- citation that says "July" would be a lie about how fresh it is.
         coalesce(d.recorded_at, d.created_at),
         d.valid_until,
         d.superseded_by,
         sup.title
  from combined cb
  join public.kb_documents d on d.id = cb.doc_id
  join public.kb_collections s on s.id = d.collection_id
  left join public.kb_documents sup on sup.id = d.superseded_by
  order by cb.blended desc
  limit p_limit;
$$;

comment on function public.kb_search_scoped(uuid, vector, text, int, uuid[]) is
  'Hybrid Knowledge Base search restricted to what p_user_id may see. Query embeddings are voyage-3-large at 1024 dims, produced with input_type "query"; passing a null embedding degrades the call to keyword-only rather than failing it. p_space_ids narrows the result to a subset of the visible spaces and can never widen it. `score` stays the 0.7 semantic / 0.3 keyword blend used for ORDERING; `vec_score` is the raw cosine similarity and is the only number stable enough to threshold on — null there means the semantic arm did not run for that row, which is not the same as a similarity of zero. `dated_at`, `valid_until` and `superseded_by` travel with the hit so a citation can carry its own age instead of being presented as present tense.';

revoke all on function public.kb_search_scoped(uuid, vector, text, int, uuid[]) from public, anon, authenticated;
grant execute on function public.kb_search_scoped(uuid, vector, text, int, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Passages that say almost the same thing from documents of different dates
-- ---------------------------------------------------------------------------
-- The contradiction case in one sentence: the March contract says 8.500 and the
-- July call says 9.200, and today both are cited flat, as equals, with the
-- older one often first because it is worded more like a rate card.
--
-- Vectors already know these two passages belong together — a near neighbour of
-- "the React senior rate is 8.500" is "the React senior rate goes to 9.200",
-- because near-identical wording is exactly what a restatement of the same fact
-- looks like. So this does not search for disagreement (embeddings cannot see
-- negation reliably); it searches for RESTATEMENT, and hands both texts and
-- both dates to the model, which can read.
--
-- WHY IT SEARCHES THE WHOLE CORPUS AND NOT JUST THE RESULT SET. The dangerous
-- case is precisely the one where the other version was NOT retrieved: the
-- question matched the call, the contract sat at rank 40, and the answer went
-- out with total confidence. Comparing the returned chunks against each other
-- would miss it every time. One HNSW probe per source chunk is cheaper than
-- the embedding round-trip the search already paid for.
--
-- NO UPPER BOUND ON SIMILARITY HERE. Two chunks at 0.999 are the same passage
-- stored twice — a re-upload, a signed scan of the same contract — and calling
-- that a contradiction would be the loudest false positive available. That cut
-- is deliberately left to the caller, together with the date gap and the
-- has-the-figure-actually-changed test, because those are judgements worth
-- unit-testing rather than judgements worth burying in a query plan.

create or replace function public.kb_conflict_candidates(
  p_user_id uuid,
  p_chunk_ids uuid[],
  p_min_similarity double precision default 0.86,
  p_per_chunk int default 3
)
returns table (
  source_chunk_id uuid,
  chunk_id uuid,
  document_id uuid,
  document_title text,
  space_name text,
  space_scope kb_scope,
  chunk_index int,
  content text,
  dated_at timestamptz,
  valid_until timestamptz,
  superseded_by uuid,
  similarity double precision
)
language sql
stable
as $$
  with targets as (
    select v.space_id as id from public.kb_visible_space_ids(p_user_id) v
  ),
  sources as (
    -- Re-derived from the visible set rather than trusted: a caller that hands
    -- over a chunk id it was never shown gets nothing back, so this cannot be
    -- turned into a read primitive for somebody else's notes.
    select ch.id, ch.document_id, ch.embedding
    from public.kb_chunks ch
    join public.kb_documents d on d.id = ch.document_id
    where ch.id = any(p_chunk_ids)
      and ch.embedding is not null
      and d.collection_id in (select id from targets)
  ),
  ranked as (
    select s.id as source_chunk_id,
           n.chunk_id,
           n.document_id,
           n.chunk_index,
           n.content,
           n.similarity,
           row_number() over (partition by s.id order by n.similarity desc) as rn
    from sources s
    cross join lateral (
      select ch.id as chunk_id, ch.document_id, ch.chunk_index, ch.content,
             1 - (ch.embedding <=> s.embedding) as similarity
      from public.kb_chunks ch
      join public.kb_documents d2 on d2.id = ch.document_id
      where ch.embedding is not null
        -- Another passage of the SAME document is not a second version of it,
        -- it is the next paragraph.
        and ch.document_id <> s.document_id
        and d2.collection_id in (select id from targets)
      order by ch.embedding <=> s.embedding
      -- Over-fetch before the similarity cut: the index returns neighbours in
      -- distance order, and the ones that survive the cut are always a prefix.
      limit greatest(p_per_chunk * 4, 12)
    ) n
    where n.similarity >= p_min_similarity
  )
  select r.source_chunk_id,
         r.chunk_id,
         r.document_id,
         d.title,
         s.name,
         s.scope,
         r.chunk_index,
         r.content,
         coalesce(d.recorded_at, d.created_at),
         d.valid_until,
         d.superseded_by,
         r.similarity
  from ranked r
  join public.kb_documents d on d.id = r.document_id
  join public.kb_collections s on s.id = d.collection_id
  where r.rn <= p_per_chunk
  order by r.source_chunk_id, r.similarity desc;
$$;

comment on function public.kb_conflict_candidates(uuid, uuid[], double precision, int) is
  'For each chunk in p_chunk_ids, the nearest passages from OTHER documents the same user may see, above p_min_similarity. Near-identical wording across two documents is what a restated fact looks like, so these are candidates for "this was updated" or "these disagree" — not verdicts. The caller still has to rule out exact duplicates (similarity ~1 is the same passage stored twice), documents of the same date, and restatements where no figure actually changed.';

revoke all on function public.kb_conflict_candidates(uuid, uuid[], double precision, int) from public, anon, authenticated;
grant execute on function public.kb_conflict_candidates(uuid, uuid[], double precision, int) to service_role;
