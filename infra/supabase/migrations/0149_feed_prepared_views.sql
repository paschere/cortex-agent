-- Private, cited tabular views derived from temporary Feed text. They never
-- overwrite the original source and disappear with it.
create table public.feed_prepared_views (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  actor_id uuid not null references public.users(id) on delete cascade,
  source_id uuid not null references public.chat_attachments(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  prompt text not null check (length(btrim(prompt)) between 1 and 1000),
  table_data jsonb not null check (jsonb_typeof(table_data) = 'object'),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array'),
  source_snapshot text not null check (source_snapshot ~ '^[a-f0-9]{64}$'),
  source_snapshot_data jsonb not null check (jsonb_typeof(source_snapshot_data) = 'object'),
  created_at timestamptz not null default now()
);
create index feed_prepared_views_actor_recent
  on public.feed_prepared_views(organization_id,actor_id,source_id,created_at desc);
alter table public.feed_prepared_views enable row level security;
revoke all on public.feed_prepared_views from public,anon,authenticated,service_role;
grant select,insert on public.feed_prepared_views to service_role;

alter table public.activation_runs
  add column prepared_view_id uuid references public.feed_prepared_views(id) on delete cascade,
  add column identity_namespace text check (identity_namespace is null or length(identity_namespace) between 1 and 160);

alter function public.activation_commit_run(text,uuid,uuid,text)
  rename to activation_commit_run_v1;
revoke all on function public.activation_commit_run_v1(text,uuid,uuid,text)
  from public,anon,authenticated,service_role;

create function public.activation_commit_run(
  p_organization_id text,
  p_actor_id uuid,
  p_run_id uuid,
  p_expected_source_snapshot text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run public.activation_runs;
begin
  select * into v_run from public.activation_runs
    where id=p_run_id and organization_id=p_organization_id and actor_id=p_actor_id
    for update;
  if not found then raise exception 'La simulación no existe.'; end if;
  if v_run.status = 'committed' then
    return public.activation_commit_run_v1(
      p_organization_id,p_actor_id,p_run_id,p_expected_source_snapshot
    );
  end if;
  if v_run.prepared_view_id is not null and not exists (
    select 1
    from public.feed_prepared_views v
    join public.chat_attachments a on a.id=v.source_id and a.organization_id=v.organization_id
    where v.id=v_run.prepared_view_id and v.organization_id=p_organization_id
      and v.actor_id=p_actor_id and v.source_id=v_run.source_id
      and a.created_by=p_actor_id and a.feed_kind is not null and a.purge_at > now()
      and a.extracted_text is not distinct from v.source_snapshot_data->>'extractedText'
      and v.source_snapshot=p_expected_source_snapshot
      and v.table_data is not distinct from v_run.source_snapshot_data->'preparedTable'
  ) then raise exception 'La vista preparada o su fuente cambió. Prepárala otra vez.'; end if;
  return public.activation_commit_run_v1(
    p_organization_id,p_actor_id,p_run_id,p_expected_source_snapshot
  );
end;
$$;
revoke all on function public.activation_commit_run(text,uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.activation_commit_run(text,uuid,uuid,text) to service_role;
