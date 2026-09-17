-- Authorized recurring rules. Leases and final publication share a DB lock,
-- so pausing fences a job that was already extracting or simulating.
create table public.activation_automations (
 id uuid primary key default gen_random_uuid(),
 organization_id text not null references public.ba_organization(id) on delete cascade,
 actor_id uuid not null references public.users(id) on delete cascade,
 source_connection_id uuid not null references public.feed_sources(id) on delete cascade,
 approval_run_id uuid not null,
 name text not null,
 definition jsonb not null,
 approved_schema jsonb not null,
 trigger text not null check(trigger in ('on_change','scheduled')),
 interval_minutes integer not null check(interval_minutes in (60,360,1440,10080)),
 status text not null default 'active' check(status in ('active','paused','needs_review')),
 next_run_at timestamptz not null default now(),
 last_checked_at timestamptz,
 last_fingerprint text,
 last_result jsonb,
 lease_token uuid,
 lease_until timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,actor_id,approval_run_id)
);
create index activation_automations_due on public.activation_automations(next_run_at) where status='active';
alter table public.activation_automations enable row level security;
revoke all on public.activation_automations from public,anon,authenticated;
grant select,insert,update on public.activation_automations to service_role;

create function public.activation_automation_claim(p_organization_id text,p_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.activation_automations;
begin
 select * into a from public.activation_automations where id=p_id and organization_id=p_organization_id for update;
 if not found or a.status<>'active' or a.next_run_at>now() or a.lease_until>now() then return null; end if;
 if not exists(select 1 from public.users u join public.ba_user bu on lower(bu.email)=lower(u.email)
 join public.ba_member bm on bm."userId"=bu.id and bm."organizationId"=u.organization_id
 where u.id=a.actor_id and u.organization_id=p_organization_id)
 or not exists(select 1 from public.feed_sources s where s.id=a.source_connection_id and s.organization_id=p_organization_id and s.actor_id=a.actor_id and s.enabled)
 then
 update public.activation_automations set status='needs_review',last_result='{"message":"Revisa los permisos o la conexión de la fuente."}' where id=a.id;
 return null;
 end if;
 update public.activation_automations set lease_token=gen_random_uuid(),lease_until=now()+interval '15 minutes' where id=a.id returning * into a;
 return to_jsonb(a);
end $$;

create function public.activation_automation_finish(
 p_organization_id text,p_id uuid,p_token uuid,p_fingerprint text,p_result jsonb,
 p_needs_review boolean default false,p_run_id uuid default null
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.activation_automations; r public.activation_runs; outcome jsonb;
begin
 select * into a from public.activation_automations where id=p_id and organization_id=p_organization_id for update;
 if not found or a.status<>'active' or a.lease_token is distinct from p_token or a.lease_until<=now() then raise exception 'La ejecución fue pausada o perdió su turno.'; end if;
 outcome:=p_result;
 if p_run_id is not null then
 select * into r from public.activation_runs where id=p_run_id and organization_id=p_organization_id and actor_id=a.actor_id;
 if not found or r.definition is distinct from a.definition or r.identity_namespace is distinct from 'automation:'||a.id::text then raise exception 'La regla no coincide con la autorización.'; end if;
 perform 1 from public.feed_sources s where s.id=a.source_connection_id and s.organization_id=p_organization_id and s.actor_id=a.actor_id and s.enabled and s.latest_attachment_id=r.source_id for share;
 if not found then raise exception 'La fuente cambió o fue desconectada.'; end if;
 if exists(select 1 from jsonb_array_elements(r.candidates) c where c->>'status'='matched') then
 outcome:=p_result || public.activation_commit_run(p_organization_id,a.actor_id,r.id,r.source_snapshot);
 end if;
 end if;
 update public.activation_automations set
 status=case when p_needs_review then 'needs_review' else 'active' end,
 last_checked_at=now(),last_fingerprint=coalesce(p_fingerprint,last_fingerprint),last_result=outcome,
 next_run_at=now()+make_interval(mins=>a.interval_minutes),lease_token=null,lease_until=null,updated_at=now() where id=a.id;
 return outcome;
end $$;

create function public.feed_source_wake_activations() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.latest_attachment_id is distinct from old.latest_attachment_id then
 update public.activation_automations set next_run_at=now() where source_connection_id=new.id and organization_id=new.organization_id and status='active' and trigger='on_change';
 end if;
 return new;
end $$;
create trigger feed_source_wake_activations after update of latest_attachment_id on public.feed_sources for each row execute function public.feed_source_wake_activations();
revoke all on function public.activation_automation_claim(text,uuid),public.activation_automation_finish(text,uuid,uuid,text,jsonb,boolean,uuid),public.feed_source_wake_activations() from public,anon,authenticated;
grant execute on function public.activation_automation_claim(text,uuid),public.activation_automation_finish(text,uuid,uuid,text,jsonb,boolean,uuid) to service_role;
