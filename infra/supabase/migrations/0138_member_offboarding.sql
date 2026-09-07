-- Removing a Better Auth membership is the authoritative offboarding event.
-- Corporate history remains in place; only the removed person's live authority,
-- private credentials and unattended execution are disabled.

create table if not exists public.member_offboarding_events (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  ba_user_id text not null,
  directory_user_id uuid references public.users(id) on delete set null,
  membership_role text not null,
  effects jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists member_offboarding_events_org_idx
  on public.member_offboarding_events (organization_id, occurred_at desc);

alter table public.member_offboarding_events enable row level security;
revoke all on public.member_offboarding_events from public, anon, authenticated;
grant select, insert on public.member_offboarding_events to service_role;

create or replace function public.offboard_removed_member()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  directory_user uuid;
  affected integer;
  result jsonb := '{}'::jsonb;
begin
  -- Directory rows are deliberately retained: conversations, reports, runs,
  -- approvals and audit records must continue naming who did the work.
  select directory.id into directory_user
    from public.ba_user account
    join public.users directory
      on directory.organization_id = old."organizationId"
     and lower(directory.email) = lower(account.email)
   where account.id = old."userId"
   limit 1;

  if directory_user is null then
    insert into public.member_offboarding_events
      (organization_id, ba_user_id, membership_role, effects)
    values
      (old."organizationId", old."userId", old.role, '{"directory_missing":true}'::jsonb);
    return old;
  end if;

  update public.scheduled_jobs
     set status = 'paused', updated_at = now()
   where organization_id = old."organizationId"
     and user_id = directory_user
     and status = 'active';
  get diagnostics affected = row_count;
  result := result || jsonb_build_object('routines_paused', affected);

  update public.gmail_sync_state
     set paused = true, updated_at = now()
   where organization_id = old."organizationId" and user_id = directory_user;
  get diagnostics affected = row_count;
  result := result || jsonb_build_object('gmail_syncs_paused', affected);

  -- Integrations contain the person's encrypted OAuth credentials. They are
  -- not organization-shared connections, so removal is the revocation.
  delete from public.integrations
   where organization_id = old."organizationId" and user_id = directory_user;
  get diagnostics affected = row_count;
  result := result || jsonb_build_object('integrations_revoked', affected);

  delete from public.oauth_authorization_codes where user_id = directory_user;
  delete from public.oauth_access_tokens where user_id = directory_user;
  get diagnostics affected = row_count;
  result := result || jsonb_build_object('oauth_access_tokens_revoked', affected);
  delete from public.oauth_refresh_tokens where user_id = directory_user;

  update public.mcp_tokens
     set revoked_at = coalesce(revoked_at, now())
   where organization_id = old."organizationId"
     and user_id = directory_user
     and revoked_at is null;
  get diagnostics affected = row_count;
  result := result || jsonb_build_object('mcp_tokens_revoked', affected);

  -- Preserve the external MCP row for audit/configuration, but erase the
  -- private bearer/API key and make execution impossible.
  update public.user_mcp_servers
     set enabled = false,
         trusted = false,
         auth_value_encrypted = null,
         updated_at = now()
   where organization_id = old."organizationId" and user_id = directory_user;
  get diagnostics affected = row_count;
  result := result || jsonb_build_object('private_mcp_servers_disabled', affected);

  delete from public.google_chat_links
   where organization_id = old."organizationId" and user_id = directory_user;

  -- A personal browser profile is no longer usable by colleagues after its
  -- owner leaves. Bumping the revision invalidates existing profile refs while
  -- keeping the teaching record and any corporate flow that references it.
  update public.browser_profiles
     set shared = false, revision = revision + 1
   where organization_id = old."organizationId" and owner_id = directory_user;
  get diagnostics affected = row_count;
  result := result || jsonb_build_object('browser_profiles_revoked', affected);

  delete from public.browser_flow_grants
   where user_id = directory_user
     and exists (
       select 1 from public.browser_flows flow
        where flow.id = browser_flow_grants.flow_id
          and flow.organization_id = old."organizationId"
     );

  insert into public.member_offboarding_events
    (organization_id, ba_user_id, directory_user_id, membership_role, effects)
  values
    (old."organizationId", old."userId", directory_user, old.role, result);

  return old;
end;
$$;

revoke all on function public.offboard_removed_member() from public, anon, authenticated;

drop trigger if exists ba_member_secure_offboarding on public.ba_member;
create trigger ba_member_secure_offboarding
  after delete on public.ba_member
  for each row execute function public.offboard_removed_member();

comment on table public.member_offboarding_events is
  'Security ledger for membership removal. Corporate records remain intact; effects counts name the live credentials and unattended processes disabled atomically with offboarding.';
