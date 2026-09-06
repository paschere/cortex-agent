-- One company-owned management cycle, linked to existing goals and cases.
create table public.management_operations (
 id uuid primary key default gen_random_uuid(), organization_id text not null references public.ba_organization(id),
 data jsonb not null, state text not null default 'active' check(state in ('active','paused','completed','cancelled')),
 revision integer not null default 1, created_by uuid not null references public.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index management_operation_running on public.management_operations(organization_id) where state in ('active','paused');
create table public.management_operation_events (
 id uuid primary key default gen_random_uuid(), organization_id text not null references public.ba_organization(id),
 operation_id uuid not null references public.management_operations(id), revision integer not null,
 actor_id uuid not null references public.users(id), kind text not null, data jsonb not null, created_at timestamptz not null default now(),
 unique(operation_id,revision)
);
alter table public.management_operations enable row level security;
alter table public.management_operation_events enable row level security;
revoke all on public.management_operations,public.management_operation_events from public,anon,authenticated,service_role;
grant select on public.management_operations,public.management_operation_events to service_role;
create function public.management_operate(p_organization_id text,p_actor_id uuid,p_id uuid,p_revision integer,p_command jsonb)
returns public.management_operations language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_role text; v_op public.management_operations; v_kind text:=p_command->>'kind'; v_data jsonb:=p_command;
 v_plan jsonb; v_case public.management_cases; v_decision public.management_operation_events;
 v_today date:=(now() at time zone 'America/Bogota')::date; v_day integer; v_id uuid;
begin
 select role into v_role from public.users where id=p_actor_id and organization_id=p_organization_id;
 if v_role is null then raise exception 'No perteneces a esta empresa.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id||':management',0));
 if v_kind in ('pause','resume','cancel','complete','resolve','progress') and coalesce(length(btrim(p_command->>'note')),0)<10 then raise exception 'Explica el motivo o avance.'; end if;
 if v_kind='checkpoint' and (coalesce(length(btrim(p_command#>>'{checkpoint,measurement}')),0)<10 or coalesce(length(btrim(p_command#>>'{checkpoint,evidence}')),0)=0 or coalesce(length(btrim(p_command#>>'{checkpoint,lesson}')),0)<10) then raise exception 'Faltan medición, evidencia o aprendizaje.'; end if;
 if v_kind='create' then
  if v_role<>'org_admin' then raise exception 'Solo un administrador puede acordar la operación.'; end if;
  if exists(select 1 from public.management_operations where organization_id=p_organization_id and state in ('active','paused')) then raise exception 'Ya hay un ciclo abierto. Revísalo antes de iniciar otro.'; end if;
  v_plan:=p_command->'plan';
  if not (v_plan ?& array['name','outcome','measurement','baseline','target','source','boundaries','ownerId','startOn','caseIds']) then raise exception 'El acuerdo está incompleto.'; end if;
  if jsonb_typeof(v_plan->'caseIds') is distinct from 'array' or jsonb_array_length(v_plan->'caseIds') not between 1 and 30 then raise exception 'Vincula entre 1 y 30 asuntos.'; end if;
  if not exists(select 1 from public.users where id=(v_plan->>'ownerId')::uuid and organization_id=p_organization_id) then raise exception 'El responsable no pertenece a esta empresa.'; end if;
  if v_plan->>'goalId' is not null and not exists(select 1 from public.goals where id=(v_plan->>'goalId')::uuid and organization_id=p_organization_id and state='active') then raise exception 'La meta no está activa en esta empresa.'; end if;
  for v_id in select value::uuid from jsonb_array_elements_text(v_plan->'caseIds') loop
   if not exists(select 1 from public.management_cases where id=v_id and organization_id=p_organization_id and data->>'state' not in ('verified','cancelled')) then raise exception 'Cada asunto debe estar abierto en esta empresa.'; end if;
  end loop;
  if (v_plan->>'startOn')::date < v_today or (v_plan->>'startOn')::date > v_today+30 then raise exception 'El inicio debe estar entre hoy y los próximos 30 días.'; end if;
  insert into public.management_operations(organization_id,data,created_by) values(p_organization_id,v_plan,p_actor_id) returning * into v_op;
 else
  select * into v_op from public.management_operations where id=p_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Operación no encontrada.'; end if;
  if v_op.revision is distinct from p_revision then raise exception 'La operación cambió. Actualiza antes de guardar.'; end if;
  if v_op.state in ('completed','cancelled') then raise exception 'El ciclo ya terminó; su historial permanece cerrado.'; end if;
  if v_kind in ('pause','resume','cancel','complete','checkpoint','resolve') and v_role<>'org_admin' then raise exception 'Esta decisión requiere a un administrador.'; end if;
  if v_op.state='paused' and v_kind not in ('resume','cancel') then raise exception 'Reanuda el ciclo antes de registrar actividad.'; end if;
  if v_kind='pause' then v_op.state:='paused';
  elsif v_kind='resume' then v_op.state:='active';
  elsif v_kind='cancel' then v_op.state:='cancelled';
  elsif v_kind='decision' then
   if jsonb_typeof(p_command#>'{decision,options}') is distinct from 'array' or jsonb_array_length(p_command#>'{decision,options}') not between 2 and 4 then raise exception 'Una decisión necesita entre dos y cuatro alternativas.'; end if;
  elsif v_kind='resolve' then
   select * into v_decision from public.management_operation_events where id=(p_command->>'decisionId')::uuid and operation_id=v_op.id and organization_id=p_organization_id and kind='decision';
   if not found then raise exception 'La decisión no pertenece a este ciclo.'; end if;
   if exists(select 1 from public.management_operation_events where operation_id=v_op.id and kind='resolve' and data->>'decisionId'=v_decision.id::text) then raise exception 'La decisión ya tiene veredicto.'; end if;
   if (p_command->>'option')::integer < 0 or (p_command->>'option')::integer >= jsonb_array_length(v_decision.data#>'{decision,options}') then raise exception 'La alternativa no existe.'; end if;
  elsif v_kind='checkpoint' then
   v_day:=(p_command#>>'{checkpoint,day}')::integer;
   if v_day is null or v_day not in (7,14,21,30) or v_today < (v_op.data->>'startOn')::date+v_day-1 then raise exception 'Este punto de revisión todavía no corresponde.'; end if;
   if exists(select 1 from public.management_operation_events where operation_id=v_op.id and kind='checkpoint' and data#>>'{checkpoint,day}'=v_day::text) then raise exception 'Este punto ya fue revisado. Consulta su historial.'; end if;
  elsif v_kind='progress' then
   if not (v_op.data->'caseIds' ? (p_command->>'caseId')) then raise exception 'El asunto no está vinculado al ciclo.'; end if;
   select * into v_case from public.management_cases where id=(p_command->>'caseId')::uuid and organization_id=p_organization_id;
   if not found or v_case.data->>'ownerId' is distinct from p_actor_id::text then raise exception 'Solo el responsable puede registrar su avance.'; end if;
   if v_case.data->>'state' not in ('open','working','blocked') then raise exception 'Este asunto necesita revisión en su ficha.'; end if;
   if p_command->>'status' not in ('accepted','progress','blocked') then raise exception 'Avance inválido.'; end if;
   if (p_command->>'nextReviewOn')::date < v_today then raise exception 'Acuerda una revisión desde hoy.'; end if;
   select * into v_case from public.management_save_case(p_organization_id,p_actor_id,v_case.id,(p_command->>'caseRevision')::integer,
    v_case.data || jsonb_build_object('state',case when p_command->>'status'='blocked' then 'blocked' else 'working' end,'blocker',case when p_command->>'status'='blocked' then p_command->>'note' else '' end,'nextAction',p_command->>'note','nextReviewOn',p_command->>'nextReviewOn'),false);
   v_data:=p_command || jsonb_build_object('caseRevisionAfter',v_case.revision);
  elsif v_kind='complete' then
   if (select count(distinct data#>>'{checkpoint,day}') from public.management_operation_events where operation_id=v_op.id and kind='checkpoint')<4 then raise exception 'Completa las cuatro revisiones con evidencia antes de cerrar.'; end if;
   for v_id in select value::uuid from jsonb_array_elements_text(v_op.data->'caseIds') loop
    if not exists(select 1 from public.management_cases where id=v_id and organization_id=p_organization_id and data->>'state'='verified') then raise exception 'Todavía hay asuntos sin cierre verificado.'; end if;
   end loop;
   if exists(select 1 from public.management_operation_events d where d.operation_id=v_op.id and d.kind='decision' and not exists(select 1 from public.management_operation_events r where r.operation_id=v_op.id and r.kind='resolve' and r.data->>'decisionId'=d.id::text)) then raise exception 'Resuelve las decisiones pendientes.'; end if;
   v_op.state:='completed';
  else raise exception 'Acción desconocida.';
  end if;
  update public.management_operations set state=v_op.state,revision=revision+1,updated_at=now() where id=v_op.id returning * into v_op;
 end if;
 insert into public.management_operation_events(organization_id,operation_id,revision,actor_id,kind,data) values(p_organization_id,v_op.id,v_op.revision,p_actor_id,v_kind,v_data);
 return v_op;
end; $$;
revoke all on function public.management_operate(text,uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.management_operate(text,uuid,uuid,integer,jsonb) to service_role;
