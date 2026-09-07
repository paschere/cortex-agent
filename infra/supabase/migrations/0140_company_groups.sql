-- Optional founder-owned grouping. A group is navigation metadata, never an
-- authorization boundary: every company read still requires ba_member.
create table if not exists public.company_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  created_by_account_id text not null references public.ba_user(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.company_group_admins (
  group_id uuid not null references public.company_groups(id) on delete cascade,
  account_id text not null references public.ba_user(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, account_id)
);

create table if not exists public.company_group_companies (
  group_id uuid not null references public.company_groups(id) on delete cascade,
  organization_id text not null unique references public.ba_organization(id) on delete cascade,
  added_by_account_id text not null references public.ba_user(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, organization_id)
);

create or replace function public.guard_company_group_company() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from public.company_group_admins a
    where a.group_id = new.group_id and a.account_id = new.added_by_account_id
  ) then raise exception 'group administrator required'; end if;
  if not exists (
    select 1 from public.ba_organization o
    join public.ba_member m on m."organizationId" = o.id
    where o.id = new.organization_id and o.kind = 'company'
      and m."userId" = new.added_by_account_id and m.role = 'owner'
  ) then raise exception 'company owner required'; end if;
  return new;
end $$;

drop trigger if exists company_group_company_guard on public.company_group_companies;
create trigger company_group_company_guard before insert or update on public.company_group_companies
for each row execute function public.guard_company_group_company();

create or replace function public.remove_company_group_on_owner_loss() returns trigger
language plpgsql as $$
begin
  if old.role = 'owner' and (
    tg_op = 'DELETE' or new.role <> 'owner' or new."organizationId" <> old."organizationId"
  ) then
    delete from public.company_group_companies c
    where c.organization_id = old."organizationId"
      and c.added_by_account_id = old."userId"
      and not exists (
        select 1 from public.ba_member m where m."organizationId" = old."organizationId"
          and m."userId" = old."userId" and m.role = 'owner'
      );
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists company_group_owner_loss on public.ba_member;
create trigger company_group_owner_loss after delete or update of role, "organizationId" on public.ba_member
for each row execute function public.remove_company_group_on_owner_loss();

alter table public.company_groups enable row level security;
alter table public.company_group_admins enable row level security;
alter table public.company_group_companies enable row level security;
revoke all on public.company_groups, public.company_group_admins, public.company_group_companies from anon, authenticated;
grant select, insert, update, delete on public.company_groups, public.company_group_admins, public.company_group_companies to service_role;

drop policy if exists company_groups_service on public.company_groups;
create policy company_groups_service on public.company_groups for all to service_role using (true) with check (true);
drop policy if exists company_group_admins_service on public.company_group_admins;
create policy company_group_admins_service on public.company_group_admins for all to service_role using (true) with check (true);
drop policy if exists company_group_companies_service on public.company_group_companies;
create policy company_group_companies_service on public.company_group_companies for all to service_role using (true) with check (true);
