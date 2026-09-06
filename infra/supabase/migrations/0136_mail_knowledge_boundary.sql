-- Mail scanning is consultation, never implicit knowledge ingestion.
create table public.mail_policies (
 organization_id text not null references public.ba_organization(id),
 user_id uuid primary key references public.users(id), data jsonb not null,
 updated_at timestamptz not null default now()
);
-- Preserve previously authorized follow-up while stopping bulk knowledge ingestion.
insert into public.mail_policies(organization_id,user_id,data)
 select organization_id,user_id,jsonb_build_object('labels','[]'::jsonb,'senders','[]'::jsonb,'alerts',true,'replies',true,'learning',false) from public.gmail_sync_state;
create table public.mail_consulted_threads (
 organization_id text not null references public.ba_organization(id),
 user_id uuid not null references public.users(id), thread_id text not null,
 fingerprint text not null, consulted_at timestamptz not null default now(), primary key(user_id,thread_id)
);
create table public.mail_learning_proposals (
 id uuid primary key default gen_random_uuid(), organization_id text not null references public.ba_organization(id),
 user_id uuid not null references public.users(id), thread_id text not null, fingerprint text not null,
 draft jsonb not null, state text not null default 'pending' check(state in ('pending','approved','case_only','discarded')),
 created_at timestamptz not null default now(), reviewed_at timestamptz, review_note text, document_id uuid references public.kb_documents(id),
 unique(user_id,thread_id,fingerprint)
);
alter table public.mail_policies enable row level security;
alter table public.mail_consulted_threads enable row level security;
alter table public.mail_learning_proposals enable row level security;
revoke all on public.mail_policies,public.mail_consulted_threads,public.mail_learning_proposals from public,anon,authenticated;
grant select,insert,update,delete on public.mail_policies,public.mail_consulted_threads to service_role;
grant select,insert on public.mail_learning_proposals to service_role;
revoke update,delete on public.mail_learning_proposals from service_role;
create index mail_learning_owner on public.mail_learning_proposals(organization_id,user_id,created_at desc);
create function public.mail_review_learning(p_organization_id text,p_user_id uuid,p_id uuid,p_decision text,p_note text,p_content text,p_space_id uuid,p_title text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_proposal public.mail_learning_proposals; v_document uuid; v_scope public.kb_scope; v_scope_id uuid; v_role text; v_body text;
begin
 select role into v_role from public.users where id=p_user_id and organization_id=p_organization_id;
 if v_role is null then raise exception 'No perteneces a esta empresa.'; end if;
 select * into v_proposal from public.mail_learning_proposals where id=p_id and organization_id=p_organization_id and user_id=p_user_id for update;
 if not found then raise exception 'Propuesta no encontrada.'; end if;
 if v_proposal.state<>'pending' then raise exception 'La propuesta ya fue revisada.'; end if;
 if p_decision not in ('approved','case_only','discarded') or p_decision is null then raise exception 'Decisión inválida.'; end if;
 if coalesce(length(btrim(p_note)),0)<10 then raise exception 'Explica el criterio de tu decisión.'; end if;
 if p_decision='approved' then
  if coalesce(length(btrim(p_title)),0) not between 3 and 160 then raise exception 'Revisa el título que vas a compartir.'; end if;
  if coalesce(length(btrim(p_content)),0) not between 20 and 5000 then raise exception 'Revisa el conocimiento que vas a guardar.'; end if;
  select scope,scope_id into v_scope,v_scope_id from public.kb_collections where id=p_space_id and organization_id=p_organization_id;
  if not found or (v_scope='user' and v_scope_id is distinct from p_user_id) or (v_scope='global' and v_role<>'org_admin') or coalesce(public.kb_space_level(p_user_id,p_space_id),'none') not in ('contribute','admin') then raise exception 'No puedes publicar en ese espacio.'; end if;
  -- Only the edited knowledge is shared. Private email excerpts never leave the review inbox.
  v_body:=p_content || E'\n\nConfirmado el ' || now()::date || E'. Criterio: ' || p_note || E'\nOrigen: aprendizaje de correo revisado por ' || p_user_id::text || '. Referencia privada: ' || v_proposal.id::text;
  insert into public.kb_documents(organization_id,collection_id,source,title,mime,uploaded_by,status,sha256)
   values(p_organization_id,p_space_id,'upload',p_title,'text/markdown',p_user_id,'pending',encode(sha256(convert_to(v_body,'UTF8')),'hex')) returning id into v_document;
  insert into public.kb_chunks(document_id,chunk_index,content,tokens,metadata)
   values(v_document,0,v_body,ceil(length(v_body)::numeric/4)::integer,jsonb_build_object('kind','reviewed_mail_learning','reviewed_by',p_user_id,'reviewed_at',now()));
 end if;
 update public.mail_learning_proposals set state=p_decision,reviewed_at=now(),review_note=p_note,document_id=v_document where id=p_id;
 return v_document;
end; $$;
revoke all on function public.mail_review_learning(text,uuid,uuid,text,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.mail_review_learning(text,uuid,uuid,text,text,text,uuid,text) to service_role;

-- Existing archives remain readable in their spaces, but stop entering default retrieval.
alter table public.kb_documents add column mail_reference boolean not null default false;
update public.kb_documents set mail_reference=true where source='gmail';
create function public.mail_reference_on_insert() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin if new.source='gmail' then new.mail_reference:=true; end if; return new; end; $$;
create trigger mail_reference_on_insert before insert on public.kb_documents for each row execute function public.mail_reference_on_insert();


create or replace function public.kb_search_scoped(
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
      and not d.mail_reference
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
    where not d.mail_reference and d.collection_id in (select id from targets)
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
