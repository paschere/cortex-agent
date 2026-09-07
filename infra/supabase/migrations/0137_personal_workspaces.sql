-- One identity, many companies, and one private personal tenant.
-- Existing organizations remain companies and no business row changes tenant.

alter table public.ba_organization
  add column if not exists kind text not null default 'company',
  add column if not exists personal_owner_user_id text references public.ba_user(id) on delete cascade;

alter table public.ba_organization
  drop constraint if exists ba_organization_kind_check,
  add constraint ba_organization_kind_check check (kind in ('personal', 'company')),
  drop constraint if exists ba_organization_personal_owner_check,
  add constraint ba_organization_personal_owner_check check (
    (kind = 'personal' and personal_owner_user_id is not null)
    or (kind = 'company' and personal_owner_user_id is null)
  );

create unique index if not exists ba_organization_personal_owner_uidx
  on public.ba_organization (personal_owner_user_id)
  where kind = 'personal';

-- Deterministic ids make retries and concurrent first requests converge.
with identities as (
  select
    u.id as user_id,
    coalesce(nullif(trim(u.name), ''), split_part(u.email, '@', 1), 'Mi') as display_name,
    md5('cortex:personal:' || u.id) as h
  from public.ba_user u
), personal_orgs as (
  insert into public.ba_organization
    (id, name, slug, kind, personal_owner_user_id, "createdAt")
  select
    'personal:' || user_id,
    left('Espacio personal de ' || display_name, 120),
    left('personal-' || regexp_replace(lower(display_name), '[^a-z0-9]+', '-', 'g'), 40) || '-' || substring(h, 1, 10),
    'personal',
    user_id,
    now()
  from identities
  on conflict do nothing
  returning id, personal_owner_user_id
)
insert into public.ba_member (id, "organizationId", "userId", role, "createdAt")
select 'personal-member:' || personal_owner_user_id, id, personal_owner_user_id, 'owner', now()
from personal_orgs
on conflict ("organizationId", "userId") do nothing;

-- Repair an interrupted/retried provisioning safely: only the declared owner
-- can ever receive the missing membership.
insert into public.ba_member (id, "organizationId", "userId", role, "createdAt")
select 'personal-member:' || o.personal_owner_user_id, o.id, o.personal_owner_user_id, 'owner', now()
from public.ba_organization o
where o.kind = 'personal'
  and not exists (
    select 1 from public.ba_member m
    where m."organizationId" = o.id and m."userId" = o.personal_owner_user_id
  )
on conflict ("organizationId", "userId") do nothing;

create or replace function public.guard_personal_workspace_membership()
returns trigger
language plpgsql
as $$
declare
  target_kind text;
  target_owner text;
begin
  if tg_op = 'UPDATE' and exists (
    select 1 from public.ba_organization o
    where o.id = old."organizationId" and o.kind = 'personal'
  ) and (
    new."organizationId" is distinct from old."organizationId"
    or new."userId" is distinct from old."userId"
    or new.role is distinct from old.role
  ) then
    raise exception 'A personal workspace owner membership cannot be transferred';
  end if;

  select kind, personal_owner_user_id into target_kind, target_owner
  from public.ba_organization
  where id = coalesce(new."organizationId", old."organizationId");

  if target_kind <> 'personal' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- Permit a cascading account/workspace deletion, but never a direct removal
    -- that would leave a live personal tenant ownerless.
    if pg_trigger_depth() <= 1 then
      raise exception 'A personal workspace owner membership cannot be removed';
    end if;
    return old;
  end if;

  if new."userId" <> target_owner or new.role <> 'owner' then
    raise exception 'A personal workspace belongs exclusively to its identity owner';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_personal_workspace_membership on public.ba_member;
create trigger guard_personal_workspace_membership
before insert or update or delete on public.ba_member
for each row execute function public.guard_personal_workspace_membership();

create or replace function public.guard_personal_workspace_invitation()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.ba_organization o
    where o.id = new."organizationId" and o.kind = 'personal'
  ) then
    raise exception 'Personal workspaces cannot invite members';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_personal_workspace_invitation on public.ba_invitation;
create trigger guard_personal_workspace_invitation
before insert or update on public.ba_invitation
for each row execute function public.guard_personal_workspace_invitation();

create or replace function public.guard_personal_workspace_identity()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.kind = 'personal' and pg_trigger_depth() <= 1 then
      raise exception 'A personal workspace cannot be deleted directly';
    end if;
    return old;
  end if;
  -- Kinds are creation-time identities. In particular, converting a company
  -- with existing members into `personal` would bypass the exclusive-member
  -- INSERT guard because those memberships already exist.
  if new.kind is distinct from old.kind then
    raise exception 'A workspace kind cannot be changed';
  end if;
  if old.kind = 'personal'
     and new.personal_owner_user_id is distinct from old.personal_owner_user_id then
    raise exception 'A personal workspace cannot be transferred';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_personal_workspace_identity on public.ba_organization;
create trigger guard_personal_workspace_identity
before update or delete on public.ba_organization
for each row execute function public.guard_personal_workspace_identity();

comment on column public.ba_organization.kind is
  'personal: one exclusive tenant per BA identity; company: independently role-governed business tenant.';
