-- What the Knowledge Base already knows about itself.
--
-- WHAT THIS IS FOR. Brain Knowledge has been able to answer questions for a
-- while, but it has never been able to show its own shape: that the call with
-- the customs broker and the tariff sheet somebody filed three months earlier
-- are about the same thing. That relationship is not a feature that has to be
-- built — it already exists, in `kb_chunks.embedding`. Two documents about the
-- same subject are already close together in that 1024-dimensional space, and
-- have been since the day they were indexed. Nobody has ever asked Postgres
-- for it. This function asks.
--
-- WHY A CENTROID. Similarity between two documents could be defined as the
-- best-matching pair of their chunks, which is more faithful and costs
-- chunks(a) × chunks(b) distance computations per pair — for forty documents of
-- thirty chunks each that is over a million. The mean of a document's chunk
-- vectors is one vector per document, computed once, and for "are these two
-- about the same thing" it is the right question anyway: the best-pair measure
-- links a contract to a call because both mention an address in passing, which
-- is exactly the false edge that turns a graph into a hairball.
--
-- WHY THE LIMITS ARE ARGUMENTS AND NOT WISHES. Pair similarity is quadratic. A
-- space with 500 documents is 124,750 comparisons, which is not a thing to do
-- inside a web request that somebody is waiting on from a phone. So the caller
-- says how many documents may be compared (`p_max_documents`, newest first) and
-- how many edges may come back (`p_max_edges`). The defaults — 60 documents,
-- 1,770 pairs, 400 edges — keep the work bounded and small, and the page says
-- out loud when it is showing the newest 60 of something bigger rather than
-- quietly drawing a partial picture as if it were the whole one.
--
-- WHY A THRESHOLD AT ALL. An edge below it is not a weak relationship, it is
-- noise: cosine similarity between any two documents from the same company is
-- rarely near zero, so a graph with no floor connects everything to everything
-- and says nothing. The floor is the caller's, because the right value depends
-- on the corpus, and the page ships 0.6 as a starting point.
--
-- REQUIRES pgvector >= 0.5, for `avg(vector)`. 0057 already pins the embedding
-- column at vector(1024); this only reads it.
--
-- ACCESS. Same posture as 0049 and 0058: the visible-space rule is applied here
-- through `kb_visible_space_ids`, so a caller who passes somebody else's space
-- id gets an empty graph rather than an error — "no relationships" and "not
-- yours" have to look identical, or the response confirms that a private space
-- exists. Execution is service_role only.

create or replace function public.kb_brain_graph(
  p_user_id uuid,
  p_space_ids uuid[] default null,
  p_sources text[] default null,
  p_min_similarity double precision default 0.6,
  p_max_documents int default 60,
  p_max_edges int default 400
)
returns jsonb
language sql
stable
as $$
  with targets as (
    -- The intersection, never the union: p_space_ids narrows what this person
    -- can already see and can never widen it.
    select v.space_id as id
    from public.kb_visible_space_ids(p_user_id) v
    where p_space_ids is null or v.space_id = any(p_space_ids)
  ),
  labelled as (
    -- One name for "where did this come from", matching the four the interface
    -- draws. `source` and `media_kind` disagree on purpose in one case: an
    -- uploaded audio file has source 'audio', and it is a recording to a person
    -- even though nobody recorded it here.
    select d.id,
           d.title,
           d.collection_id,
           d.created_at,
           coalesce(d.speakers, '{}'::text[]) as speakers,
           d.duration_seconds,
           case
             when d.source = 'gdrive' then 'drive'
             when d.source = 'meeting' or d.media_kind = 'meeting' then 'meeting'
             when d.source in ('recording', 'audio') or d.media_kind = 'audio' then 'record'
             else 'upload'
           end as bucket
    from public.kb_documents d
    where d.collection_id in (select id from targets)
      -- Only what is actually retrievable. A document still being indexed has
      -- no vectors, so it has no relationships to show — drawing it as an
      -- unconnected dot would read as "related to nothing", which is a lie
      -- about a document that simply has not been read yet.
      and d.status = 'ready'
  ),
  docs as (
    select *
    from labelled
    where p_sources is null or bucket = any(p_sources)
    order by created_at desc
    limit greatest(p_max_documents, 0)
  ),
  centroids as (
    select ch.document_id as id,
           count(*)::int as chunks,
           avg(ch.embedding)::vector(1024) as centroid
    from public.kb_chunks ch
    join docs on docs.id = ch.document_id
    where ch.embedding is not null
    group by ch.document_id
  ),
  edges as (
    select a.id as a,
           b.id as b,
           1 - (a.centroid <=> b.centroid) as similarity
    from centroids a
    join centroids b on a.id < b.id
    where 1 - (a.centroid <=> b.centroid) >= p_min_similarity
    order by similarity desc
    limit greatest(p_max_edges, 0)
  )
  select jsonb_build_object(
    'nodes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id,
               'title', d.title,
               'source', d.bucket,
               'speakers', to_jsonb(d.speakers),
               'durationSeconds', d.duration_seconds,
               'chunks', coalesce(c.chunks, 0)
             ) order by coalesce(c.chunks, 0) desc, d.created_at desc)
      from docs d left join centroids c on c.id = d.id
    ), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(jsonb_build_object(
               'a', e.a,
               'b', e.b,
               'score', round(e.similarity::numeric, 3)
             ) order by e.similarity desc)
      from edges e
    ), '[]'::jsonb),
    -- What was left out, so the interface can say "the newest 60 of 214"
    -- instead of presenting a slice as the whole.
    'considered', (select count(*)::int from docs),
    'total', (select count(*)::int from labelled where p_sources is null or bucket = any(p_sources))
  );
$$;

comment on function public.kb_brain_graph(uuid, uuid[], text[], double precision, int, int) is
  'The relationship graph of what p_user_id can see: nodes are indexed documents, edges are pairs whose chunk-centroid cosine similarity reaches p_min_similarity. Bounded by p_max_documents (newest first) and p_max_edges because pair similarity is quadratic. Returns `considered` and `total` so a caller can say it is showing a slice.';

-- PostgREST publishes everything in `public` under /rpc/, and this takes the
-- user id as a plain argument, so anything holding an anon key could otherwise
-- ask it for the shape of someone else's private notes.
revoke all on function public.kb_brain_graph(uuid, uuid[], text[], double precision, int, int)
  from public, anon, authenticated;
grant execute on function public.kb_brain_graph(uuid, uuid[], text[], double precision, int, int)
  to service_role;
