-- Persistent collection workflow. It prepares proposals; the existing action
-- executor is the only component that can send the approved message.
create table public.management_workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  case_id uuid not null unique references public.management_cases(id) on delete cascade,
  user_id uuid not null references public.users(id),
  invoice_id uuid not null references public.document_extractions(id),
  recipient text not null,
  state text not null default 'ready' check(state in ('ready','approval','waiting','review','blocked','cancelled')),
  detail text not null default '',
  action_id uuid references public.actions(id),
  draft_balance numeric,
  evidence jsonb,
  next_check_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_checked_at timestamptz
);
create index management_workflows_due on public.management_workflows(next_check_at) where state in ('ready','approval','waiting');
create table public.management_workflow_events (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  workflow_id uuid not null references public.management_workflows(id) on delete cascade,
  revision integer not null,
  state text not null,
  detail text not null,
  evidence jsonb,
  created_at timestamptz not null default now(),
  unique(workflow_id,revision)
);
alter table public.management_workflows enable row level security;
alter table public.management_workflow_events enable row level security;
revoke all on public.management_workflows,public.management_workflow_events from public,anon,authenticated,service_role;
grant select on public.management_workflows,public.management_workflow_events to service_role;

create function public.management_workflow_start(p_organization_id text,p_actor_id uuid,p_case_id uuid,p_invoice_id uuid,p_recipient text)
returns public.management_workflows language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.management_cases; r public.management_workflows; v_role text;
begin
  select role into v_role from public.users where id=p_actor_id and organization_id=p_organization_id;
  if v_role is null then raise exception 'No perteneces a esta empresa.'; end if;
  select * into c from public.management_cases where id=p_case_id and organization_id=p_organization_id;
  if not found then raise exception 'Asunto no encontrado.'; end if;
  if v_role<>'org_admin' and c.created_by<>p_actor_id and (c.data->>'ownerId')::uuid is distinct from p_actor_id then raise exception 'No puedes iniciar este proceso.'; end if;
  if c.data->>'state' in ('verified','cancelled') then raise exception 'Reabre el asunto antes de iniciar.'; end if;
  if not exists(select 1 from public.document_extractions where id=p_invoice_id and organization_id=p_organization_id and doc_type='invoice' and review_state='confirmed') then raise exception 'Selecciona una factura confirmada de esta empresa.'; end if;
  if length(p_recipient)>320 or p_recipient !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'El correo no es válido.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_case_id::text,0));
  select * into r from public.management_workflows where case_id=p_case_id;
  if found then
    if r.invoice_id<>p_invoice_id or r.recipient<>lower(btrim(p_recipient)) or r.user_id<>p_actor_id then raise exception 'El asunto ya tiene un proceso con otros datos.'; end if;
    return r;
  end if;
  insert into public.management_workflows(organization_id,case_id,user_id,invoice_id,recipient)
    values(p_organization_id,p_case_id,p_actor_id,p_invoice_id,lower(btrim(p_recipient))) returning * into r;
  insert into public.management_workflow_events(organization_id,workflow_id,revision,state,detail)
    values(p_organization_id,r.id,1,'ready','Proceso iniciado; todavía no se ha enviado ningún mensaje.');
  return r;
end;
$$;
create function public.management_workflow_claim(p_organization_id text,p_id uuid,p_token uuid)
returns public.management_workflows language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.management_workflows;
begin
  update public.management_workflows set lease_token=p_token,lease_until=now()+interval '2 minutes'
    where id=p_id and organization_id=p_organization_id and state<>'cancelled' and (lease_until is null or lease_until<now()) returning * into r;
  return r;
end;
$$;
create function public.management_workflow_settle(p_organization_id text,p_id uuid,p_token uuid,p_state text,p_detail text,p_action_id uuid,p_balance numeric,p_evidence jsonb)
returns public.management_workflows language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.management_workflows; v_changed boolean;
begin
  select * into r from public.management_workflows where id=p_id and organization_id=p_organization_id and lease_token=p_token and lease_until>now() for update;
  if not found then raise exception 'Otro proceso tomó el seguimiento. Actualiza la vista.'; end if;
  if p_action_id is not null and not exists(select 1 from public.actions where id=p_action_id and organization_id=p_organization_id and user_id=r.user_id) then raise exception 'Acción fuera del alcance del proceso.'; end if;
  v_changed := r.state is distinct from p_state or r.detail is distinct from p_detail or (r.evidence - 'checkedAt') is distinct from (p_evidence - 'checkedAt');
  update public.management_workflows set state=p_state,detail=p_detail,action_id=p_action_id,draft_balance=p_balance,evidence=p_evidence,
    revision=revision+case when v_changed then 1 else 0 end,updated_at=case when v_changed then now() else updated_at end,
    last_checked_at=now(),next_check_at=now()+interval '15 minutes',lease_token=null,lease_until=null
    where id=r.id returning * into r;
  if v_changed then insert into public.management_workflow_events(organization_id,workflow_id,revision,state,detail,evidence)
    values(p_organization_id,r.id,r.revision,r.state,r.detail,r.evidence); end if;
  return r;
end;
$$;
create function public.management_workflow_cancel(p_organization_id text,p_actor_id uuid,p_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.management_workflows;
begin
  select * into r from public.management_workflows where id=p_id and organization_id=p_organization_id for update;
  if not found or r.user_id<>p_actor_id then raise exception 'Solo quien inició el proceso puede detenerlo.'; end if;
  if r.state='cancelled' then return; end if;
  update public.management_workflows set state='cancelled',detail='Seguimiento detenido por su responsable. Revisa por separado las acciones pendientes.',revision=revision+1,lease_token=null,lease_until=null,updated_at=now() where id=p_id returning * into r;
  insert into public.management_workflow_events(organization_id,workflow_id,revision,state,detail) values(p_organization_id,r.id,r.revision,r.state,r.detail);
end;
$$;
revoke all on function public.management_workflow_start(text,uuid,uuid,uuid,text),public.management_workflow_claim(text,uuid,uuid),public.management_workflow_settle(text,uuid,uuid,text,text,uuid,numeric,jsonb),public.management_workflow_cancel(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.management_workflow_start(text,uuid,uuid,uuid,text),public.management_workflow_claim(text,uuid,uuid),public.management_workflow_settle(text,uuid,uuid,text,text,uuid,numeric,jsonb),public.management_workflow_cancel(text,uuid,uuid) to service_role;
-- Save the balance BEFORE proposing: a crash between proposal and settlement
-- can recover the exact source snapshot without creating another action.
create function public.management_workflow_checkpoint(p_organization_id text,p_id uuid,p_token uuid,p_balance numeric,p_evidence jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.management_workflows set draft_balance=p_balance,evidence=p_evidence
    where id=p_id and organization_id=p_organization_id and lease_token=p_token and lease_until>now() and state<>'cancelled';
  if not found then raise exception 'El proceso perdió su turno. Actualiza antes de continuar.'; end if;
end;
$$;
revoke all on function public.management_workflow_checkpoint(text,uuid,uuid,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.management_workflow_checkpoint(text,uuid,uuid,numeric,jsonb) to service_role;

-- An expired worker may arrive late at proposal insertion. Serialize by origin
-- and reject a second proposal even when the first was approved or dismissed.
create function public.management_guard_collection_proposal()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.management_workflows;
begin
  if new.origin_kind <> 'manual' or new.origin_id is null then return new; end if;
  select * into r from public.management_workflows where id::text=new.origin_id and organization_id=new.organization_id for update;
  if not found then return new; end if;
  if r.state='cancelled' or r.user_id<>new.user_id then raise exception 'El proceso fue detenido o cambió de responsable.'; end if;
  if exists(select 1 from public.actions where organization_id=new.organization_id and origin_kind='manual' and origin_id=new.origin_id) then
    raise exception 'El proceso ya tiene una propuesta.' using errcode='23505';
  end if;
  return new;
end;
$$;
revoke all on function public.management_guard_collection_proposal() from public,anon,authenticated;
create trigger management_collection_proposal_guard before insert on public.actions
for each row execute function public.management_guard_collection_proposal();
