-- Auto-provision public.users on auth signup; reject non-Cortex domain
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer as $$
declare
  v_domain text := lower(split_part(new.email, '@', 2));
  v_allowed text := coalesce(current_setting('app.allowed_email_domain', true), 'Cortex.com');
begin
  if v_domain <> v_allowed then
    raise exception 'sign-in restricted to % accounts', v_allowed;
  end if;
  insert into public.users(id, email, name, role, google_sub)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    case when not exists (select 1 from public.users) then 'org_admin'::user_role else 'member'::user_role end,
    new.raw_user_meta_data->>'sub'
  )
  on conflict (id) do update
    set email = excluded.email, name = coalesce(excluded.name, public.users.name);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
