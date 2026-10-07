-- ===========================================================================
-- APLICACIONES, FASE 4: MODO KIOSCO (DISPOSITIVO COMPARTIDO DE PLANTA)
-- ===========================================================================
-- Un celular de planta lo usan varios operarios. En vez de que cada uno entre
-- con código por correo, quien administra (o un supervisor con permiso) deja el
-- celular «en modo kiosco» para ESA app: el celular guarda un token de
-- DISPOSITIVO y, en adelante, cada persona entra con un PIN de 4 a 6 dígitos
-- ligado a su usuario. La sesión de la persona se cierra sola tras N minutos
-- sin uso y el celular vuelve a la lista de nombres.
--
-- Seguridad en corto (ver docs/features/apps.md, Fase 4):
--   · el PIN SÓLO sirve en un dispositivo autorizado y no revocado; en un
--     navegador cualquiera no abre nada;
--   · de cada PIN se guarda sólo un hash con sal (scrypt) y a los 5 intentos
--     fallidos ese usuario queda bloqueado un rato;
--   · el token del dispositivo vive en una cookie httpOnly y aquí sólo su
--     sha256; revocar el dispositivo corta las sesiones abiertas en él;
--   · lo que la persona registra queda a SU nombre (created_by_app_user), igual
--     que si hubiera entrado con código.
--
-- EMPAREJAR. Quien administra crea el dispositivo en el editor y recibe un enlace
-- de un solo uso; el celular lo abre y queda en modo kiosco, sin que nadie
-- tenga que iniciar sesión en él. Un supervisor con permiso puede además dejar
-- el celular que tiene en la mano.
--
-- Orden: esta migración es la 0211 (la 0210 es de las automatizaciones).

alter table public.custom_apps
  add column if not exists kiosk_enabled boolean not null default false,
  add column if not exists kiosk_idle_minutes integer not null default 5;
alter table public.custom_apps
  drop constraint if exists custom_apps_kiosk_idle_check;
alter table public.custom_apps
  add constraint custom_apps_kiosk_idle_check check (kiosk_idle_minutes between 1 and 120);

create table if not exists public.custom_app_devices (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  app_id            uuid not null references public.custom_apps (id) on delete cascade,
  name              text not null,
  -- sha256 del token del dispositivo (base64url); el token sólo vive en su cookie.
  -- Nulo mientras el celular no ha reclamado el enlace de emparejamiento.
  token_hash        text,
  -- Emparejar un celular desde el editor: un código de un solo uso que vence a
  -- los 15 minutos (también sólo en hash). Al reclamarlo se borra.
  pairing_hash      text,
  pairing_expires_at timestamptz,
  -- Quién lo dejó en modo kiosco: un miembro de Cortex (uuid) o un usuario de la app.
  created_by        uuid,
  created_by_kind   text not null default 'member' check (created_by_kind in ('member', 'app_user')),
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz,
  revoked_at        timestamptz,

  constraint custom_app_devices_name_len check (char_length(btrim(name)) between 1 and 60)
);

create unique index if not exists custom_app_devices_token_idx
  on public.custom_app_devices (token_hash) where token_hash is not null;
create unique index if not exists custom_app_devices_pairing_idx
  on public.custom_app_devices (pairing_hash) where pairing_hash is not null;
create index if not exists custom_app_devices_app_idx
  on public.custom_app_devices (organization_id, app_id, created_at);

-- El PIN de cada usuario de la app. Sólo el hash; los intentos y el bloqueo
-- viven aquí para que no se reinicien al cambiar de dispositivo.
alter table public.custom_app_users
  add column if not exists pin_hash text,
  add column if not exists pin_set_at timestamptz,
  add column if not exists pin_attempts integer not null default 0,
  add column if not exists pin_locked_until timestamptz;
alter table public.custom_app_users
  drop constraint if exists custom_app_users_pin_attempts_check;
alter table public.custom_app_users
  add constraint custom_app_users_pin_attempts_check check (pin_attempts >= 0);

-- Una sesión de kiosco nace en un dispositivo y vence por inactividad.
alter table public.custom_app_sessions
  add column if not exists device_id uuid references public.custom_app_devices (id) on delete cascade,
  add column if not exists idle_minutes integer;
create index if not exists custom_app_sessions_device_idx
  on public.custom_app_sessions (device_id)
  where device_id is not null and revoked_at is null;

comment on table public.custom_app_devices is
  'Dispositivo compartido de planta en modo kiosco para una app: sólo el hash de su token; revocable.';
comment on column public.custom_app_users.pin_hash is
  'Hash con sal (scrypt) del PIN de 4 a 6 dígitos con el que la persona entra en un dispositivo kiosco. Nunca el PIN.';
comment on column public.custom_app_sessions.device_id is
  'Si la sesión es de kiosco, el dispositivo donde se abrió; revocar el dispositivo la corta.';

alter table public.custom_app_devices enable row level security;
revoke all on table public.custom_app_devices from public, anon, authenticated;
grant select, insert, update, delete on table public.custom_app_devices to service_role;
