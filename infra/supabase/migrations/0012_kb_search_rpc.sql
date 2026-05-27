-- Hybrid search: cosine similarity (0.7 weight) + full-text rank (0.3 weight)
create or replace function public.kb_hybrid_search(
  p_collection_ids uuid[],
  p_query_embedding vector(768),
  p_query_text text,
  p_limit int default 8
)
returns table (
  document_id uuid,
  document_title text,
  chunk_index int,
  content text,
  score double precision
)
language sql stable as $$
  with vec as (
    select c.document_id, c.chunk_index, c.content,
           1 - (c.embedding <=> p_query_embedding) as vec_score
    from public.kb_chunks c
    join public.kb_documents d on d.id = c.document_id
    where d.collection_id = any(p_collection_ids)
    order by c.embedding <=> p_query_embedding
    limit p_limit * 4
  ),
  fts as (
    select c.document_id, c.chunk_index, c.content,
           ts_rank(to_tsvector('simple', c.content),
                   plainto_tsquery('simple', p_query_text)) as fts_score
    from public.kb_chunks c
    join public.kb_documents d on d.id = c.document_id
    where d.collection_id = any(p_collection_ids)
      and to_tsvector('simple', c.content) @@ plainto_tsquery('simple', p_query_text)
    order by fts_score desc
    limit p_limit * 4
  ),
  combined as (
    select coalesce(v.document_id, f.document_id) as document_id,
           coalesce(v.chunk_index, f.chunk_index) as chunk_index,
           coalesce(v.content, f.content) as content,
           coalesce(v.vec_score, 0) * 0.7 + coalesce(f.fts_score, 0) * 0.3 as score
    from vec v
    full outer join fts f
      on v.document_id = f.document_id and v.chunk_index = f.chunk_index
  )
  select c.document_id, d.title as document_title, c.chunk_index, c.content, c.score
  from combined c
  join public.kb_documents d on d.id = c.document_id
  order by c.score desc
  limit p_limit;
$$;
