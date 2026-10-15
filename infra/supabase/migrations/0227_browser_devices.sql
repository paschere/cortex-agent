-- 0227 · CORTEX EN TU CHROME.
--
-- Una extensión de Chrome (apps/extension) que deja a Cortex trabajar en el
-- navegador de la persona, con SUS sesiones abiertas (el portal del banco, la
-- DIAN) donde el navegador en la nube no puede entrar. Es lo más sensible que
-- hace el producto, así que cada pieza de abajo existe para poder decir «no»:
--
--   browser_devices        un Chrome emparejado. El token vive en la extensión;
--                          aquí solo su hash. Revocable, con vencimiento.
--   browser_pairing_codes  el código corto de 10 minutos que canjea un token.
--                          También guardado como hash, de un solo uso.
--   browser_device_sites   lo que la persona decidió por sitio: «siempre» o
--                          «nunca». La extensión es la que manda; esto es el
--                          espejo para mostrarlo y revocarlo desde Ajustes.
--   browser_device_sessions una pestaña de trabajo (id chr_…), con su tope de
--                          acciones, su estado y a quién espera.
--   browser_device_commands la cola de órdenes Y la auditoría: qué dispositivo,
--                          qué sitio, qué acción, cómo salió. El cuerpo con el
--                          texto escrito se borra al terminar.
--   browser_device_shots   las fotos chicas de cada paso (sin bytes en el chat).
--
-- Todo es del dueño: el servicio solo toca filas de (organización, usuario).

create table if not exists public.browser_devices (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 80),
  token_hash       text not null unique,
  token_prefix     text not null,
  ext_version      text check (ext_version is null or length(ext_version) <= 32),
  user_agent       text check (user_agent is null or length(user_agent) <= 300),
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz,
  expires_at       timestamptz not null,
  revoked_at       timestamptz
);
create index if not exists browser_devices_owner_idx
  on public.browser_devices (organization_id, user_id, created_at desc);

create table if not exists public.browser_pairing_codes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  code_hash        text not null unique,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  used_at          timestamptz
);
create index if not exists browser_pairing_codes_owner_idx
  on public.browser_pairing_codes (organization_id, user_id, created_at desc);

create table if not exists public.browser_device_sites (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  device_id        uuid not null references public.browser_devices(id) on delete cascade,
  site             text not null check (length(site) between 3 and 253),
  decision         text not null check (decision in ('always', 'never')),
  created_at       timestamptz not null default now(),
  unique (device_id, site)
);
create index if not exists browser_device_sites_owner_idx
  on public.browser_device_sites (organization_id, user_id);

create table if not exists public.browser_device_sessions (
  id               text primary key check (id ~ '^chr_[a-f0-9]{16}$'),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  device_id        uuid not null references public.browser_devices(id) on delete cascade,
  conversation_id  uuid references public.conversations(id) on delete set null,
  purpose          text not null default '' check (length(purpose) <= 200),
  status           text not null default 'open' check (status in ('open', 'closed', 'stopped')),
  -- Tope duro de acciones por sesión; `actions_count` sube con cada orden que cuenta.
  action_cap       integer not null default 150 check (action_cap between 1 and 1000),
  actions_count    integer not null default 0 check (actions_count >= 0),
  -- A quién espera Cortex: { kind: 'help' | 'secret', reason|label, at }.
  awaiting         jsonb,
  last_url         text check (last_url is null or length(last_url) <= 2000),
  last_title       text check (last_title is null or length(last_title) <= 500),
  stopped_by       text check (stopped_by is null or stopped_by in ('person_panel', 'person_extension', 'cap', 'device')),
  created_at       timestamptz not null default now(),
  closed_at        timestamptz
);
create index if not exists browser_device_sessions_owner_idx
  on public.browser_device_sessions (organization_id, user_id, created_at desc);
create index if not exists browser_device_sessions_device_idx
  on public.browser_device_sessions (device_id, status);

create table if not exists public.browser_device_commands (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  device_id        uuid not null references public.browser_devices(id) on delete cascade,
  session_id       text not null references public.browser_device_sessions(id) on delete cascade,
  op               text not null check (length(op) between 2 and 20),
  -- Auditoría: el sitio y un resumen sin contenido (el texto escrito solo su largo).
  site             text,
  audit            jsonb not null default '{}'::jsonb,
  -- La orden completa, hasta que termina; después se borra.
  payload          jsonb,
  status           text not null default 'pending'
                   check (status in ('pending', 'delivered', 'done', 'failed', 'expired')),
  result           jsonb,
  result_code      text,
  created_at       timestamptz not null default now(),
  delivered_at     timestamptz,
  completed_at     timestamptz
);
create index if not exists browser_device_commands_queue_idx
  on public.browser_device_commands (device_id, created_at) where status = 'pending';
create index if not exists browser_device_commands_audit_idx
  on public.browser_device_commands (organization_id, user_id, created_at desc);
create index if not exists browser_device_commands_session_idx
  on public.browser_device_commands (session_id, created_at);

create table if not exists public.browser_device_shots (
  id               text primary key check (id ~ '^[a-f0-9]{24}$'),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  session_id       text not null references public.browser_device_sessions(id) on delete cascade,
  jpeg_b64         text not null check (length(jpeg_b64) <= 120000),
  created_at       timestamptz not null default now()
);
create index if not exists browser_device_shots_session_idx
  on public.browser_device_shots (session_id, created_at);

do $$
declare t text;
begin
  foreach t in array array[
    'browser_devices', 'browser_pairing_codes', 'browser_device_sites',
    'browser_device_sessions', 'browser_device_commands', 'browser_device_shots'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_service_only', t);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      t || '_service_only', t
    );
  end loop;
end $$;

comment on table public.browser_devices is
  'Cortex en tu Chrome (0227): un Chrome emparejado. Solo el hash del token; revocable y con vencimiento.';
comment on table public.browser_device_commands is
  'Cortex en tu Chrome (0227): cola de órdenes y auditoría (dispositivo, sitio, acción, resultado). El cuerpo con texto se borra al terminar.';
