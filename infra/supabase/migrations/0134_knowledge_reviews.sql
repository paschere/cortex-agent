create table public.knowledge_reviews (
 id uuid primary key default gen_random_uuid(),
 organization_id text not null references public.ba_organization(id),
 user_id uuid not null references public.users(id),
 left_document uuid not null references public.kb_documents(id) on delete cascade,
 right_document uuid not null references public.kb_documents(id) on delete cascade,
 finding jsonb not null,
 resolution text not null default 'pending' check(resolution in ('pending','left','right','both','context')),
 note text,
 created_at timestamptz not null default now(),
 resolved_at timestamptz,
 check(left_document<>right_document),
 check((resolution='pending' and resolved_at is null) or (resolution<>'pending' and resolved_at is not null and note is not null and length(btrim(note))>=10))
);
alter table public.knowledge_reviews enable row level security;
revoke all on public.knowledge_reviews from public,anon,authenticated;
grant select,insert,update on public.knowledge_reviews to service_role;
create function public.guard_knowledge_review() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from public.users where id=new.user_id and organization_id=new.organization_id)
 or not exists(select 1 from public.kb_documents where id=new.left_document and organization_id=new.organization_id)
 or not exists(select 1 from public.kb_documents where id=new.right_document and organization_id=new.organization_id) then raise exception 'Fuentes fuera de esta empresa.'; end if;
 if tg_op='INSERT' and new.resolution<>'pending' then raise exception 'Una comparación nueva requiere revisión humana.'; end if;
 if tg_op='UPDATE' and (new.id<>old.id or old.resolution<>'pending' or new.finding is distinct from old.finding or new.user_id<>old.user_id or new.organization_id<>old.organization_id or new.left_document<>old.left_document or new.right_document<>old.right_document or new.created_at<>old.created_at) then raise exception 'La evidencia y las revisiones resueltas no se pueden sobrescribir.'; end if;
 return new;
end; $$;
create trigger knowledge_review_guard before insert or update on public.knowledge_reviews for each row execute function public.guard_knowledge_review();
