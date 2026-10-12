-- Aplicaciones: lugares con radio (geocercas) para el equipo en turno (0224).
--
-- Los LUGARES (bodega, cliente X: nombre, centro, radio, a quién avisar) viven
-- dentro de `custom_apps.location` (jsonb, 0216) bajo la llave `geofences`:
-- cambiar un lugar no es una migración. Lo que sí necesita tablas es lo que el
-- servidor tiene que recordar entre una posición y la siguiente:
--
--   · custom_app_geofence_state  — si cada persona está ADENTRO o AFUERA de cada
--                                  lugar. Sin esto no se sabe si una posición
--                                  nueva es «llegó» o sólo «sigue ahí». Una fila
--                                  por (app, lugar, persona); se borra al
--                                  terminar el turno, revocar o quitar a la
--                                  persona (misma regla que la posición).
--   · custom_app_geofence_events — «llegó a la bodega» / «salió de la bodega»:
--                                  el registro de cada cruce, para el tablero y
--                                  la auditoría. Sólo guarda lugar, persona, hora
--                                  y el sentido; NO guarda coordenadas. Un
--                                  trabajo diario lo borra con la retención de
--                                  la app (la misma de la ubicación).
--
-- Persona = (kind, id) como en 0216. Tenencia: organization_id + tenant() en
-- tenancy/tables.ts. RLS sólo para service_role.

create table if not exists public.custom_app_geofence_state (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  app_id           uuid not null references public.custom_apps (id) on delete cascade,
  -- El id del lugar dentro de custom_apps.location.geofences (texto corto).
  geofence_id      text not null check (char_length(geofence_id) between 1 and 40),
  subject_kind     text not null check (subject_kind in ('member', 'app_user')),
  subject_id       uuid not null,
  inside           boolean not null default false,
  -- Desde cuándo está en este estado (adentro o afuera).
  since            timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists custom_app_geofence_state_subject_idx
  on public.custom_app_geofence_state (app_id, geofence_id, subject_kind, subject_id);
create index if not exists custom_app_geofence_state_inside_idx
  on public.custom_app_geofence_state (organization_id, app_id)
  where inside;

create table if not exists public.custom_app_geofence_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  app_id           uuid not null references public.custom_apps (id) on delete cascade,
  geofence_id      text not null check (char_length(geofence_id) between 1 and 40),
  geofence_name    text not null check (char_length(geofence_name) between 1 and 80),
  subject_kind     text not null check (subject_kind in ('member', 'app_user')),
  subject_id       uuid not null,
  subject_name     text not null check (char_length(subject_name) between 1 and 120),
  kind             text not null check (kind in ('enter', 'leave')),
  at               timestamptz not null default now()
);

create index if not exists custom_app_geofence_events_app_idx
  on public.custom_app_geofence_events (organization_id, app_id, at desc);
create index if not exists custom_app_geofence_events_subject_idx
  on public.custom_app_geofence_events (app_id, subject_kind, subject_id, at desc);

comment on table public.custom_app_geofence_state is
  'Si cada persona en turno está adentro o afuera de cada lugar (geocerca) de la app. Se borra al terminar el turno, revocar o quitar a la persona.';
comment on table public.custom_app_geofence_events is
  'Cruces de geocercas (llegó / salió): lugar, persona, hora y sentido; sin coordenadas. Se borra con la retención de ubicación de la app.';

alter table public.custom_app_geofence_state enable row level security;
alter table public.custom_app_geofence_events enable row level security;

revoke all on table public.custom_app_geofence_state from public, anon, authenticated;
revoke all on table public.custom_app_geofence_events from public, anon, authenticated;

grant select, insert, update, delete on table public.custom_app_geofence_state to service_role;
grant select, insert, update, delete on table public.custom_app_geofence_events to service_role;
