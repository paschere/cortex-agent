-- Connector health and authenticated change notifications. Payloads never
-- become knowledge or business actions: an event only advances due reviews.
alter table public.feed_sources
 add column freshness_minutes integer not null default 1440 check(freshness_minutes between 5 and 43200),
 add column webhook_token_hash text check(webhook_token_hash is null or webhook_token_hash ~ '^[a-f0-9]{64}$'),
 add column webhook_enabled boolean not null default false,
 add column last_webhook_at timestamptz,
 add column signal_revision bigint not null default 0;
create table public.feed_source_signals (
 organization_id text not null references public.ba_organization(id) on delete cascade,
 source_id uuid not null references public.feed_sources(id) on delete cascade,
 event_id text not null check(length(event_id) between 1 and 128),
 received_at timestamptz not null default now(),
 primary key(organization_id,source_id,event_id)
);
alter table public.feed_source_signals enable row level security;
revoke all on public.feed_source_signals from public,anon,authenticated;
grant select,insert,delete on public.feed_source_signals to service_role;

create function public.feed_source_signal(p_organization_id text,p_source_id uuid,p_token_hash text,p_event_id text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.feed_sources; inserted integer; coalesced boolean;
begin
 select * into s from public.feed_sources where id=p_source_id and organization_id=p_organization_id for update;
 if not found or not s.enabled or not s.webhook_enabled or s.webhook_token_hash is null or s.webhook_token_hash is distinct from p_token_hash then return null; end if;
 if not exists(select 1 from public.users u join public.ba_user bu on lower(bu.email)=lower(u.email)
 join public.ba_member bm on bm."userId"=bu.id and bm."organizationId"=u.organization_id
 where u.id=s.actor_id and u.organization_id=p_organization_id) then return null; end if;
 delete from public.feed_source_signals where source_id=s.id and organization_id=p_organization_id and received_at<now()-interval '7 days';
 insert into public.feed_source_signals(organization_id,source_id,event_id) values(p_organization_id,s.id,p_event_id) on conflict do nothing;
 get diagnostics inserted=row_count;
 if inserted=0 then return jsonb_build_object('duplicate',true,'coalesced',true); end if;
 coalesced:=s.last_webhook_at is not null and s.last_webhook_at>now()-interval '1 minute';
 update public.feed_sources set last_webhook_at=now(),signal_revision=signal_revision+1 where id=s.id;
 update public.activation_automations set next_run_at=now() where source_connection_id=s.id and organization_id=p_organization_id and actor_id=s.actor_id and status='active';
 return jsonb_build_object('duplicate',false,'coalesced',coalesced);
end $$;
revoke all on function public.feed_source_signal(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.feed_source_signal(text,uuid,text,text) to service_role;

-- An event arriving while a review runs must survive its completion; fence
-- against the revision read before fetching, not the HTTP completion time.
alter function public.activation_automation_finish(text,uuid,uuid,text,jsonb,boolean,uuid) rename to activation_automation_finish_v1;
revoke all on function public.activation_automation_finish_v1(text,uuid,uuid,text,jsonb,boolean,uuid) from public,anon,authenticated,service_role;
create function public.activation_automation_finish(
 p_organization_id text,p_id uuid,p_token uuid,p_fingerprint text,p_result jsonb,
 p_needs_review boolean default false,p_run_id uuid default null,p_source_revision bigint default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare outcome jsonb;
begin
 -- Keep the same source -> automation lock order as change notifications.
 perform 1 from public.feed_sources s where s.organization_id=p_organization_id
 and s.id=(select a.source_connection_id from public.activation_automations a where a.id=p_id and a.organization_id=p_organization_id) for share;
 outcome:=public.activation_automation_finish_v1(p_organization_id,p_id,p_token,p_fingerprint,p_result,p_needs_review,p_run_id);
 if p_source_revision is not null then
 update public.activation_automations a set next_run_at=now()
 from public.feed_sources s where a.id=p_id and a.organization_id=p_organization_id and a.status='active'
 and s.id=a.source_connection_id and s.organization_id=a.organization_id and s.enabled and s.signal_revision>p_source_revision;
 end if;
 return outcome;
end $$;
revoke all on function public.activation_automation_finish(text,uuid,uuid,text,jsonb,boolean,uuid,bigint) from public,anon,authenticated;
grant execute on function public.activation_automation_finish(text,uuid,uuid,text,jsonb,boolean,uuid,bigint) to service_role;

-- Propagate only through the current capture. Historical dependencies cannot
-- wake unrelated rules. Combined sources cannot depend on combined sources.
create function public.feed_source_signal_combined() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.latest_attachment_id is distinct from old.latest_attachment_id
 or new.enabled is distinct from old.enabled
 or new.signal_revision is distinct from old.signal_revision then
   update public.feed_sources c set signal_revision=c.signal_revision+1
   where c.organization_id=new.organization_id and c.actor_id=new.actor_id
   and c.kind='combined' and c.enabled
   and exists(select 1 from public.feed_combined_dependencies d
     where d.organization_id=new.organization_id and d.dependency_source_id=new.id
       and d.combined_source_id=c.id and d.combined_attachment_id=c.latest_attachment_id);
   update public.activation_automations a set next_run_at=now()
   where a.organization_id=new.organization_id and a.actor_id=new.actor_id and a.status='active'
   and exists(select 1 from public.feed_sources c join public.feed_combined_dependencies d
     on d.combined_source_id=c.id and d.combined_attachment_id=c.latest_attachment_id
     and d.organization_id=c.organization_id
     where c.id=a.source_connection_id and c.enabled and c.kind='combined'
       and d.dependency_source_id=new.id and c.organization_id=new.organization_id);
 end if;
 return new;
end $$;
create trigger feed_source_signal_combined after update of latest_attachment_id,enabled,signal_revision
 on public.feed_sources for each row execute function public.feed_source_signal_combined();
revoke all on function public.feed_source_signal_combined() from public,anon,authenticated;
