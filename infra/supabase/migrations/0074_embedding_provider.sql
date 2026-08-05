-- Embeddings stop being "whatever Voyage model we happened to hardcode", and
-- start being a stated, checkable property of every row.
--
-- WHAT WENT WRONG. This deployment ran `voyage-3-large`, verified today against
-- Voyage's live pricing page as $0.18 per million tokens and — the part that
-- actually hurt — absent from BOTH free-token lists. The 200M complimentary
-- tokens go to voyage-4-large, voyage-4, voyage-4-lite, voyage-context-4 and
-- voyage-code-3; the 50M go to voyage-multilingual-2, voyage-finance-2,
-- voyage-law-2 and voyage-code-2. `voyage-3-large` is in neither. So the
-- deployment was paying, from its very first token, the most expensive rate in
-- the catalogue, and a retry bug in `ingest-document` was multiplying that by up
-- to four. One document exhausted the account.
--
-- The new default is `voyage-4-lite`: $0.02 per million (nine times cheaper),
-- 200 million free tokens, and — the reason it is painless — 1024 output
-- dimensions BY DEFAULT. The HNSW index below is not touched, not rebuilt, not
-- resized. The only cost of the switch is re-embedding what exists, and what
-- exists is almost nothing.
--
-- WHY A COLUMN AND NOT A CONSTANT. `kb_chunks.embedding` has always been a
-- vector with no statement of what produced it, which was survivable only while
-- exactly one model could ever have written it. That stops being true the moment
-- the model is configurable. Two models' vectors are coordinates in unrelated
-- spaces: mixed in one column they do not error, they RANK — a voyage-4-lite
-- query vector will happily find its nearest voyage-3-large neighbour and score
-- it, and the number it returns looks exactly like a real similarity. That is
-- the worst failure mode available to a search engine: confident garbage, which
-- is strictly worse than an empty result. So the model travels on the row, the
-- search filters on it, and the reindexer treats a mismatch as work to do.
--
-- WHY THE EXISTING VECTORS ARE DESTROYED. Same argument as 0057, and the same
-- luck: there is no corpus worth protecting. Every non-null vector in this table
-- was written by voyage-3-large (it was the only code path that ever existed),
-- none of it is comparable to what the new default produces, and leaving it in
-- place would mean rows that can never match a query again while looking like a
-- healthy index. Only the `embedding` column is cleared — never the rows.
-- `kb_chunks.content` is the ONLY copy of the text for anything saved through
-- kb.create_document, and `embedding is null` is already the product's
-- self-describing marker for "stored, not yet vectorised".

-- ---------------------------------------------------------------------------
-- 1. Every vector says what wrote it
-- ---------------------------------------------------------------------------
alter table public.kb_chunks
  add column if not exists embedding_model text;

comment on column public.kb_chunks.embedding_model is
  'The provider-qualified model that produced `embedding`, e.g. "voyage:voyage-4-lite" or "openai:text-embedding-3-small". Written by embedDocuments() and by nothing else. NULL means the chunk has no vector yet. A row whose model differs from the deployment''s configured model is NOT searchable by meaning — kb_search_scoped filters on this column — and is picked up as work by kb-reindex-embeddings. That is the whole mechanism that makes changing providers a re-embed instead of a silent corruption of the index.';

-- ---------------------------------------------------------------------------
-- 2. The old vectors go, the text stays
-- ---------------------------------------------------------------------------
-- Written as a conditional update rather than a blanket one so re-running this
-- migration after the reindexer has done its work is a no-op instead of a
-- second, gratuitous re-embed of the whole corpus.
update public.kb_chunks
set embedding = null,
    embedding_model = null
where embedding is not null
  and embedding_model is null;

-- `ready` means "you can find this by asking a question about it". A document
-- whose vectors were just erased is not that. `pending` is the honest state and
-- the one kb-reindex-embeddings looks for.
update public.kb_documents d
set status = 'pending',
    error_message = 'Re-embedding with the configured model after migration 0074 (default: voyage-4-lite, 1024 dims). Findable by keyword meanwhile.'
where d.status = 'ready'
  and exists (
    select 1 from public.kb_chunks c
    where c.document_id = d.id and c.embedding is null
  );

-- The semantic arm filters by model before it ranks. HNSW cannot carry that
-- predicate inside the graph, so the planner needs a cheap way to know how
-- selective it is; partial because a chunk with no vector is never a candidate.
create index if not exists kb_chunks_embedding_model_idx
  on public.kb_chunks (embedding_model)
  where embedding is not null;

-- Finding the backlog is now "no vector OR the wrong model", and that query runs
-- on a cron every fifteen minutes across the whole install.
create index if not exists kb_chunks_unvectorised_idx
  on public.kb_chunks (id)
  where embedding is null;

-- ---------------------------------------------------------------------------
-- 3. What we spent, when, and on whose document
-- ---------------------------------------------------------------------------
-- NOT a billing system. The thing that made this expensive was not the price per
-- token — it was that nobody found out until the credits ran out. One row per
-- embedding batch, carrying the workspace, the document, the model and the token
-- count the provider itself reported, is the smallest artefact that would have
-- made someone say "why did one upload embed forty thousand tokens?" on day one.
--
-- APPEND-ONLY AND DISPOSABLE. Nothing reads it to make a decision; it exists to
-- be looked at. Truncating it loses no product state.
create table if not exists public.kb_embedding_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  -- Null for work that is not about one document (the tool-selection index).
  document_id uuid references public.kb_documents(id) on delete set null,
  -- Which pipeline paid: 'ingest', 'reindex', 'meeting', 'whatsapp', 'note'.
  source text not null,
  provider text not null,
  model text not null,
  -- Passages sent, requests made, and tokens as the PROVIDER counted them —
  -- falling back to our own estimate when a provider does not report usage.
  texts integer not null default 0,
  requests integer not null default 0,
  tokens integer not null default 0,
  -- True when `tokens` is our estimate rather than the provider's own number.
  tokens_estimated boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.kb_embedding_usage is
  'One row per embedding batch actually paid for. Append-only, advisory, and safe to truncate — it exists so that a runaway embedding cost is visible on the day it happens instead of on the day the credits run out. Not a billing ledger: the token counts are the provider''s where reported and our own estimate otherwise.';

create index if not exists kb_embedding_usage_org_time_idx
  on public.kb_embedding_usage (organization_id, created_at desc);
create index if not exists kb_embedding_usage_document_idx
  on public.kb_embedding_usage (document_id)
  where document_id is not null;

-- Same posture as every other KB table since 0008: deny-all, reached with the
-- service role through the scoped client.
alter table public.kb_embedding_usage enable row level security;
drop policy if exists kb_embedding_usage_deny_all on public.kb_embedding_usage;
create policy kb_embedding_usage_deny_all on public.kb_embedding_usage for all using (false);

revoke all on table public.kb_embedding_usage from public, anon, authenticated;
grant select, insert on table public.kb_embedding_usage to service_role;

-- ---------------------------------------------------------------------------
-- 4. Search refuses to mix spaces
-- ---------------------------------------------------------------------------
-- The 0066 body, unchanged in every respect except one: the semantic arm now
-- requires the caller to say which model produced `p_query_embedding`, and only
-- considers chunks written by that same model.
--
-- WHY THE MODEL IS REQUIRED RATHER THAN OPTIONAL-WITH-A-DEFAULT. An optional
-- filter is a filter somebody will forget, and forgetting it here does not
-- fail — it silently ranks incomparable vectors against each other. So a null
-- `p_embedding_model` disables the semantic arm exactly as a null embedding
-- does, and the call degrades to keyword-only. Degrading is a state the product
-- already handles everywhere; mixing is not a state at all.
--
-- DROP before CREATE: adding a parameter to a Postgres function creates an
-- OVERLOAD rather than replacing it, and leaving the five-argument version
-- reachable would leave the unfiltered path one PostgREST call away.
drop function if exists public.kb_search_scoped(uuid, vector, text, int, uuid[]);
drop function if exists public.kb_search_scoped(uuid, vector, text, int, uuid[], text);

create function public.kb_search_scoped(
  p_user_id uuid,
  p_query_embedding vector(1024),
  p_query_text text,
  p_limit int default 8,
  p_space_ids uuid[] default null,
  p_embedding_model text default null
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
    -- provider key, provider down). A null model means the caller did not say
    -- what produced the vector, which we cannot distinguish from the wrong
    -- model. Either one skips the semantic arm entirely and yields keyword-only
    -- results — a degraded answer, honestly scored — rather than pulling
    -- p_limit*4 arbitrary or incomparable chunks and presenting them as ranked.
    where p_query_embedding is not null
      and p_embedding_model is not null
      and ch.embedding is not null
      and ch.embedding_model = p_embedding_model
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
         -- When the conversation happened beats when the file was uploaded.
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

comment on function public.kb_search_scoped(uuid, vector, text, int, uuid[], text) is
  'Hybrid Knowledge Base search restricted to what p_user_id may see. `p_embedding_model` must name the model that produced `p_query_embedding`; only chunks written by that same model take part in the semantic arm, because vectors from two models are coordinates in unrelated spaces and ranking one against the other returns confident nonsense. A null embedding OR a null model degrades the call to keyword-only rather than failing it. p_space_ids narrows the visible set and can never widen it. `score` is the 0.7/0.3 blend used for ORDERING; `vec_score` is the raw cosine similarity and the only number stable enough to threshold on — null there means the semantic arm did not run for that row.';

revoke all on function public.kb_search_scoped(uuid, vector, text, int, uuid[], text) from public, anon, authenticated;
grant execute on function public.kb_search_scoped(uuid, vector, text, int, uuid[], text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. "Fully vectorised" now means "fully vectorised BY THE CURRENT MODEL"
-- ---------------------------------------------------------------------------
-- Without the argument this function would flip a document to `ready` the
-- moment every chunk had SOME vector — including a document still carrying the
-- previous provider's vectors, which the search above will no longer look at.
-- The document would report itself searchable while being invisible.
drop function if exists public.kb_mark_reindexed_documents();
drop function if exists public.kb_mark_reindexed_documents(text);

create function public.kb_mark_reindexed_documents(p_embedding_model text)
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
      where c.document_id = d.id
        and (c.embedding is null or c.embedding_model is distinct from p_embedding_model)
    );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function public.kb_mark_reindexed_documents(text) is
  'Flips every pending document whose chunks are ALL vectorised with p_embedding_model back to ready. A document still carrying a previous model''s vectors stays pending, because kb_search_scoped will not match those and calling it ready would be a lie. Idempotent: nothing to do returns 0. Called by kb-reindex-embeddings after each pass.';

revoke all on function public.kb_mark_reindexed_documents(text) from public, anon, authenticated;
grant execute on function public.kb_mark_reindexed_documents(text) to service_role;
