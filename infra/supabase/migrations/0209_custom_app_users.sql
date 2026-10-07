-- ===========================================================================
-- APLICACIONES, FASE 2: USUARIOS EXTERNOS (SIN CUENTA DE CORTEX) E INSTALABLE
-- ===========================================================================
-- Hasta la 0208 sólo entraban a una app los miembros de Cortex con un rol. Un
-- operario de planta o un cliente no tienen (ni tienen por qué tener) cuenta
-- de Cortex: reciben un enlace por correo, escriben un código de 6 dígitos y
-- entran a SU app con SU rol. Sin better-auth: sesión propia, corta de
-- entender y revocable. Ver docs/plans/aplicaciones.md y docs/features/apps.md.
--
-- DECIDIDO (2026-10-06): los usuarios de app son ilimitados y NO cuentan como
-- asientos del plan; sí aplican topes de uso (envíos, subidas, dictados). La
-- entrada va sólo por correo (no hay código por WhatsApp).
--
--   · custom_app_users        — el usuario externo: correo, rol, atributos
--                               ($user.<atributo> en los filtros de fila) y
--                               estado (invited → active al primer ingreso;
--                               disabled lo saca en la siguiente petición).
--   · custom_app_sessions     — una por dispositivo. El navegador guarda el
--                               token; aquí sólo su hash (sha256), así que una
--                               fila filtrada no sirve para entrar.
--   · custom_app_login_codes  — el código de 6 dígitos, también sólo en hash,
--                               con vencimiento (10 min) e intentos (a los 5 se
--                               bloquea ese código).
--
-- «OWN» PARA EXTERNOS. `tracker_rows.created_by` es de los miembros de Cortex
-- (uuid de ba_user, 0115); un usuario externo no es ese uuid. Para que «own»
-- funcione igual en los dos mundos sin mezclarlos, la fila lleva además
-- `created_by_app_user`: «own» de un miembro mira `created_by`, «own» de un
-- externo mira `created_by_app_user`. Nunca se comparan entre sí.
--
-- QUIÉN HIZO QUÉ. `custom_view_events.actor_kind` dice si `actor` es un miembro
-- o un usuario externo de la app; los envíos (`custom_view_submissions.
-- submitted_by`) llevan el id del usuario externo, que es un uuid propio y no
-- choca con ningún miembro.
--
-- Tenencia: `organization_id` en cada fila y `tenant()` en tenancy/tables.ts.
-- RLS como 0208: sólo service_role, con el cliente acotado (`getOrgScopedClient`).

create table if not exists public.custom_app_users (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  app_id            uuid not null references public.custom_apps (id) on delete cascade,
  name              text not null,
  -- Siempre en minúsculas: se compara tal cual.
  email             text not null,
  role_key          text not null,
  -- { "cliente": "Andina" }: lo que leen los filtros $user.<atributo>.
  attributes        jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  status            text not null default 'invited' check (status in ('invited', 'active', 'disabled')),
  invited_at        timestamptz,
  last_seen_at      timestamptz,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint custom_app_users_name_len check (char_length(btrim(name)) between 1 and 80),
  constraint custom_app_users_email_shape check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 200),
  constraint custom_app_users_role_shape check (role_key ~ '^[a-z][a-z0-9_]{1,31}$')
);

create unique index if not exists custom_app_users_app_email_idx
  on public.custom_app_users (app_id, email);
create index if not exists custom_app_users_org_app_idx
  on public.custom_app_users (organization_id, app_id, created_at);

create table if not exists public.custom_app_sessions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  app_id            uuid not null references public.custom_apps (id) on delete cascade,
  app_user_id       uuid not null references public.custom_app_users (id) on delete cascade,
  -- sha256 del token (base64url). El token sólo vive en la cookie del navegador.
  token_hash        text not null,
  expires_at        timestamptz not null,
  last_seen_at      timestamptz not null default now(),
  -- Navegador y sistema, cortos: para que la persona reconozca «este celular».
  device            text not null default '',
  created_at        timestamptz not null default now(),
  revoked_at        timestamptz,

  constraint custom_app_sessions_device_len check (char_length(device) <= 120)
);

create unique index if not exists custom_app_sessions_token_idx
  on public.custom_app_sessions (token_hash);
create index if not exists custom_app_sessions_user_idx
  on public.custom_app_sessions (organization_id, app_user_id)
  where revoked_at is null;

create table if not exists public.custom_app_login_codes (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  app_id            uuid not null references public.custom_apps (id) on delete cascade,
  app_user_id       uuid not null references public.custom_app_users (id) on delete cascade,
  code_hash         text not null,
  channel           text not null default 'email' check (channel in ('email')),
  expires_at        timestamptz not null,
  -- Intentos fallidos; a los 5 el código ya no sirve aunque no haya vencido.
  attempts          integer not null default 0 check (attempts >= 0),
  consumed_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists custom_app_login_codes_user_idx
  on public.custom_app_login_codes (organization_id, app_user_id, created_at desc);

alter table public.tracker_rows
  add column if not exists created_by_app_user uuid;
create index if not exists tracker_rows_created_by_app_user_idx
  on public.tracker_rows (tracker_id, created_by_app_user)
  where created_by_app_user is not null;

alter table public.custom_view_events
  add column if not exists actor_kind text not null default 'member';
alter table public.custom_view_events
  drop constraint if exists custom_view_events_actor_kind_check;
alter table public.custom_view_events
  add constraint custom_view_events_actor_kind_check
  check (actor_kind in ('member', 'app_user'));

comment on table public.custom_app_users is
  'Usuario externo de una app (sin cuenta de Cortex): correo, rol, atributos y estado. Entra con un código por correo. No cuenta como asiento del plan.';
comment on table public.custom_app_sessions is
  'Sesión de un usuario externo en un dispositivo: sólo el hash del token; se revoca al cerrar sesión o al desactivar al usuario.';
comment on table public.custom_app_login_codes is
  'Código de 6 dígitos (en hash) enviado por correo: vence a los 10 minutos y se bloquea a los 5 intentos fallidos.';
comment on column public.tracker_rows.created_by_app_user is
  'Si la fila la creó un usuario externo de una app, su id: es el «own» de los externos (created_by es de los miembros).';
comment on column public.custom_view_events.actor_kind is
  'member = actor es un miembro de Cortex; app_user = actor es un usuario externo de la app.';

alter table public.custom_app_users enable row level security;
alter table public.custom_app_sessions enable row level security;
alter table public.custom_app_login_codes enable row level security;

revoke all on table public.custom_app_users from public, anon, authenticated;
revoke all on table public.custom_app_sessions from public, anon, authenticated;
revoke all on table public.custom_app_login_codes from public, anon, authenticated;

grant select, insert, update, delete on table public.custom_app_users to service_role;
grant select, insert, update, delete on table public.custom_app_sessions to service_role;
grant select, insert, update, delete on table public.custom_app_login_codes to service_role;
