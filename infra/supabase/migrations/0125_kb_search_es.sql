-- ===========================================================================
-- LA BÚSQUEDA APRENDE ESPAÑOL
-- ===========================================================================
--
-- LO QUE ESTABA MAL, Y LLEVABA ASÍ DESDE LA 0003. La mitad por palabras de la
-- búsqueda híbrida usaba la configuración `simple`, que es la que NO sabe ningún
-- idioma: no quita acentos, no reduce a la raíz y no conoce las palabras vacías.
-- En un corpus en español eso significa, literalmente, esto:
--
--     buscar «facturación»  no encuentra  «facturacion»
--     buscar «facturación»  no encuentra  «facturar», «facturas», «facturado»
--     buscar «¿cuál es la tarifa de bodegaje?»
--         exige que el pasaje contenga «cuál», «es», «la» y «de»
--
-- La última es la peor y explica por qué la mitad por palabras aportaba tan
-- poco: `plainto_tsquery` une los términos con Y, así que una pregunta escrita
-- como la escribe una persona sólo casa con un pasaje que traiga TODAS sus
-- palabras vacías. Con `simple` no hay palabras vacías — son términos como
-- cualquier otro — de modo que cuanto más natural la pregunta, menos
-- probabilidad de encontrar nada.
--
-- El resultado neto es que la búsqueda venía apoyándose casi sólo en el
-- significado (el arm vectorial), y la mitad por palabras —la que encuentra un
-- número de contrato, un NIT, un nombre propio, una referencia exacta, todo eso
-- que un embedding difumina— estaba de adorno.
--
-- ---------------------------------------------------------------------------
-- QUÉ SE HACE
-- ---------------------------------------------------------------------------
-- Una configuración de búsqueda propia, `es_unaccent`: español (raíces y
-- palabras vacías) más `unaccent` (acentos y diéresis). Y del lado de la
-- pregunta, `websearch_to_tsquery` en vez de `plainto_tsquery`, que además de
-- limpiar entiende comillas para una frase exacta y `-palabra` para excluirla —
-- lo que la gente ya escribe en un buscador sin que nadie se lo enseñe.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ SE BORRA EL ÍNDICE VIEJO
-- ---------------------------------------------------------------------------
-- Un índice GIN se paga en cada escritura, y desde esta migración NADIE consulta
-- ya `to_tsvector('simple', content)`: la única función que lo hacía es la que
-- se reescribe aquí abajo (se comprobó una por una: 0012, 0049, 0057, 0058 y
-- 0066 son versiones sucesivas de la MISMA función). Dejarlo sería pagar cada
-- ingesta por un índice que no responde ninguna consulta.
--
-- ---------------------------------------------------------------------------
-- Y DE PASO: EL RESULTADO DICE SI EL ESPACIO ES DE TODOS
-- ---------------------------------------------------------------------------
-- Desde la 0123 un espacio de la organización puede estar repartido a unos
-- equipos en vez de abierto a la empresa entera, y esa diferencia cambia lo que
-- se puede HACER con lo que se encuentra: citar delante de alguien material de
-- un espacio que esa persona no ve es filtrarlo. El resultado de la búsqueda
-- tenía `space_scope`, que no distingue los dos casos. Ahora lleva también
-- `space_everyone`, y con las dos columnas el llamador arma las tres clases que
-- ya usa el producto: común, repartido y propio.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Español, sin acentos
-- ---------------------------------------------------------------------------
create extension if not exists unaccent;

-- `do` y no un `create ... if not exists`, que para configuraciones de búsqueda
-- no existe. Idempotente igual: correr la migración dos veces no falla.
do $$
begin
  if not exists (
    select 1 from pg_ts_config c
    join pg_namespace n on n.oid = c.cfgnamespace
    where c.cfgname = 'es_unaccent' and n.nspname = 'public'
  ) then
    create text search configuration public.es_unaccent (copy = spanish);
    -- El orden importa: primero se quitan los acentos, y sólo entonces se
    -- reduce a la raíz. Al revés, `spanish_stem` vería «facturación» y
    -- «facturacion» como dos palabras distintas y ya no habría nada que unir.
    alter text search configuration public.es_unaccent
      alter mapping for hword, hword_part, word
      with unaccent, spanish_stem;
  end if;
end$$;

comment on text search configuration public.es_unaccent is
  'Español con acentos plegados: unaccent y luego spanish_stem, en ese orden. Es la configuración con la que se indexa y se consulta kb_chunks (migración 0125). Cambiarla obliga a reconstruir kb_chunks_content_es_idx, porque el índice guarda el resultado de aplicarla.';

-- ---------------------------------------------------------------------------
-- 2. El índice
-- ---------------------------------------------------------------------------
-- El literal va cualificado con el esquema a propósito: `to_tsvector(regconfig,
-- text)` es inmutable —requisito para indexar una expresión— sólo si la
-- configuración se nombra explícitamente. Sin `public.` dependería de
-- `search_path`, que es exactamente el tipo de dependencia que un índice no
-- puede tener.
create index if not exists kb_chunks_content_es_idx
  on public.kb_chunks using gin (to_tsvector('public.es_unaccent', content));

drop index if exists public.kb_chunks_content_fts_idx;

-- ---------------------------------------------------------------------------
-- 3. La búsqueda
-- ---------------------------------------------------------------------------
-- Idéntica a la de la 0074 salvo en dos sitios: el arm por palabras habla
-- español, y la fila dice si el espacio está abierto a toda la empresa.
--
-- DROP antes de CREATE: cambia el tipo de retorno, y `create or replace` no
-- puede con eso.
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
  space_everyone boolean,
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
    -- La intersección es toda la garantía: p_space_ids filtra este conjunto, no
    -- lo define. Y `kb_visible_space_ids` ya incluye las concesiones de la 0123,
    -- así que los permisos por equipo llegan aquí sin que esta función lo sepa.
    select v.space_id as id
    from public.kb_visible_space_ids(p_user_id) v
    where p_space_ids is null or v.space_id = any(p_space_ids)
  ),
  q as (
    -- Una sola vez, y no una por fila: `websearch_to_tsquery` se evalúa igual
    -- para todas, y dejarlo dentro del WHERE lo repite en cada comparación.
    select websearch_to_tsquery('public.es_unaccent', coalesce(p_query_text, '')) as tsq
  ),
  vec as (
    select ch.id as chunk_id, ch.document_id as doc_id, ch.chunk_index as idx,
           ch.content as body, ch.metadata as meta,
           1 - (ch.embedding <=> p_query_embedding) as vec_score
    from public.kb_chunks ch
    join public.kb_documents d on d.id = ch.document_id
    -- Un embedding nulo quiere decir que el llamador no pudo convertir la
    -- pregunta en vector; un modelo nulo, que no dijo cuál la produjo, que no
    -- se distingue de que dijera el equivocado. Cualquiera de los dos salta el
    -- arm semántico entero y devuelve sólo coincidencias por palabra — una
    -- respuesta degradada y honestamente puntuada — en vez de sacar p_limit*4
    -- trozos arbitrarios y presentarlos como ordenados.
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
           ts_rank(to_tsvector('public.es_unaccent', ch.content), q.tsq) as fts_score
    from public.kb_chunks ch
    join public.kb_documents d on d.id = ch.document_id
    cross join q
    where d.collection_id in (select id from targets)
      -- Una pregunta que se queda en nada al quitarle las palabras vacías
      -- («¿y eso?») produce una tsquery VACÍA — no nula — que no casa con
      -- ninguna fila. Se descarta explícitamente para no recorrer el índice
      -- buscando algo que por construcción no está, y porque el comportamiento
      -- correcto ya lo da el otro arm: el significado sigue contestando.
      and q.tsq::text <> ''
      and to_tsvector('public.es_unaccent', ch.content) @@ q.tsq
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
         s.everyone,
         cb.idx,
         cb.body,
         cb.blended,
         coalesce(cb.meta, '{}'::jsonb),
         cb.chunk_id,
         cb.vec_score,
         cb.fts_score,
         -- Cuándo pasó la conversación gana a cuándo se subió el archivo.
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
  'Búsqueda híbrida en Brain Knowledge, acotada a lo que p_user_id puede ver. El arm por palabras usa la configuración `es_unaccent` (español con acentos plegados) y `websearch_to_tsquery`, así que «facturacion» encuentra «facturación» y una pregunta escrita en lenguaje natural ya no exige que el pasaje contenga sus palabras vacías (migración 0125). `p_embedding_model` debe nombrar el modelo que produjo `p_query_embedding`; sólo los trozos escritos por ese mismo modelo participan en el arm semántico, porque vectores de dos modelos son coordenadas de espacios distintos y compararlos devuelve tonterías con aplomo. Un embedding nulo O un modelo nulo degradan la llamada a sólo palabras en vez de hacerla fallar. p_space_ids acota el conjunto visible y no puede ampliarlo. `score` es la mezcla 0.7/0.3 que ORDENA; `vec_score` es el coseno crudo y el único número estable para poner un umbral. `space_everyone` distingue un espacio abierto a toda la empresa de uno repartido a unos equipos (0123).';

revoke all on function public.kb_search_scoped(uuid, vector, text, int, uuid[], text) from public, anon, authenticated;
grant execute on function public.kb_search_scoped(uuid, vector, text, int, uuid[], text) to service_role;
