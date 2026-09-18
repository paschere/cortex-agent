-- Private Feed sources made by joining two or three explicit source
-- connections. The source definition stays small; every capture records the
-- exact dependency snapshots used to produce it.
alter table public.feed_sources drop constraint if exists feed_sources_kind_check;
alter table public.feed_sources
  add constraint feed_sources_kind_check
  check (kind in ('file','text','url','google_sheet','api','combined'));

alter table public.chat_attachments drop constraint if exists chat_attachments_feed_kind_check;
alter table public.chat_attachments
  add constraint chat_attachments_feed_kind_check
  check (feed_kind in ('file','url','text','api','combined'));

alter table public.chat_attachments
  add column feed_combined_dependencies jsonb not null default '[]'::jsonb;
alter table public.chat_attachments
  add constraint chat_attachments_feed_combined_dependencies_check
  check (jsonb_typeof(feed_combined_dependencies) = 'array');
alter table public.chat_attachments
  add column feed_combined_provenance jsonb not null default '[]'::jsonb;
alter table public.chat_attachments
  add constraint chat_attachments_feed_combined_provenance_check
  check (jsonb_typeof(feed_combined_provenance) = 'array');

-- A normalized ledger lets the commit fence reject an old combined capture
-- even when the scheduler has not refreshed the combined source yet.
create table public.feed_combined_dependencies (
  organization_id text not null references public.ba_organization(id) on delete cascade,
  combined_source_id uuid not null references public.feed_sources(id) on delete cascade,
  combined_attachment_id uuid not null references public.chat_attachments(id) on delete cascade,
  dependency_source_id uuid not null references public.feed_sources(id) on delete cascade,
  dependency_attachment_id uuid references public.chat_attachments(id) on delete set null,
  dependency_content_hash text check (dependency_content_hash is null or dependency_content_hash ~ '^[a-f0-9]{64}$'),
  dependency_purge_at timestamptz,
  dependency_last_changed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (combined_attachment_id, dependency_source_id),
  unique (combined_source_id, combined_attachment_id, dependency_source_id)
);
create index feed_combined_dependencies_source_idx
  on public.feed_combined_dependencies(organization_id, combined_source_id, created_at desc);
alter table public.feed_combined_dependencies enable row level security;
revoke all on public.feed_combined_dependencies from public, anon, authenticated;
grant select, insert, delete on public.feed_combined_dependencies to service_role;

-- 0149 already fences the temporary source and prepared view. Wrap that
-- implementation once more so a combined source cannot share a capture whose
-- private dependencies changed, expired, were disabled, or moved their latest
-- pointer since the simulation.
alter function public.activation_commit_run(text,uuid,uuid,text)
  rename to activation_commit_run_v2;
revoke all on function public.activation_commit_run_v2(text,uuid,uuid,text)
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
  v_attachment public.chat_attachments;
  v_combined_source public.feed_sources;
  v_bad boolean;
begin
  select * into v_run from public.activation_runs
    where id=p_run_id and organization_id=p_organization_id and actor_id=p_actor_id
    for update;
  if not found then raise exception 'La simulación no existe.'; end if;

  -- An already committed run is idempotent and was fenced by this function on
  -- its first publication. Preserve the existing v2 response on retries.
  if v_run.status = 'committed' then
    return public.activation_commit_run_v2(
      p_organization_id,p_actor_id,p_run_id,p_expected_source_snapshot
    );
  end if;

  select * into v_attachment
    from public.chat_attachments
    where id=v_run.source_id and organization_id=p_organization_id
      and created_by=p_actor_id and feed_kind is not null
    for share;
  if not found then raise exception 'La fuente venció o dejó de estar disponible.'; end if;

  if v_attachment.feed_kind = 'combined' then
    select * into v_combined_source
      from public.feed_sources
      where id=v_attachment.feed_source_id
        and organization_id=p_organization_id
        and actor_id=p_actor_id
      for share;
    if not found or v_combined_source.enabled is not true
      or v_combined_source.kind <> 'combined'
      or v_combined_source.latest_attachment_id is distinct from v_attachment.id
    then
      raise exception 'La fuente combinada cambió o fue desactivada. Simula otra vez.';
    end if;
    if jsonb_typeof(v_combined_source.config->'sourceIds') is distinct from 'array'
      or jsonb_array_length(v_combined_source.config->'sourceIds') < 2
      or (
        select count(*) from public.feed_combined_dependencies d
        where d.organization_id=p_organization_id
          and d.combined_source_id=v_attachment.feed_source_id
          and d.combined_attachment_id=v_attachment.id
      ) <> jsonb_array_length(v_combined_source.config->'sourceIds')
      or exists (
        select 1
        from jsonb_array_elements_text(v_combined_source.config->'sourceIds') source_id
        where not exists (
          select 1 from public.feed_combined_dependencies d
          where d.organization_id=p_organization_id
            and d.combined_source_id=v_attachment.feed_source_id
            and d.combined_attachment_id=v_attachment.id
            and d.dependency_source_id=source_id::uuid
        )
      )
      or exists (
        select 1 from public.feed_combined_dependencies d
        where d.organization_id=p_organization_id
          and d.combined_source_id=v_attachment.feed_source_id
          and d.combined_attachment_id=v_attachment.id
          and not exists (
            select 1
            from jsonb_array_elements_text(v_combined_source.config->'sourceIds') source_id
            where source_id::uuid=d.dependency_source_id
          )
      )
    then
      raise exception 'La captura combinada perdió una dependencia. Simula otra vez.';
    end if;
    if not exists (
      select 1 from public.feed_combined_dependencies d
      where d.organization_id=p_organization_id
        and d.combined_source_id=v_attachment.feed_source_id
        and d.combined_attachment_id=v_attachment.id
    ) then
      raise exception 'La captura combinada no conserva sus dependencias. Simula otra vez.';
    end if;

    -- Lock every current dependency before checking its pointer, hash and
    -- expiry. A source refresh or purge cannot commit between this read and
    -- the delegated publisher's evidence write.
    perform 1
      from public.feed_combined_dependencies d
      join public.feed_sources s
        on s.id=d.dependency_source_id
       and s.organization_id=p_organization_id
      join public.chat_attachments a
        on a.id=d.dependency_attachment_id
       and a.organization_id=p_organization_id
       and a.created_by=p_actor_id
      where d.organization_id=p_organization_id
        and d.combined_source_id=v_attachment.feed_source_id
        and d.combined_attachment_id=v_attachment.id
      for share;

    -- Re-read the ledger after the locks. A concurrent refresh can otherwise
    -- delete and recreate rows between the first count and the dependency
    -- lock, leaving an incomplete set that looked valid at the first read.
    if (
      select count(*) from public.feed_combined_dependencies d
      where d.organization_id=p_organization_id
        and d.combined_source_id=v_attachment.feed_source_id
        and d.combined_attachment_id=v_attachment.id
    ) <> jsonb_array_length(v_combined_source.config->'sourceIds')
      or exists (
        select 1
        from jsonb_array_elements_text(v_combined_source.config->'sourceIds') source_id
        where not exists (
          select 1 from public.feed_combined_dependencies d
          where d.organization_id=p_organization_id
            and d.combined_source_id=v_attachment.feed_source_id
            and d.combined_attachment_id=v_attachment.id
            and d.dependency_source_id=source_id::uuid
        )
      )
    then
      raise exception 'La captura combinada perdió una dependencia durante la revisión. Simula otra vez.';
    end if;

    select exists (
      select 1
      from public.feed_combined_dependencies d
      left join public.feed_sources s
        on s.id=d.dependency_source_id
       and s.organization_id=p_organization_id
      left join public.chat_attachments a
        on a.id=d.dependency_attachment_id
       and a.organization_id=p_organization_id
       and a.created_by=p_actor_id
       and a.feed_kind is not null
      where d.organization_id=p_organization_id
        and d.combined_source_id=v_attachment.feed_source_id
        and d.combined_attachment_id=v_attachment.id
        and (
          s.id is null
          or s.actor_id is distinct from p_actor_id
          or s.enabled is not true
          or s.kind = 'combined'
          or s.latest_attachment_id is distinct from d.dependency_attachment_id
          or a.id is null
          or a.purge_at <= now()
          or a.feed_truncated is true
          or a.feed_content_hash is distinct from d.dependency_content_hash
          or s.last_changed_at is distinct from d.dependency_last_changed_at
        )
    ) into v_bad;
    if v_bad then
      raise exception 'Una fuente combinada cambió o venció. Simula otra vez antes de compartir.';
    end if;

    -- Carry row-level provenance metadata into immutable activation evidence.
    -- Keep the full private quotes on the Feed capture; the v2 publisher only
    -- shares values explicitly selected by the activation candidate.
    update public.activation_runs r
      set candidates = coalesce((
        select jsonb_agg(
          case
            when candidate.value->>'status' = 'matched' and provenance.value is not null
            then candidate.value || jsonb_build_object(
              'provenance',
              coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'sourceId', citation.value->>'sourceId',
                    'sourceName', citation.value->>'sourceName',
                    'attachmentId', citation.value->>'attachmentId',
                    'sheetIndex', (citation.value->>'sheetIndex')::integer,
                    'sheetName', citation.value->>'sheetName',
                    'rowIndex', (citation.value->>'rowIndex')::integer
                  )
                  order by (citation.value->>'sourceId'),
                    (citation.value->>'rowIndex')::integer
                )
                from jsonb_array_elements(
                  coalesce(provenance.value->'provenance', '[]'::jsonb)
                ) citation(value)
              ), '[]'::jsonb)
            )
            else candidate.value
          end order by candidate.ordinality
        )
        from jsonb_array_elements(r.candidates) with ordinality candidate(value, ordinality)
        left join lateral jsonb_array_elements(v_attachment.feed_combined_provenance) provenance(value)
          on (provenance.value->>'rowIndex')::integer = (candidate.value->>'rowIndex')::integer
      ), '[]'::jsonb)
      where r.id=v_run.id
      returning * into v_run;
  end if;

  return public.activation_commit_run_v2(
    p_organization_id,p_actor_id,p_run_id,p_expected_source_snapshot
  );
end;
$$;
revoke all on function public.activation_commit_run(text,uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.activation_commit_run(text,uuid,uuid,text) to service_role;
