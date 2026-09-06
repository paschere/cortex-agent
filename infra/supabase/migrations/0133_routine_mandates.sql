-- Opt-in transition from legacy unattended approval to scoped mandates.
alter table public.scheduled_jobs add column mandate_only boolean not null default false;
alter table public.mandates add column routine_id uuid references public.scheduled_jobs(id) on delete restrict;
create function public.guard_routine_mandate() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and new.routine_id is distinct from old.routine_id then
    raise exception 'El alcance de un mandato no se puede cambiar. Revócalo y crea otro.';
  end if;
  if new.routine_id is not null then
    if not exists(select 1 from scheduled_jobs where id=new.routine_id and organization_id=new.organization_id) then raise exception 'La rutina no pertenece a esta empresa.'; end if;
    update scheduled_jobs set mandate_only=true where id=new.routine_id and organization_id=new.organization_id;
  end if;
  return new;
end; $$;
revoke all on function public.guard_routine_mandate() from public,anon,authenticated;
create trigger routine_mandate_scope before insert or update on public.mandates for each row execute function public.guard_routine_mandate();
