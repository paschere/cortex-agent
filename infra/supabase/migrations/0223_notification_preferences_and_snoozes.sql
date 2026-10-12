-- 0223 · PREFERENCIAS DE AVISOS POR PERSONA Y POSPONER EN «HOY».
--
-- 1. notification_preferences: qué avisos quiere cada persona, por categoría y
--    por canal (campana, celular, correo, WhatsApp), más horas de silencio.
--    SIN fila = el comportamiento de siempre (todo permitido, WhatsApp apagado).
--    Sólo se guardan las diferencias: `channels` es
--      { "<categoría>": { "bell": bool, "push": bool, "email": bool, "whatsapp": bool } }
--    y una clave ausente significa «como por defecto». Se hace cumplir en el
--    servidor (notify(), push, correo, «Tu día»), no en la pantalla.
--
-- 2. hoy_snoozes: cosas de «Para ti, hoy» pospuestas hasta una hora. Mientras
--    `until_at` esté en el futuro la cosa no se muestra; al pasar, reaparece sola.
--    `item_key` es el id con el que Hoy identifica la cosa (id del piloto, o
--    «cola-id» de una cola de espera).
--
-- Ambas: tenant (organization_id), sólo service_role (RLS), igual que las demás.

create table if not exists public.notification_preferences (
  organization_id text not null references public.ba_organization(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  channels        jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(channels) = 'object'),
  quiet_enabled   boolean not null default false,
  -- «HH:MM» en hora de Bogotá. Por defecto de 22:00 a 07:00.
  quiet_start     text not null default '22:00' check (quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end       text not null default '07:00' check (quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);

comment on table public.notification_preferences is
  'Preferencias de avisos por persona (0223): por categoría y canal, y horas de silencio. Sin fila = comportamiento por defecto. Se aplica en el servidor.';

alter table public.notification_preferences enable row level security;
drop policy if exists notification_preferences_service_only on public.notification_preferences;
create policy notification_preferences_service_only on public.notification_preferences
  for all to service_role using (true) with check (true);

create table if not exists public.hoy_snoozes (
  id              uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  item_key        text not null check (length(item_key) between 1 and 300),
  title           text check (title is null or length(title) <= 300),
  until_at        timestamptz not null,
  created_at      timestamptz not null default now(),
  unique (organization_id, user_id, item_key)
);

comment on table public.hoy_snoozes is
  'Cosas de «Para ti, hoy» pospuestas por una persona hasta until_at (0223). Reaparecen solas al pasar la hora.';

create index if not exists hoy_snoozes_user_idx
  on public.hoy_snoozes (organization_id, user_id, until_at);

alter table public.hoy_snoozes enable row level security;
drop policy if exists hoy_snoozes_service_only on public.hoy_snoozes;
create policy hoy_snoozes_service_only on public.hoy_snoozes
  for all to service_role using (true) with check (true);
