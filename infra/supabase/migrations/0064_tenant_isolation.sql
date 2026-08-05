-- Tenant isolation: every row of business data belongs to exactly one workspace.
--
-- WHAT WAS WRONG. Cortex grew organizations in 0052 (better-auth's organization
-- plugin: ba_organization / ba_member, and an active workspace on the session),
-- but the data never learned about them. Two companies signing up shared one
-- pile of conversations, one Brain Knowledge, one set of pipelines, routines and
-- vehicles. Signup is open. Only `orchestration_runs` (0055) had ever carried an
-- `organization_id`, and it was carrying it alone.
--
-- WHAT THIS MIGRATION DOES. It puts `organization_id text` on every table that
-- holds business data, backfills it from the row's owner, indexes it, and makes
-- it NOT NULL so a future insert cannot land outside a tenant. It is the storage
-- half of the fix. The other half is
-- `packages/agent-tools/src/tenancy/scoped-client.ts`: the application never
-- gets a raw Supabase handle for business data any more, it gets one that pins
-- `organization_id` onto every read and write. Read that file next; the two are
-- one mechanism.
--
-- WHY NOT ROW-LEVEL SECURITY, WHICH WOULD BE STRONGER. Because in this codebase
-- it would be theatre. Every query in the product goes through PostgREST with
-- the service-role key, and the service role bypasses RLS by definition — the
-- policies written in 0008, 0019 and elsewhere key off `auth.uid()`, which is
-- NULL on every request here because SSO moved to better-auth in 0011. They are
-- already inert, and adding more of them would add more inert ones. Making RLS
-- real means: a second Postgres role that does not bypass it, a per-request
-- `set_config('app.current_organization', …)` inside a transaction, and dropping
-- supabase-js/PostgREST for business data in favour of a pooled `pg` client that
-- can hold a transaction open. That is a rewrite of the data layer, not a
-- migration, and it cannot ship this week.
--
-- What this migration deliberately does is make that rewrite POSSIBLE LATER
-- without touching a single call site: once `organization_id` is on every row
-- and every query already filters by it, turning on `using (organization_id =
-- current_setting('app.current_organization'))` is additive. The column is the
-- prerequisite either way. We are paying for it now and taking the enforcement
-- in the application layer in the meantime, where a scoped client + a registry
-- that refuses to serve an unclassified table makes "forgot the filter" a
-- runtime error rather than a silent leak.
--
-- WHAT ABOUT ROWS WITH NO RESOLVABLE OWNER. See § 2. In short: they are never
-- left NULL and never left visible to everyone. They go to a quarantine
-- organization that has no members, so no session can ever select it.
--
-- Idempotent throughout: `add column if not exists`, `create index if not
-- exists`, guarded constraint drops, and backfills that only touch NULLs.

-- ===========================================================================
-- 1. The two service organizations
-- ===========================================================================
-- Neither has rows in `ba_member`, and `resolveActiveOrganization` (see
-- apps/web/lib/organization.ts) only ever returns a workspace the caller is a
-- member of. So neither can become anybody's active workspace — they are
-- reachable by an operator with a SQL prompt and by nothing else.

insert into public.ba_organization (id, name, slug, "createdAt")
values (
  'cortex-quarantine',
  'Datos sin dueño (previo al aislamiento)',
  'cortex-quarantine',
  now()
)
on conflict (id) do nothing;

comment on table public.ba_organization is
  'Workspaces (tenants). Two ids are reserved and never belong to a customer: `cortex-template` holds the agent catalogue new workspaces are cloned from, and `cortex-quarantine` holds pre-tenancy rows whose owner could not be determined. Neither has members, so neither can ever be a session''s active workspace.';

-- ===========================================================================
-- 2. Where an unattributable row goes, and why
-- ===========================================================================
-- Backfilling is easy for anything with an owner: user_id -> public.users ->
-- email -> ba_user -> ba_member. The interesting rows are the ones without one:
-- a `dev_repositories` row (no owner column at all), a global Brain Knowledge
-- space whose creator was deleted, a `growth_signals` row found by a since-
-- removed account.
--
-- Leaving those NULL is not an option — it is exactly the bug this migration
-- exists to close, since a NULL organization_id matches nobody's filter and
-- would therefore have to be either invisible (data silently lost) or exempt
-- (visible to every tenant). Deleting them is not an option either: a customer's
-- registered repositories and company-wide documents are not ours to throw away
-- on a schema change.
--
-- So the rule is:
--
--   a. Owner resolvable, directly or through the row's parent -> that workspace.
--   b. Owner not resolvable, and the deployment has exactly ONE workspace with
--      members -> that workspace. There is only one candidate; assigning it is
--      a statement of fact, not a guess. This is the case every existing
--      single-company deployment is in, so nothing visibly changes for them.
--   c. Owner not resolvable and two or more candidate workspaces exist -> the
--      quarantine workspace. We will not guess which company owns a row when
--      guessing wrong means handing one customer another customer's data. The
--      row is preserved, invisible to every tenant, and an operator who knows
--      the answer moves it with one UPDATE.

create or replace function public.tenancy_backfill_fallback_org()
returns text
language sql
stable
as $$
  select case
    when (
      select count(*)
      from public.ba_organization o
      where exists (select 1 from public.ba_member m where m."organizationId" = o.id)
    ) = 1
    then (
      select o.id
      from public.ba_organization o
      where exists (select 1 from public.ba_member m where m."organizationId" = o.id)
      limit 1
    )
    else 'cortex-quarantine'
  end
$$;

-- ===========================================================================
-- 3. public.users becomes a per-workspace directory
-- ===========================================================================
-- This is the load-bearing decision of the whole migration, so it gets the long
-- comment.
--
-- `public.users` is not an identity table — `ba_user` is. It is Cortex's own
-- directory row: a display name, and `role` (member / team_admin / org_admin),
-- which is a role INSIDE A COMPANY and has never meant anything outside one.
-- Everything else in the schema hangs off `users.id`: conversations, spaces,
-- routines, vehicles, memories, integrations, tokens. So making this row
-- per-workspace makes every one of those rows unambiguously per-workspace too,
-- and turns the backfill for thirty tables into `user_id -> organization_id`.
--
-- The consequence is that one human who belongs to two workspaces has two
-- directory rows with two ids, and their conversations in workspace A are filed
-- under the id they hold in workspace A. That is correct rather than
-- unfortunate: their role, their notes, their routines and their connected
-- Google account are all things they hold IN a workspace, not things they carry
-- between them. `ba_user` remains the one row that says "this is the same
-- person", which is where cross-workspace identity belongs.
--
-- Consequently `users.email` can no longer be globally unique; it is unique per
-- workspace. `requireSession` was updated in the same change to resolve the
-- workspace first and then find-or-create the directory row inside it.

alter table public.users
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.users u
set organization_id = coalesce(
  (
    select m."organizationId"
    from public.ba_user bu
    join public.ba_member m on m."userId" = bu.id
    where lower(bu.email) = lower(u.email)
    order by m."createdAt" asc
    limit 1
  ),
  public.tenancy_backfill_fallback_org()
)
where u.organization_id is null;

alter table public.users alter column organization_id set not null;

-- The old global unique on email has to go before two workspaces can each hold
-- an ana@acme.com. Dropped by lookup rather than by name: the constraint was
-- created inline in 0001 and its name is Postgres's to choose.
do $$
declare
  cname text;
begin
  for cname in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.users'::regclass
      and c.contype = 'u'
      and (select array_agg(a.attname::text)
             from unnest(c.conkey) k
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k) = array['email']
  loop
    execute format('alter table public.users drop constraint %I', cname);
  end loop;
end$$;

create unique index if not exists users_org_email_idx
  on public.users (organization_id, lower(email));
create index if not exists users_org_idx on public.users (organization_id);

comment on column public.users.organization_id is
  'The workspace this directory row belongs to. One human in two workspaces has two rows here with two ids; ba_user is what says they are the same person. Every table with a user_id inherits its tenant through this column.';
comment on column public.users.role is
  'The person''s role INSIDE public.users.organization_id — never across workspaces.';

-- ===========================================================================
-- 4. The agent catalogue becomes per-workspace
-- ===========================================================================
-- `agents` looked like product content — the rows are seeded by migrations and
-- carry the system prompt and tool list — but /agents/[slug] lets an org_admin
-- edit exactly those fields. On one shared table that means an admin at company
-- A rewrites the assistant company B is talking to. That is not a data leak, it
-- is worse: it is a cross-tenant WRITE, and it is silent.
--
-- So each workspace gets its own copy of the catalogue, cloned from a template
-- workspace (`cortex-template`) that holds the canonical rows. Product
-- migrations keep working unchanged: they say `update public.agents set … where
-- slug = 'cortex'`, which now updates every workspace's copy and the template,
-- exactly as before.
--
-- Provisioning is a trigger on ba_organization rather than app code, so a
-- workspace created by our provisioning path, by better-auth's organization
-- plugin, or by hand in psql all end up with a working assistant. A workspace
-- without agents cannot chat at all, so this must not depend on remembering.

alter table public.agents
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

-- 4a. Slug identifies an agent within a workspace now, not across the install.
--     This has to come first: cloning the catalogue means several rows with
--     slug 'cortex', and the 0002 constraint would reject the second one.
do $$
declare
  cname text;
begin
  for cname in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.agents'::regclass
      and c.contype = 'u'
      and (select array_agg(a.attname::text)
             from unnest(c.conkey) k
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k) = array['slug']
  loop
    execute format('alter table public.agents drop constraint %I', cname);
  end loop;
end$$;

-- 4b. The template workspace, holding a copy of today's catalogue.
insert into public.ba_organization (id, name, slug, "createdAt")
values ('cortex-template', 'Catálogo de agentes (plantilla)', 'cortex-template', now())
on conflict (id) do nothing;

insert into public.agents (organization_id, slug, name, team_id, system_prompt, default_model, allowed_tool_ids, archived)
select 'cortex-template', a.slug, a.name, null, a.system_prompt, a.default_model, a.allowed_tool_ids, a.archived
from public.agents a
where a.organization_id is null
  and not exists (
    select 1 from public.agents t
    where t.organization_id = 'cortex-template' and t.slug = a.slug
  );

-- 4c. The pre-existing rows keep their ids and stay where every conversation,
--     routine and token already points: the fallback workspace from § 2.
update public.agents
set organization_id = public.tenancy_backfill_fallback_org()
where organization_id is null;

alter table public.agents alter column organization_id set not null;

create unique index if not exists agents_org_slug_idx on public.agents (organization_id, slug);
create index if not exists agents_org_idx on public.agents (organization_id);

comment on column public.agents.organization_id is
  'The workspace that owns this copy of the agent. Every workspace has its own, cloned from the `cortex-template` workspace by the trigger below, so an admin editing a system prompt edits only their own company''s assistant.';

-- 4d. Clone the catalogue into every workspace that does not have one yet
--     (existing customer workspaces, and the quarantine workspace so its rows
--     stay readable by an operator).
create or replace function public.provision_organization_agents(p_organization_id text)
returns integer
language sql
volatile
as $$
  with inserted as (
    insert into public.agents (organization_id, slug, name, team_id, system_prompt, default_model, allowed_tool_ids, archived)
    select p_organization_id, t.slug, t.name, null, t.system_prompt, t.default_model, t.allowed_tool_ids, t.archived
    from public.agents t
    where t.organization_id = 'cortex-template'
      and p_organization_id <> 'cortex-template'
      and not exists (
        select 1 from public.agents a
        where a.organization_id = p_organization_id and a.slug = t.slug
      )
    returning 1
  )
  select count(*)::int from inserted;
$$;

comment on function public.provision_organization_agents(text) is
  'Give a workspace its own copy of the agent catalogue. Idempotent: only slugs the workspace is missing are inserted. Called by the trigger on ba_organization and safe to call by hand for a workspace created before this migration.';

select public.provision_organization_agents(o.id)
from public.ba_organization o
where o.id <> 'cortex-template';

create or replace function public.provision_organization_agents_trigger()
returns trigger
language plpgsql
as $$
begin
  perform public.provision_organization_agents(new.id);
  return new;
end;
$$;

drop trigger if exists ba_organization_provision_agents on public.ba_organization;
create trigger ba_organization_provision_agents
  after insert on public.ba_organization
  for each row execute function public.provision_organization_agents_trigger();

-- 4e. Repoint every workspace's rows at ITS OWN agent, matched by slug. Without
--     this, workspace B's conversations would keep pointing at workspace A's
--     agent row and editing it would still cross the boundary.
--     Runs before those tables get their own organization_id (below), so the
--     owning workspace is read through the row's user.
update public.conversations c
set agent_id = mine.id
from public.users u, public.agents theirs, public.agents mine
where c.user_id = u.id
  and theirs.id = c.agent_id
  and mine.organization_id = u.organization_id
  and mine.slug = theirs.slug
  and theirs.organization_id <> u.organization_id;

update public.scheduled_jobs j
set agent_id = mine.id
from public.users u, public.agents theirs, public.agents mine
where j.user_id = u.id
  and theirs.id = j.agent_id
  and mine.organization_id = u.organization_id
  and mine.slug = theirs.slug
  and theirs.organization_id <> u.organization_id;

update public.mcp_tokens t
set agent_id = mine.id
from public.users u, public.agents theirs, public.agents mine
where t.user_id = u.id
  and theirs.id = t.agent_id
  and mine.organization_id = u.organization_id
  and mine.slug = theirs.slug
  and theirs.organization_id <> u.organization_id;

update public.mcp_pending_actions p
set agent_id = mine.id
from public.users u, public.agents theirs, public.agents mine
where p.user_id = u.id
  and theirs.id = p.agent_id
  and mine.organization_id = u.organization_id
  and mine.slug = theirs.slug
  and theirs.organization_id <> u.organization_id;

-- ===========================================================================
-- 5. Teams
-- ===========================================================================

alter table public.teams
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.teams t
set organization_id = coalesce(
  (
    select u.organization_id
    from public.team_members tm
    join public.users u on u.id = tm.user_id
    where tm.team_id = t.id
    limit 1
  ),
  public.tenancy_backfill_fallback_org()
)
where t.organization_id is null;

alter table public.teams alter column organization_id set not null;

do $$
declare
  cname text;
begin
  for cname in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.teams'::regclass
      and c.contype = 'u'
      and (select array_agg(a.attname::text)
             from unnest(c.conkey) k
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k) = array['name']
  loop
    execute format('alter table public.teams drop constraint %I', cname);
  end loop;
end$$;

create unique index if not exists teams_org_name_idx on public.teams (organization_id, lower(name));
create index if not exists teams_org_idx on public.teams (organization_id);

-- team_members is a child of teams, but it is also read by user_id ("which
-- teams is this person on") and by the tools page with no team in hand, so it
-- carries the column rather than inheriting.
alter table public.team_members
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.team_members tm
set organization_id = t.organization_id
from public.teams t
where t.id = tm.team_id and tm.organization_id is null;

alter table public.team_members alter column organization_id set not null;
create index if not exists team_members_org_idx on public.team_members (organization_id);

alter table public.team_tool_permissions
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.team_tool_permissions p
set organization_id = t.organization_id
from public.teams t
where t.id = p.team_id and p.organization_id is null;

alter table public.team_tool_permissions alter column organization_id set not null;
create index if not exists team_tool_permissions_org_idx on public.team_tool_permissions (organization_id);

-- ===========================================================================
-- 6. Brain Knowledge
-- ===========================================================================
-- A space has an owner only when it is personal; a global space is owned by the
-- company, which is precisely the thing that did not exist before. So it is
-- resolved in three steps — the owner, then whoever created it, then whoever
-- uploaded the first document into it — before falling back.

alter table public.kb_collections
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.kb_collections c
set organization_id = coalesce(
  (select u.organization_id from public.users u where u.id = c.scope_id),
  (select u.organization_id from public.users u where u.id = c.created_by),
  (
    select u.organization_id
    from public.kb_documents d
    join public.users u on u.id = d.uploaded_by
    where d.collection_id = c.id
    order by d.created_at asc
    limit 1
  ),
  public.tenancy_backfill_fallback_org()
)
where c.organization_id is null;

alter table public.kb_collections alter column organization_id set not null;
create index if not exists kb_collections_org_idx on public.kb_collections (organization_id);

-- 0049's unique index made a space name unique per (scope, owner). With two
-- companies in the database that is wrong in the most visible possible way:
-- the second company to create a global space called "General" would be
-- rejected because the first one already has one. Rebuild it per workspace.
drop index if exists public.kb_collections_owner_name_idx;
create unique index if not exists kb_collections_org_owner_name_idx
  on public.kb_collections (
    organization_id,
    scope,
    coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  );

alter table public.kb_documents
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.kb_documents d
set organization_id = coalesce(
  (select c.organization_id from public.kb_collections c where c.id = d.collection_id),
  (select u.organization_id from public.users u where u.id = d.uploaded_by),
  public.tenancy_backfill_fallback_org()
)
where d.organization_id is null;

alter table public.kb_documents alter column organization_id set not null;
create index if not exists kb_documents_org_idx on public.kb_documents (organization_id);

-- kb_chunks deliberately does NOT get the column. See § 12.

alter table public.gdrive_sync_state
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.gdrive_sync_state s
set organization_id = coalesce(
  (select c.organization_id from public.kb_collections c where c.id = s.collection_id),
  (select u.organization_id from public.users u where u.id = s.owner_user_id),
  public.tenancy_backfill_fallback_org()
)
where s.organization_id is null;

alter table public.gdrive_sync_state alter column organization_id set not null;
create index if not exists gdrive_sync_state_org_idx on public.gdrive_sync_state (organization_id);

alter table public.meeting_imports
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.meeting_imports m
set organization_id = coalesce(
  (select u.organization_id from public.users u where u.id = m.imported_by),
  (select d.organization_id from public.kb_documents d where d.id = m.document_id),
  public.tenancy_backfill_fallback_org()
)
where m.organization_id is null;

alter table public.meeting_imports alter column organization_id set not null;
create index if not exists meeting_imports_org_idx on public.meeting_imports (organization_id);

-- A Meet conference record is unique to Google, but two workspaces can both
-- have a participant on the same call, and each is entitled to its own copy.
drop index if exists public.meeting_imports_conference_record_idx;
create unique index if not exists meeting_imports_org_conference_record_idx
  on public.meeting_imports (organization_id, conference_record);

alter table public.meeting_briefings
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.meeting_briefings b
set organization_id = u.organization_id
from public.users u
where u.id = b.user_id and b.organization_id is null;

alter table public.meeting_briefings alter column organization_id set not null;
create index if not exists meeting_briefings_org_idx on public.meeting_briefings (organization_id);

-- ===========================================================================
-- 7. Chat
-- ===========================================================================

alter table public.conversations
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.conversations c
set organization_id = u.organization_id
from public.users u
where u.id = c.user_id and c.organization_id is null;

alter table public.conversations alter column organization_id set not null;
create index if not exists conversations_org_idx on public.conversations (organization_id, updated_at desc);

-- messages carries the column even though every query in the product reaches it
-- through conversation_id. The reason is asymmetry of cost: it is one text
-- column and one index against the single worst thing that could leak here, and
-- "every query filters by conversation_id" is a property of today's code, not
-- of tomorrow's analytics query.
alter table public.messages
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.messages m
set organization_id = c.organization_id
from public.conversations c
where c.id = m.conversation_id and m.organization_id is null;

alter table public.messages alter column organization_id set not null;
create index if not exists messages_org_idx on public.messages (organization_id, created_at desc);

alter table public.user_memories
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.user_memories mm
set organization_id = u.organization_id
from public.users u
where u.id = mm.user_id and mm.organization_id is null;

alter table public.user_memories alter column organization_id set not null;
create index if not exists user_memories_org_idx on public.user_memories (organization_id);

alter table public.user_preferences
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.user_preferences p
set organization_id = u.organization_id
from public.users u
where u.id = p.user_id and p.organization_id is null;

alter table public.user_preferences alter column organization_id set not null;
create index if not exists user_preferences_org_idx on public.user_preferences (organization_id);

alter table public.google_chat_links
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.google_chat_links g
set organization_id = u.organization_id
from public.users u
where u.id = g.user_id and g.organization_id is null;

alter table public.google_chat_links alter column organization_id set not null;
create index if not exists google_chat_links_org_idx on public.google_chat_links (organization_id);

comment on table public.google_chat_links is
  'Maps a Google Chat identity to a Cortex directory row. The primary key is still Google''s user name, so one Google account reaches exactly one workspace from Chat — the first one that linked it. That is a product limitation, not an isolation hole: the link resolves to a single users row, and everything downstream is scoped to that row''s workspace.';

-- ===========================================================================
-- 8. Routines, pipelines, orchestration
-- ===========================================================================

alter table public.scheduled_jobs
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.scheduled_jobs j
set organization_id = u.organization_id
from public.users u
where u.id = j.user_id and j.organization_id is null;

alter table public.scheduled_jobs alter column organization_id set not null;
-- The dispatcher's query is "active jobs due now" across every workspace, and it
-- then fans out one event per job carrying the workspace. Leading with
-- organization_id would make that scan useless, so this index is for the reads
-- that come back the other way: one workspace's routines list.
create index if not exists scheduled_jobs_org_idx on public.scheduled_jobs (organization_id, created_at desc);

alter table public.scheduled_job_runs
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.scheduled_job_runs r
set organization_id = j.organization_id
from public.scheduled_jobs j
where j.id = r.job_id and r.organization_id is null;

alter table public.scheduled_job_runs alter column organization_id set not null;
create index if not exists scheduled_job_runs_org_idx on public.scheduled_job_runs (organization_id, started_at desc);

alter table public.pipelines
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.pipelines p
set organization_id = coalesce(
  (select u.organization_id from public.users u where u.id = p.created_by),
  (
    select u.organization_id
    from public.pipeline_runs r
    join public.users u on u.id = r.run_by
    where r.pipeline_id = p.id
    order by r.started_at asc
    limit 1
  ),
  public.tenancy_backfill_fallback_org()
)
where p.organization_id is null;

alter table public.pipelines alter column organization_id set not null;
create index if not exists pipelines_org_idx on public.pipelines (organization_id);

-- A pipeline's slug is how a person refers to it ("/run onboarding"), so it has
-- to be unique where people look for it: inside their workspace.
do $$
declare
  cname text;
begin
  for cname in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.pipelines'::regclass
      and c.contype = 'u'
      and (select array_agg(a.attname::text)
             from unnest(c.conkey) k
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k) = array['slug']
  loop
    execute format('alter table public.pipelines drop constraint %I', cname);
  end loop;
end$$;

create unique index if not exists pipelines_org_slug_idx on public.pipelines (organization_id, slug);

alter table public.pipeline_runs
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.pipeline_runs r
set organization_id = p.organization_id
from public.pipelines p
where p.id = r.pipeline_id and r.organization_id is null;

alter table public.pipeline_runs alter column organization_id set not null;
create index if not exists pipeline_runs_org_idx on public.pipeline_runs (organization_id, started_at desc);

-- orchestration_runs already had the column (0055) but never a default owner for
-- rows written before it was enforced; make sure none are null before anything
-- else leans on it.
update public.orchestration_runs r
set organization_id = coalesce(
  (select u.organization_id from public.users u where u.id = r.user_id),
  public.tenancy_backfill_fallback_org()
)
where r.organization_id is null or r.organization_id = '';

create index if not exists orchestration_runs_org_idx on public.orchestration_runs (organization_id, created_at desc);

alter table public.orchestration_tasks
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.orchestration_tasks t
set organization_id = r.organization_id
from public.orchestration_runs r
where r.id = t.run_id and t.organization_id is null;

alter table public.orchestration_tasks alter column organization_id set not null;
create index if not exists orchestration_tasks_org_idx on public.orchestration_tasks (organization_id);

-- ===========================================================================
-- 9. Integrations, tokens, security, audit
-- ===========================================================================

alter table public.integrations
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.integrations i
set organization_id = u.organization_id
from public.users u
where u.id = i.user_id and i.organization_id is null;

alter table public.integrations alter column organization_id set not null;
create index if not exists integrations_org_idx on public.integrations (organization_id);

alter table public.user_mcp_servers
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.user_mcp_servers s
set organization_id = u.organization_id
from public.users u
where u.id = s.user_id and s.organization_id is null;

alter table public.user_mcp_servers alter column organization_id set not null;
create index if not exists user_mcp_servers_org_idx on public.user_mcp_servers (organization_id);

alter table public.mcp_tokens
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.mcp_tokens t
set organization_id = u.organization_id
from public.users u
where u.id = t.user_id and t.organization_id is null;

alter table public.mcp_tokens alter column organization_id set not null;
create index if not exists mcp_tokens_org_idx on public.mcp_tokens (organization_id);

alter table public.mcp_pending_actions
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.mcp_pending_actions p
set organization_id = u.organization_id
from public.users u
where u.id = p.user_id and p.organization_id is null;

alter table public.mcp_pending_actions alter column organization_id set not null;
create index if not exists mcp_pending_actions_org_idx on public.mcp_pending_actions (organization_id);

alter table public.audit_events
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.audit_events e
set organization_id = u.organization_id
from public.users u
where u.id = e.user_id and e.organization_id is null;

update public.audit_events
set organization_id = public.tenancy_backfill_fallback_org()
where organization_id is null;

alter table public.audit_events alter column organization_id set not null;
create index if not exists audit_events_org_idx on public.audit_events (organization_id, created_at desc);

alter table public.security_events
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.security_events e
set organization_id = coalesce(
  (select u.organization_id from public.users u where u.id = e.user_id),
  public.tenancy_backfill_fallback_org()
)
where e.organization_id is null;

alter table public.security_events alter column organization_id set not null;
create index if not exists security_events_org_idx on public.security_events (organization_id, created_at desc);

-- security_policies is per-workspace tuning of the risk model, and its primary
-- key was the knob name alone. Every workspace needs its own row per knob, so
-- the key becomes (workspace, knob). A workspace with no rows falls back to
-- DEFAULT_POLICY in packages/agent-tools/src/security/store.ts, which is why
-- new workspaces need no seeding here.
alter table public.security_policies
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.security_policies
set organization_id = public.tenancy_backfill_fallback_org()
where organization_id is null;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.security_policies'::regclass and contype = 'p'
  ) then
    execute 'alter table public.security_policies drop constraint '
         || (select quote_ident(conname) from pg_constraint
             where conrelid = 'public.security_policies'::regclass and contype = 'p');
  end if;
end$$;

alter table public.security_policies alter column organization_id set not null;
alter table public.security_policies
  add constraint security_policies_pkey primary key (organization_id, key);

-- Copy the tuned values into every other workspace, so nobody starts life with
-- a different risk posture than the install had.
insert into public.security_policies (organization_id, key, value, updated_by, updated_at)
select o.id, p.key, p.value, null, now()
from public.ba_organization o
cross join public.security_policies p
where p.organization_id = public.tenancy_backfill_fallback_org()
  and o.id <> public.tenancy_backfill_fallback_org()
  and o.id <> 'cortex-template'
on conflict (organization_id, key) do nothing;

-- rate_limit_buckets deliberately does NOT get the column. See § 12.

-- ===========================================================================
-- 10. Prospecting, dev work, vehicles, files
-- ===========================================================================

alter table public.growth_signals
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.growth_signals g
set organization_id = coalesce(
  (select u.organization_id from public.users u where u.id = g.found_by),
  public.tenancy_backfill_fallback_org()
)
where g.organization_id is null;

alter table public.growth_signals alter column organization_id set not null;
create index if not exists growth_signals_org_idx on public.growth_signals (organization_id, created_at desc);

-- Two companies prospecting the same job posting is normal and neither should
-- be told the other found it, so the dedupe key is per workspace.
drop index if exists public.growth_signals_url_idx;
create unique index if not exists growth_signals_org_url_idx
  on public.growth_signals (organization_id, url);

-- dev_repositories has no owner column at all: it is workspace configuration
-- somebody registered, and before this migration there was only one somebody.
alter table public.dev_repositories
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.dev_repositories
set organization_id = public.tenancy_backfill_fallback_org()
where organization_id is null;

alter table public.dev_repositories alter column organization_id set not null;
create index if not exists dev_repositories_org_idx on public.dev_repositories (organization_id);

do $$
declare
  cname text;
begin
  for cname in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.dev_repositories'::regclass
      and c.contype = 'u'
      and (select array_agg(a.attname::text)
             from unnest(c.conkey) k
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k) = array['key']
  loop
    execute format('alter table public.dev_repositories drop constraint %I', cname);
  end loop;
end$$;

create unique index if not exists dev_repositories_org_key_idx
  on public.dev_repositories (organization_id, key);

alter table public.dev_tasks
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.dev_tasks t
set organization_id = r.organization_id
from public.dev_repositories r
where r.id = t.repository_id and t.organization_id is null;

update public.dev_tasks
set organization_id = public.tenancy_backfill_fallback_org()
where organization_id is null;

alter table public.dev_tasks alter column organization_id set not null;
create index if not exists dev_tasks_org_idx on public.dev_tasks (organization_id, created_at desc);

-- The "one open task per issue" guard is per workspace now: the same Linear
-- issue id can only ever belong to one workspace's Linear account anyway, and
-- scoping it keeps one workspace's queue from blocking another's.
drop index if exists public.dev_tasks_one_open_per_issue;
create unique index if not exists dev_tasks_org_one_open_per_issue
  on public.dev_tasks (organization_id, source, external_id)
  where status in ('queued', 'running', 'needs_review');

-- dev_task_events is the webhook idempotency ledger. Its row is INSERTed before
-- anything is known about the delivery — that is the entire point, it is what
-- makes a duplicate delivery cheap — so at insert time there may be no task and
-- therefore no workspace. The column is nullable here and only here, and a NULL
-- means "this delivery was rejected before it could be attributed". Because the
-- scoped client filters on equality, a NULL row is visible to no workspace,
-- which is the correct reading: it is an operations record, not tenant data.
alter table public.dev_task_events
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.dev_task_events e
set organization_id = t.organization_id
from public.dev_tasks t
where t.id = e.task_id and e.organization_id is null;

create index if not exists dev_task_events_org_idx on public.dev_task_events (organization_id, received_at desc);

comment on column public.dev_task_events.organization_id is
  'Nullable on purpose, and the only nullable organization_id in the schema. The row is written before the delivery is attributed to a repository; NULL means it never was (rejected, unknown repo, malformed). A NULL row matches no workspace filter, so it is invisible to every tenant.';

alter table public.vehicles
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.vehicles v
set organization_id = u.organization_id
from public.users u
where u.id = v.user_id and v.organization_id is null;

alter table public.vehicles alter column organization_id set not null;
create index if not exists vehicles_org_idx on public.vehicles (organization_id);

alter table public.vehicle_fines
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.vehicle_fines f
set organization_id = v.organization_id
from public.vehicles v
where v.id = f.vehicle_id and f.organization_id is null;

alter table public.vehicle_fines alter column organization_id set not null;
create index if not exists vehicle_fines_org_idx on public.vehicle_fines (organization_id, detected_at desc);

-- vehicle_consults deliberately does NOT get the column. See § 12.

alter table public.presentation_files
  add column if not exists organization_id text references public.ba_organization(id) on delete cascade;

update public.presentation_files f
set organization_id = coalesce(
  (select u.organization_id from public.users u where u.id = f.created_by),
  public.tenancy_backfill_fallback_org()
)
where f.organization_id is null;

alter table public.presentation_files alter column organization_id set not null;
create index if not exists presentation_files_org_idx on public.presentation_files (organization_id);


-- ===========================================================================
-- 11. Retrieval learns about workspaces
-- ===========================================================================
-- 0049 moved "which spaces may this person see" into the database so that no
-- caller could get it wrong, and everything that retrieves from Brain Knowledge
-- has gone through `kb_visible_space_ids` ever since: `kb_search_scoped`
-- (0049/0057/0058), `kb_brain_graph` (0062), `kb_conflict_candidates`. That rule
-- had one blind spot it could not have known about — `scope = 'global'` meant
-- every global space IN THE INSTALL. With two companies in one database that is
-- a cross-tenant read on the most sensitive surface the product has: one
-- company's Cortex answering out of another company's documents, with a
-- citation.
--
-- THE FIX GOES INSIDE THE FUNCTION, AND ITS SIGNATURE DOES NOT CHANGE. The
-- tempting move was to add `p_organization_id` as a required first argument, so
-- every caller has to state the tenant. It is the wrong move here, for the
-- reason this whole change exists: an argument is a thing a caller can get
-- wrong, and every future function that wants to retrieve would have to
-- remember to thread it through. Since § 3 made `public.users` per-workspace,
-- the person IS the tenant — `p_user_id` already determines the workspace
-- unambiguously — so the function derives it and there is nothing left to pass,
-- forget, or pass wrongly.
--
-- The practical dividend is that every existing caller, in SQL and in
-- TypeScript, becomes tenant-safe without being edited, and so does the next one
-- somebody writes, including migrations that redefine `kb_search_scoped` around
-- it without ever thinking about tenancy.

create or replace function public.kb_visible_space_ids(p_user_id uuid)
returns table (space_id uuid)
language sql
stable
as $$
  select c.id
  from public.kb_collections c
  join public.users u on u.id = p_user_id
  where p_user_id is not null
    and c.organization_id = u.organization_id
    and (
      c.scope = 'global'
      or (c.scope = 'user' and c.scope_id = p_user_id)
    )
$$;

comment on function public.kb_visible_space_ids(uuid) is
  'The only definition of "which spaces may this person retrieve from": every global space OF THEIR WORKSPACE, plus their own personal ones. The workspace is read from public.users rather than taken as an argument — a directory row belongs to exactly one workspace (migration 0064 § 3), so there is no tenant to pass and therefore none to get wrong. A null or unknown user id joins to nothing and yields nothing, so a caller that has lost track of who it is asking for fails closed. There is still no admin branch: an org admin publishes global spaces, which is not the same as reading everyone''s notes.';

-- PostgREST publishes every function in `public` under /rpc/, and this one takes
-- a user id as a plain argument, so anything holding an anon or authenticated
-- key could otherwise ask it directly.
revoke all on function public.kb_visible_space_ids(uuid) from public, anon, authenticated;
revoke all on function public.provision_organization_agents(text) from public, anon, authenticated;
grant execute on function public.kb_visible_space_ids(uuid) to service_role;
grant execute on function public.provision_organization_agents(text) to service_role;

-- ===========================================================================
-- 12. The four tables that inherit instead of carrying the column
-- ===========================================================================
-- These are not oversights and they are not unprotected. The scoped client
-- (packages/agent-tools/src/tenancy/scoped-client.ts) classifies each of them as
-- `derived` and REFUSES to run a query against them that does not constrain the
-- parent key named below — no filter on the parent, no query, at runtime. So
-- "forgot the tenant filter" is impossible here for the same reason it is
-- impossible on the tables that do carry the column; the row set is simply
-- reached by a different key.
--
--   kb_chunks         -> document_id.  The high-volume table in the schema by an
--                        order of magnitude (one row per ~500 words of every
--                        document, recording and transcript). Retrieval never
--                        touches it directly — it goes through kb_search_scoped,
--                        which starts from kb_visible_space_ids and is now
--                        workspace-scoped above. Everything else reads or
--                        deletes one document's chunks.
--   rate_limit_buckets-> user_id.      Keyed (user_id, tool_id) and only ever
--                        read at that exact key. Holds a counter, no content.
--   user_mcp_tools    -> server_id.    A cached copy of one server's manifest.
--   vehicle_consults  -> vehicle_id.   The consult log of one vehicle.
--
-- orchestration_events is the fifth of this shape (parent run_id) and keeps no
-- column for the same reason.

comment on table public.kb_chunks is
  'Chunks of a Brain Knowledge document. Deliberately has no organization_id: it inherits its tenant from kb_documents through document_id, and the scoped client refuses any query here that does not constrain document_id. See migration 0064 § 12.';
comment on table public.rate_limit_buckets is
  'Token buckets per (user_id, tool_id). Inherits its tenant from users through user_id; see migration 0064 § 12.';
comment on table public.user_mcp_tools is
  'Cached tool manifest of one external MCP server. Inherits its tenant from user_mcp_servers through server_id; see migration 0064 § 12.';
comment on table public.vehicle_consults is
  'RUNT/SIMIT consult log for one vehicle. Inherits its tenant from vehicles through vehicle_id; see migration 0064 § 12.';
comment on table public.orchestration_events is
  'Event stream of one orchestration run. Inherits its tenant from orchestration_runs through run_id; see migration 0064 § 12.';

-- ===========================================================================
-- 13. Clean up
-- ===========================================================================
-- The fallback helper existed for this migration and nothing else. Leaving it
-- behind would leave a function whose whole job is to guess a workspace, which
-- is the last thing anybody should be able to call at runtime.

drop function if exists public.tenancy_backfill_fallback_org();
