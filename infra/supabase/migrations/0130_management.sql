-- Management cases are company-shared operational records, not Brain content.
-- Atomic revision + immutable journal. All mutations go through scoped RPCs.
create table public.management_profiles (
  organization_id text primary key references public.ba_organization(id) on delete cascade,
  data jsonb not null,
  revision integer not null default 1,
  updated_by uuid not null references public.users(id),
  updated_at timestamptz not null default now()
);
create table public.management_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  data jsonb not null,
  revision integer not null default 1,
  created_by uuid not null references public.users(id),
  updated_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (data->>'state' in ('open','working','blocked','review','verified','cancelled')),
  check (length(btrim(data->>'title')) between 1 and 180),
  check (data ?& array['title','state','objective','successCriteria','dueOn','nextReviewOn'])
);
create unique index management_source_once on public.management_cases
  (organization_id, (data->>'sourceKey')) where data->>'sourceKey' is not null;
create index management_cases_queue on public.management_cases
  (organization_id, (data->>'state'), (data->>'dueOn'));
create table public.management_events (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  case_id uuid not null references public.management_cases(id) on delete cascade,
  revision integer not null,
  actor_id uuid not null references public.users(id),
  data jsonb not null,
  created_at timestamptz not null default now(),
  unique(case_id, revision)
);
alter table public.management_profiles enable row level security;
alter table public.management_cases enable row level security;
alter table public.management_events enable row level security;
revoke all on public.management_profiles, public.management_cases, public.management_events from public, anon, authenticated, service_role;
grant select on public.management_profiles, public.management_cases, public.management_events to service_role;

create function public.management_save_case(
  p_organization_id text, p_actor_id uuid, p_id uuid, p_revision integer,
  p_data jsonb, p_human_review boolean default false
) returns public.management_cases
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role text;
  v_old public.management_cases;
  v_row public.management_cases;
  v_state text := p_data->>'state';
  v_owner uuid := (p_data->>'ownerId')::uuid;
  v_dependency uuid := (p_data->>'dependsOn')::uuid;
  v_today text := (now() at time zone 'America/Bogota')::date::text;
begin
  select role into v_role from public.users where id = p_actor_id and organization_id = p_organization_id;
  if v_role is null then raise exception 'No perteneces a esta empresa.'; end if;
  -- Serializes dependency graph edits too: two concurrent edits cannot create a cycle.
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id || ':management', 0));
  if p_id is not null then
    select * into v_old from public.management_cases where id = p_id and organization_id = p_organization_id for update;
    if not found then raise exception 'Asunto no encontrado.'; end if;
    if v_old.revision is distinct from p_revision then raise exception 'El asunto cambió. Actualiza la página antes de guardar.'; end if;
    if v_role <> 'org_admin' and v_old.created_by <> p_actor_id and (v_old.data->>'ownerId')::uuid is distinct from p_actor_id then
      raise exception 'Solo el responsable, el creador o un administrador puede cambiar este asunto.';
    end if;
    if p_data->>'sourceKey' is distinct from v_old.data->>'sourceKey' then raise exception 'La fuente original no se puede cambiar.'; end if;
    if v_old.data->>'state' in ('verified','cancelled') and v_state <> 'open' then raise exception 'Reabre el asunto antes de modificar el cierre.'; end if;
  elsif v_state <> 'open' then raise exception 'Un asunto nuevo empieza por organizar.';
  end if;
  if v_owner is not null and not exists(select 1 from public.users where id = v_owner and organization_id = p_organization_id) then
    raise exception 'El responsable no pertenece a esta empresa.';
  end if;
  if v_state not in ('open','cancelled') and v_owner is null then raise exception 'Asigna un responsable.'; end if;
  if v_state = 'blocked' and coalesce(length(btrim(p_data->>'blocker')),0) = 0 then raise exception 'Explica el bloqueo.'; end if;
  if v_dependency is not null then
    if v_dependency = p_id or not exists(select 1 from public.management_cases where id = v_dependency and organization_id = p_organization_id) then
      raise exception 'La dependencia no es válida.';
    end if;
    if exists(
      with recursive chain as (
        select id, (data->>'dependsOn')::uuid as parent from public.management_cases where id = v_dependency and organization_id = p_organization_id
        union
        select c.id, (c.data->>'dependsOn')::uuid from public.management_cases c join chain on c.id = chain.parent where c.organization_id = p_organization_id
      ) select 1 from chain where id = p_id
    ) then raise exception 'La dependencia crearía un ciclo.'; end if;
    if v_state = 'verified' and not exists(select 1 from public.management_cases where id = v_dependency and organization_id = p_organization_id and data->>'state' = 'verified') then
      raise exception 'Primero verifica el asunto del que depende.';
    end if;
  end if;
  if v_state in ('review','verified') then
    if coalesce(length(btrim(p_data#>>'{evidence,reference}')),0) = 0 or coalesce(length(btrim(p_data#>>'{evidence,observation}')),0) = 0
      or p_data#>>'{evidence,observedOn}' is null or p_data#>>'{evidence,observedOn}' > v_today then
      raise exception 'Falta evidencia válida del resultado.';
    end if;
  end if;
  if v_state = 'verified' and (p_human_review is not true or v_role <> 'org_admin' or v_old.id is null or v_old.data->>'state' <> 'review'
      or coalesce(length(btrim(p_data->>'reviewNote')),0) = 0) then
    raise exception 'El cierre requiere revisión humana de un administrador.';
  end if;
  if v_state = 'cancelled' and coalesce(length(btrim(p_data->>'reviewNote')),0) = 0 then raise exception 'Explica por qué se descarta.'; end if;
  if p_id is null then
    insert into public.management_cases(organization_id, data, created_by, updated_by)
      values(p_organization_id,p_data,p_actor_id,p_actor_id) returning * into v_row;
  else
    update public.management_cases set data=p_data, revision=revision+1, updated_by=p_actor_id, updated_at=now()
      where id=p_id and organization_id=p_organization_id returning * into v_row;
  end if;
  insert into public.management_events(organization_id,case_id,revision,actor_id,data)
    values(p_organization_id,v_row.id,v_row.revision,p_actor_id,p_data);
  return v_row;
end;
$$;
revoke all on function public.management_save_case(text,uuid,uuid,integer,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.management_save_case(text,uuid,uuid,integer,jsonb,boolean) to service_role;

create function public.management_save_profile(p_organization_id text, p_actor_id uuid, p_revision integer, p_data jsonb)
returns public.management_profiles language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.management_profiles;
begin
  if not exists(select 1 from public.users where id=p_actor_id and organization_id=p_organization_id and role='org_admin') then
    raise exception 'Solo un administrador puede configurar la gerencia.';
  end if;
  if p_data->>'escalationOwnerId' is not null and not exists(select 1 from public.users where id=(p_data->>'escalationOwnerId')::uuid and organization_id=p_organization_id) then
    raise exception 'El responsable de escalamiento no pertenece a esta empresa.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id || ':management',0));
  select * into v_row from public.management_profiles where organization_id=p_organization_id for update;
  if coalesce(v_row.revision,0) <> p_revision then raise exception 'La configuración cambió. Actualiza la página.'; end if;
  insert into public.management_profiles(organization_id,data,updated_by) values(p_organization_id,p_data,p_actor_id)
    on conflict(organization_id) do update set data=excluded.data, updated_by=p_actor_id, updated_at=now(), revision=management_profiles.revision+1
    returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.management_save_profile(text,uuid,integer,jsonb) from public, anon, authenticated;
grant execute on function public.management_save_profile(text,uuid,integer,jsonb) to service_role;

-- Keep tenant-specific prompts and team denials; add only this capability.
update public.agents set allowed_tool_ids = array_append(allowed_tool_ids, 'management.*')
where slug = 'cortex' and not ('management.*' = any(allowed_tool_ids)) and not ('*' = any(allowed_tool_ids));

-- User opt-in only. One active/paused daily briefing per person; retries reuse it.
create function public.management_start_daily(p_organization_id text, p_actor_id uuid, p_next_run timestamptz)
returns table(job_id uuid, job_status text) language plpgsql security definer set search_path = public, pg_temp as $$
declare v_agent uuid; v_job uuid; v_status text;
begin
  if not exists(select 1 from public.users where id=p_actor_id and organization_id=p_organization_id) then raise exception 'No perteneces a esta empresa.'; end if;
  if p_next_run is null or p_next_run <= now() or p_next_run > now()+interval '4 days' then raise exception 'Fecha de ejecución inválida.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id || ':daily:' || p_actor_id::text,0));
  select id,status into v_job,v_status from public.scheduled_jobs where organization_id=p_organization_id and user_id=p_actor_id and tool_id='management.daily_brief' and kind='tool' and status in ('active','paused') order by created_at limit 1;
  if v_job is not null then return query select v_job,v_status; return; end if;
  select id into v_agent from public.agents where organization_id=p_organization_id and slug='cortex' and not archived limit 1;
  if v_agent is null then raise exception 'Cortex no está disponible en esta empresa.'; end if;
  insert into public.scheduled_jobs(organization_id,user_id,agent_id,name,kind,tool_id,tool_input,schedule_kind,cron,timezone,next_run_at,allow_unattended_writes,notify_conversation,notify_email)
  values(p_organization_id,p_actor_id,v_agent,'Parte diario de gerencia','tool','management.daily_brief','{}','cron','0 8 * * 1-5','America/Bogota',p_next_run,false,true,false) returning id into v_job;
  return query select v_job,'active'::text;
end;
$$;
revoke all on function public.management_start_daily(text,uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.management_start_daily(text,uuid,timestamptz) to service_role;
