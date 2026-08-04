-- Knowledge Base embeddings move from Gemini (768 dims) to Voyage AI
-- (voyage-3-large, 1024 dims).
--
-- WHY NOW. Generation has run on Claude since 0053, but embeddings stayed on
-- `gemini-embedding-001` because Anthropic ships no embedding endpoint. The
-- comment in 0053 called re-embedding the whole corpus the reason not to move.
-- That reason has expired in the best possible way: the Gemini key was never
-- provisioned in production, so nothing has been indexed at all. The corpus we
-- were protecting does not exist, and this is the cheapest this migration will
-- ever be. Voyage is the provider Anthropic recommends and retrieves better
-- than the 768-dim slice of Gemini we were requesting.
--
-- WHY THE OLD VECTORS ARE DESTROYED RATHER THAN CONVERTED. A 768-dim Gemini
-- vector and a 1024-dim Voyage vector are not two encodings of the same thing;
-- they are coordinates in unrelated spaces. There is no projection that makes
-- them comparable, and pgvector will not even let them share a column. Left in
-- place they would be rows that can never match any query again — invisible
-- dead weight that looks like a healthy index. So the vectors go and the
-- documents are marked pending, which is a state the product already knows how
-- to resolve.
--
-- WHY THE CHUNK ROWS SURVIVE. Only the `embedding` column is cleared, not the
-- rows. For a note saved through kb.create_document, `kb_chunks.content` is the
-- ONLY copy of the text — there is no upload in storage and no Drive file to
-- re-fetch. Deleting those rows would delete the user's note to save a vector we
-- can regenerate from the text in a second. `embedding is null` becomes the
-- durable, self-describing marker of "indexed but not yet vectorised", which
-- kb-reindex-embeddings drains in batches and which search already tolerates
-- (the full-text arm below still matches such chunks).

-- ---------------------------------------------------------------------------
-- 1. The column changes shape
-- ---------------------------------------------------------------------------
-- Dropped explicitly rather than left to ALTER TYPE's implicit rebuild: an HNSW
-- rebuild over a column whose dimension is changing underneath it is not a
-- graph we want to trust, and rebuilding from empty is instant anyway.
drop index if exists public.kb_chunks_embedding_idx;

-- Nullable is the point, not a relaxation of a constraint. See the header: a
-- chunk with text and no vector is a legitimate, recoverable state; a chunk with
-- a stale vector is not.
alter table public.kb_chunks alter column embedding drop not null;

-- Clear before the type change so the cast has nothing to reject. Every value
-- here is a Gemini vector by definition — the Voyage path did not exist until
-- this migration.
update public.kb_chunks set embedding = null where embedding is not null;

alter table public.kb_chunks
  alter column embedding type vector(1024) using embedding::vector(1024);

comment on column public.kb_chunks.embedding is
  'voyage-3-large at output_dimension 1024, embedded with input_type "document". NULL means the chunk is stored but not yet vectorised — kb-reindex-embeddings fills those in. Anything written here must come from embedDocuments(); a query-side vector in this column silently degrades retrieval for everyone.';

-- ---------------------------------------------------------------------------
-- 2. The index
-- ---------------------------------------------------------------------------
-- Still HNSW with vector_cosine_ops, which is what 0003 already chose, and it
-- is worth restating why rather than leaving it as an accident: IVFFlat has to
-- be trained on a representative sample to pick its lists, and this table is
-- about to go from empty to a real corpus — an IVFFlat built now would be
-- trained on nothing and would need rebuilding at every order of magnitude.
-- HNSW needs no such training, holds recall as rows arrive, and answers faster
-- at the same recall. Cosine because Voyage embeddings are unit-length, so
-- cosine and dot product agree, and the embedder normalises defensively.
create index if not exists kb_chunks_embedding_idx
  on public.kb_chunks using hnsw (embedding vector_cosine_ops);

-- RLS is unchanged and stays as 0008 set it (deny-all; the app reaches these
-- tables with the service role). Restated here because a migration that alters
-- a table's storage should leave no doubt about its access rules.
alter table public.kb_chunks enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Documents go back to pending
-- ---------------------------------------------------------------------------
-- `ready` means "you can find this by asking a question about it". A document
-- whose vectors were just erased is not that, and saying otherwise would make
-- the KB page confidently wrong. `pending` is the honest state and the one the
-- reindex job looks for.
update public.kb_documents d
set status = 'pending',
    error_message = 'Re-embedding with Voyage (voyage-3-large, 1024 dims) after migration 0057.'
where d.status <> 'pending'
  and exists (select 1 from public.kb_chunks c where c.document_id = d.id);

-- ---------------------------------------------------------------------------
-- 4. Search speaks 1024 dimensions — and tolerates having no vector at all
-- ---------------------------------------------------------------------------
-- Two changes to `kb_search_scoped` from 0049, both forced by the switch:
--
--   1. `p_query_embedding` is vector(1024). Postgres does not carry the typmod
--      in a function's signature, so this REPLACES the 0049 definition rather
--      than overloading it — but pgvector still enforces the dimension at call
--      time, so a stray 768-dim caller fails loudly instead of returning
--      nonsense. Any later migration that redefines this function must keep
--      1024 or the KB stops answering.
--   2. The embedding is nullable and the vector arm is skipped when it is null.
--      That covers both halves of the transition: a deployment without a Voyage
--      key still gets keyword search instead of an error, and chunks awaiting
--      re-embedding still match on their text. The scoping guarantee is
--      untouched — the visible set is still derived from p_user_id inside the
--      database and p_space_ids can still only narrow it.
create or replace function public.kb_search_scoped(
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
  score double precision
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
           1 - (ch.embedding <=> p_query_embedding) as vec_score
    from public.kb_chunks ch
    join public.kb_documents d on d.id = ch.document_id
    where d.collection_id in (select id from targets)
      and p_query_embedding is not null
      and ch.embedding is not null
    order by ch.embedding <=> p_query_embedding
    limit p_limit * 4
  ),
  fts as (
    select ch.document_id as doc_id, ch.chunk_index as idx, ch.content as body,
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
    -- Same 0.7 semantic / 0.3 keyword blend as before. When the vector arm is
    -- empty every score is keyword-only and therefore uniformly lower, which is
    -- the truth: a degraded search should not look as confident as a full one.
    select coalesce(v.doc_id, f.doc_id) as doc_id,
           coalesce(v.idx, f.idx) as idx,
           coalesce(v.body, f.body) as body,
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
         cb.blended
  from combined cb
  join public.kb_documents d on d.id = cb.doc_id
  join public.kb_collections s on s.id = d.collection_id
  order by cb.blended desc
  limit p_limit;
$$;

comment on function public.kb_search_scoped(uuid, vector, text, int, uuid[]) is
  'Hybrid Knowledge Base search restricted to what p_user_id may see. Query embeddings are voyage-3-large at 1024 dims, produced with input_type "query"; passing a null embedding degrades the call to keyword-only rather than failing it. p_space_ids narrows the result to a subset of the visible spaces and can never widen it.';

-- The function was replaced in place, so 0049''s grants still stand; re-issued
-- because a migration that touches an entry point should not leave its
-- reachability implied. PostgREST publishes everything in `public` under /rpc/,
-- and this one takes the user id as an argument.
revoke all on function public.kb_search_scoped(uuid, vector, text, int, uuid[]) from public, anon, authenticated;
grant execute on function public.kb_search_scoped(uuid, vector, text, int, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Closing the reindex loop
-- ---------------------------------------------------------------------------
-- The reindex worker embeds chunks, but "is this document searchable again" is
-- a question about the whole document, and answering it from the app would mean
-- pulling every chunk's null-ness over the wire per batch. It is one statement
-- in SQL, so it lives here and the job calls it.
create or replace function public.kb_mark_reindexed_documents()
returns integer
language plpgsql
volatile
as $$
declare
  affected integer;
begin
  update public.kb_documents d
  set status = 'ready',
      error_message = null
  where d.status = 'pending'
    and exists (select 1 from public.kb_chunks c where c.document_id = d.id)
    and not exists (
      select 1 from public.kb_chunks c
      where c.document_id = d.id and c.embedding is null
    );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function public.kb_mark_reindexed_documents() is
  'Flips every pending document whose chunks are now fully vectorised back to ready. Idempotent: running it with nothing to do returns 0. Called by the kb-reindex-embeddings Inngest function after each batch.';

revoke all on function public.kb_mark_reindexed_documents() from public, anon, authenticated;
grant execute on function public.kb_mark_reindexed_documents() to service_role;
