-- Enable RLS
alter table public.users enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.agents enable row level security;
alter table public.kb_collections enable row level security;
alter table public.kb_documents enable row level security;
alter table public.kb_chunks enable row level security;
alter table public.gdrive_sync_state enable row level security;
alter table public.integrations enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.audit_events enable row level security;
alter table public.rate_limit_buckets enable row level security;

-- helper: current user id
create or replace function public.current_user_id() returns uuid
language sql stable as $$
  select auth.uid()
$$;

-- helper: is org admin
create or replace function public.is_org_admin() returns boolean
language sql stable security definer as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'org_admin');
$$;

-- helper: is in team
create or replace function public.is_in_team(p_team uuid) returns boolean
language sql stable security definer as $$
  select exists (select 1 from public.team_members where team_id = p_team and user_id = auth.uid());
$$;

-- helper: is team admin
create or replace function public.is_team_admin(p_team uuid) returns boolean
language sql stable security definer as $$
  select exists (select 1 from public.team_members where team_id = p_team and user_id = auth.uid() and role = 'team_admin');
$$;

-- users: self + org admin can read all
create policy users_self_read on public.users for select
  using (id = auth.uid() or public.is_org_admin());
create policy users_org_admin_write on public.users for update
  using (public.is_org_admin());

-- teams: any signed-in user can read; org admin writes
create policy teams_read on public.teams for select using (auth.uid() is not null);
create policy teams_write on public.teams for all using (public.is_org_admin()) with check (public.is_org_admin());

-- team_members: read if same team or org admin
create policy team_members_read on public.team_members for select
  using (public.is_in_team(team_id) or public.is_org_admin());
create policy team_members_write on public.team_members for all
  using (public.is_team_admin(team_id) or public.is_org_admin())
  with check (public.is_team_admin(team_id) or public.is_org_admin());

-- agents: read all signed-in; write org admin
create policy agents_read on public.agents for select using (auth.uid() is not null);
create policy agents_write on public.agents for all using (public.is_org_admin()) with check (public.is_org_admin());

-- kb_collections: scope-based read; write by appropriate admin or owner
create policy kb_collections_read on public.kb_collections for select
  using (
    (scope = 'global')
    or (scope = 'team' and public.is_in_team(scope_id))
    or (scope = 'user' and scope_id = auth.uid())
    or (scope = 'conversation' and exists (
      select 1 from public.conversations c where c.id = scope_id and c.user_id = auth.uid()
    ))
  );
create policy kb_collections_write on public.kb_collections for all
  using (
    (scope = 'global' and public.is_org_admin())
    or (scope = 'team' and public.is_team_admin(scope_id))
    or (scope = 'user' and scope_id = auth.uid())
    or (scope = 'conversation' and exists (
      select 1 from public.conversations c where c.id = scope_id and c.user_id = auth.uid()
    ))
  )
  with check (
    (scope = 'global' and public.is_org_admin())
    or (scope = 'team' and public.is_team_admin(scope_id))
    or (scope = 'user' and scope_id = auth.uid())
    or (scope = 'conversation' and exists (
      select 1 from public.conversations c where c.id = scope_id and c.user_id = auth.uid()
    ))
  );

-- kb_documents inherit collection visibility
create policy kb_documents_read on public.kb_documents for select
  using (exists (select 1 from public.kb_collections c where c.id = collection_id));
create policy kb_documents_write on public.kb_documents for all
  using (exists (select 1 from public.kb_collections c where c.id = collection_id))
  with check (exists (select 1 from public.kb_collections c where c.id = collection_id));

-- kb_chunks inherit document visibility
create policy kb_chunks_read on public.kb_chunks for select
  using (exists (select 1 from public.kb_documents d where d.id = document_id));

-- gdrive_sync_state inherit collection visibility
create policy gdrive_sync_state_rw on public.gdrive_sync_state for all
  using (exists (select 1 from public.kb_collections c where c.id = collection_id))
  with check (exists (select 1 from public.kb_collections c where c.id = collection_id));

-- integrations: never readable from client. Only service role accesses tokens.
create policy integrations_no_client on public.integrations for all using (false) with check (false);

-- conversations + messages: owner only
create policy conversations_owner on public.conversations for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy messages_owner on public.messages for all
  using (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()));

-- audit_events: owner read; org admin read all
create policy audit_events_read on public.audit_events for select
  using (user_id = auth.uid() or public.is_org_admin());

-- rate_limit_buckets: owner only
create policy rate_limit_buckets_self on public.rate_limit_buckets for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Safe view over integrations (no tokens)
create or replace view public.integrations_view with (security_invoker = true) as
  select id, user_id, provider, scopes, expires_at, created_at, updated_at
  from public.integrations
  where user_id = auth.uid();
grant select on public.integrations_view to authenticated;
