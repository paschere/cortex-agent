-- Explicit, reviewable writes prepared from an identity-owned global chat.
create table public.global_action_proposals (
  id uuid primary key default gen_random_uuid(),
  account_id text not null references public.ba_user(id) on delete cascade,
  conversation_id uuid not null references public.global_conversations(id) on delete cascade,
  workspace_id text not null references public.ba_organization(id) on delete cascade,
  workspace_name text not null,
  source_workspace_ids text[] not null,
  tool_id text not null check (length(tool_id) between 1 and 160),
  input jsonb not null check (octet_length(input::text) <= 14336),
  state text not null default 'pending' check (state in ('pending','executing','succeeded','failed','uncertain','rejected')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  finished_at timestamptz,
  check (cardinality(source_workspace_ids) between 1 and 30),
  check (workspace_id = any(source_workspace_ids)),
  check (result is null or octet_length(result::text) <= 16384),
  check (error is null or length(error) <= 1000)
);
create index global_action_proposals_owner_idx
  on public.global_action_proposals(account_id, conversation_id, created_at desc);

alter table public.global_action_proposals enable row level security;
revoke all on public.global_action_proposals from public, anon, authenticated;
grant select, insert, update on public.global_action_proposals to service_role;

-- Payload and source scope are immutable after review is possible.
create function public.global_action_proposal_immutable()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.account_id is distinct from old.account_id
    or new.conversation_id is distinct from old.conversation_id
    or new.workspace_id is distinct from old.workspace_id
    or new.workspace_name is distinct from old.workspace_name
    or new.source_workspace_ids is distinct from old.source_workspace_ids
    or new.tool_id is distinct from old.tool_id
    or new.input is distinct from old.input then
    raise exception 'A reviewed global action payload is immutable.';
  end if;
  if not (
    (old.state = 'pending' and new.state in ('executing','rejected'))
    or (old.state = 'executing' and new.state in ('succeeded','failed','uncertain'))
  ) then
    raise exception 'Invalid global action state transition.';
  end if;
  return new;
end $$;
create trigger global_action_proposal_immutable_trg before update on public.global_action_proposals
for each row execute function public.global_action_proposal_immutable();

-- Hard cap even when callers race.
create function public.global_action_proposal_limit()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.conversation_id::text));
  if (select count(*) from public.global_action_proposals where conversation_id=new.conversation_id) >= 30 then
    raise exception 'Esta conversación alcanzó el límite de 30 propuestas.';
  end if;
  if not exists (
    select 1 from public.global_conversations conversation
     where conversation.id=new.conversation_id and conversation.account_id=new.account_id
       and conversation.workspace_ids=new.source_workspace_ids
  ) then
    raise exception 'Proposal scope must match its identity-owned conversation.';
  end if;
  return new;
end $$;
create trigger global_action_proposal_limit_trg before insert on public.global_action_proposals
for each row execute function public.global_action_proposal_limit();
