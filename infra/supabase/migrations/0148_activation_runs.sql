-- Private, reviewable snapshots for turning a person's temporary Feed table into
-- company-shared management cases. The source itself remains private and temporary.
create table public.activation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  actor_id uuid not null references public.users(id) on delete cascade,
  source_id uuid not null references public.chat_attachments(id) on delete cascade,
  source_name text not null check (length(source_name) between 1 and 240),
  source_snapshot text not null check (length(source_snapshot) = 64),
  source_snapshot_data jsonb not null,
  sheet_index integer not null check (sheet_index between 0 and 19),
  sheet_name text not null check (length(sheet_name) between 1 and 240),
  definition jsonb not null,
  mapping jsonb,
  mapping_snapshot text not null check (length(mapping_snapshot) = 64),
  candidates jsonb not null,
  status text not null default 'simulated' check (status in ('simulated','committed')),
  case_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  check (jsonb_typeof(definition) = 'object'),
  check (mapping is null or jsonb_typeof(mapping) = 'object'),
  check (jsonb_typeof(source_snapshot_data) = 'object'),
  check (jsonb_typeof(candidates) = 'array'),
  check ((status = 'simulated' and committed_at is null) or (status = 'committed' and committed_at is not null))
);
create index activation_runs_actor_recent on public.activation_runs(organization_id, actor_id, created_at desc);
alter table public.activation_runs enable row level security;
revoke all on public.activation_runs from public, anon, authenticated, service_role;
grant select, insert, update on public.activation_runs to service_role;

create function public.activation_commit_run(
  p_organization_id text,
  p_actor_id uuid,
  p_run_id uuid,
  p_expected_source_snapshot text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run public.activation_runs;
  v_candidate jsonb;
  v_group jsonb;
  v_evidence text;
  v_title text;
  v_objective text;
  v_next_action text;
  v_value jsonb;
  v_case public.management_cases;
  v_ids uuid[] := '{}';
  v_created integer := 0;
  v_reused integer := 0;
  v_today text := (now() at time zone 'America/Bogota')::date::text;
begin
  if not exists (
    select 1 from public.users u
    join public.ba_user bu on lower(bu.email) = lower(u.email)
    join public.ba_member bm on bm."userId" = bu.id and bm."organizationId" = u.organization_id
    where u.id = p_actor_id and u.organization_id = p_organization_id
  ) then raise exception 'Ya no perteneces a esta empresa.'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id || ':activation:' || p_run_id::text, 0));
  select * into v_run from public.activation_runs
    where id = p_run_id and organization_id = p_organization_id and actor_id = p_actor_id
    for update;
  if not found then raise exception 'La simulación no existe.'; end if;
  if v_run.status = 'committed' then
    return jsonb_build_object('caseIds',v_run.case_ids,'created',0,'reused',cardinality(v_run.case_ids));
  end if;
  if v_run.source_snapshot <> p_expected_source_snapshot then
    raise exception 'La fuente cambió. Simula otra vez.';
  end if;
  if not exists (
    select 1 from public.chat_attachments
    where id = v_run.source_id and organization_id = p_organization_id
      and created_by = p_actor_id and feed_kind is not null and feed_tables is not null and purge_at > now()
    for share
  ) then raise exception 'La fuente venció o dejó de estar disponible.'; end if;
  if not exists (
    select 1 from public.chat_attachments
    where id = v_run.source_id and organization_id = p_organization_id and created_by = p_actor_id
      and feed_content_hash is not distinct from v_run.source_snapshot_data->>'contentHash'
      and feed_tables is not distinct from v_run.source_snapshot_data->'tables'
  ) then raise exception 'Los datos de la fuente cambiaron. Simula otra vez.'; end if;

  -- management_save_case takes the same organization advisory lock, so the
  -- pre-check and insert remain idempotent even under concurrent retries.
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id || ':management', 0));
  for v_group in
    select jsonb_agg(value order by (value->>'rowIndex')::integer)
    from jsonb_array_elements(v_run.candidates)
    where value->>'status' = 'matched'
    group by value->>'sourceKey'
    order by min((value->>'rowIndex')::integer)
  loop
    v_candidate := v_group->0;
    select string_agg(
      'fila ' || (((value->>'rowIndex')::integer)+1)::text || ': ' ||
      coalesce((select string_agg((cell->>'header') || '=' || (cell->>'value'), ', ') from jsonb_array_elements(value->'values') cell), ''),
      '; ' order by (value->>'rowIndex')::integer
    ) into v_evidence from jsonb_array_elements(v_group);
    if v_run.definition->>'kind' = 'invoice_duplicates' then
      v_title := coalesce(v_run.definition->>'caseTitle', 'Revisar factura ' || (v_candidate->>'invoiceNumber') || ' · ' || (v_candidate->>'issuer'));
      v_objective := coalesce(v_run.definition->>'caseObjective', 'Revisar posible conflicto de factura. No se declara que sea un duplicado confirmado.');
      v_next_action := coalesce(v_run.definition->>'caseNextAction', 'Comparar las filas señaladas y adjuntar evidencia antes de cerrar.');
    else
      v_title := v_run.definition->>'caseTitle';
      v_objective := v_run.definition->>'caseObjective';
      v_next_action := v_run.definition->>'caseNextAction';
    end if;
    for v_value in select value from jsonb_array_elements(v_candidate->'values') loop
      v_title := replace(v_title, '{{' || (v_value->>'header') || '}}', v_value->>'value');
      v_objective := replace(v_objective, '{{' || (v_value->>'header') || '}}', v_value->>'value');
      v_next_action := replace(v_next_action, '{{' || (v_value->>'header') || '}}', v_value->>'value');
    end loop;
    select * into v_case from public.management_cases
      where organization_id = p_organization_id and data->>'sourceKey' = v_candidate->>'sourceKey';
    if found then
      v_reused := v_reused + 1;
    else
      select * into v_case from public.management_save_case(
        p_organization_id, p_actor_id, null, 0,
        jsonb_build_object(
          'title', left(v_title || ' · fila ' || (((v_candidate->>'rowIndex')::integer)+1)::text, 180),
          'objective', left(v_objective || ' Evidencia simulada: ' || v_evidence || '. Fuente compartida por confirmación explícita desde la simulación ' || v_run.id::text || '.', 2000),
          'successCriteria','Revisar las filas señaladas y documentar el resultado con evidencia verificable.',
          'ownerId',null,'dueOn',v_today,'nextReviewOn',v_today,
          'impact','medium',
          'nextAction',left(v_next_action,1000),
          'blocker','','state','open','sourceKey',v_candidate->>'sourceKey','sourceUrl',null,
          'dependsOn',null,'evidence',null,'reviewNote','',
          'activationEvidence',jsonb_build_object(
            'runId',v_run.id,'sourceId',v_run.source_id,'sourceName',v_run.source_name,
            'sheetIndex',v_run.sheet_index,'sheetName',v_run.sheet_name,
            'definition',v_run.definition,'rows',v_group
          )
        ), false
      );
      v_created := v_created + 1;
    end if;
    v_ids := array_append(v_ids, v_case.id);
  end loop;
  if cardinality(v_ids) = 0 then raise exception 'No hay filas válidas para crear asuntos.'; end if;
  update public.activation_runs set status='committed', committed_at=now(), case_ids=v_ids
    where id=v_run.id returning * into v_run;
  return jsonb_build_object('caseIds',v_ids,'created',v_created,'reused',v_reused);
end;
$$;
revoke all on function public.activation_commit_run(text,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.activation_commit_run(text,uuid,uuid,text) to service_role;

-- The ordinary Management editor validates the public case shape and replaces
-- `data` as a whole. Keep the private activation provenance immutable across
-- later owner/state/evidence edits without exposing it as editable form data.
create function public.preserve_management_activation_evidence()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.data ? 'activationEvidence' then
    new.data := jsonb_set(new.data, '{activationEvidence}', old.data->'activationEvidence', true);
  end if;
  return new;
end;
$$;
revoke all on function public.preserve_management_activation_evidence() from public, anon, authenticated;
create trigger management_preserve_activation_evidence
before update of data on public.management_cases
for each row execute function public.preserve_management_activation_evidence();
