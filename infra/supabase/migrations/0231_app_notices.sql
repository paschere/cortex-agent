-- ===========================================================================
-- APLICACIONES: AVISOS AUTOMÁTICOS (bandeja, preferencias y qué recibe cada rol)
-- ===========================================================================
-- Al crear o cambiar una fila, la app avisa SOLA a los roles que dependen de esa
-- tabla (la leen en una pantalla, la aprueban o tienen botones sobre ella), a
-- quien se le asigna un registro, a quien tiene algo por aprobar y al creador
-- cuando cambia el estado de lo suyo. Sin reglas que nadie escribió. Ver
-- packages/agent-tools/src/apps/notices/.
--
--   · custom_app_notices        — la bandeja: un aviso por persona y suceso.
--                                 `dedupe_key` es ÚNICA (app + tipo + fila +
--                                 versión del suceso + persona): el mismo
--                                 cambio emitido dos veces deja UN aviso.
--                                 `silent` = se guardó pero no suena (persona
--                                 silenciada o ráfaga ya resumida). Cuenta por
--                                 pantalla (`screen`) los «3 nuevos» del menú.
--   · custom_app_notice_prefs   — lo que cada persona elige en cada app: todo /
--                                 sólo lo mío y asignaciones / nada, correo y
--                                 silenciar hasta una hora.
--   · custom_app_notice_config  — qué avisos recibe cada rol (JSON validado en
--                                 código: { roles: { supervisor: { new: true,
--                                 … } } }); lo omitido toma el valor por defecto.
--
-- La persona es un miembro de Cortex (`member`) o un usuario externo de la app
-- (`app_user`): sus ids no se mezclan. Tenencia: `organization_id` en cada fila
-- y `tenant()` en tenancy/tables.ts; RLS como 0208: sólo service_role.

create table if not exists public.custom_app_notices (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  app_id            uuid not null references public.custom_apps (id) on delete cascade,
  recipient_kind    text not null check (recipient_kind in ('member', 'app_user')),
  recipient_id      uuid not null,
  kind              text not null check (kind in ('new', 'assigned', 'approval', 'changed')),
  tracker_id        uuid,
  tracker_name      text not null default '',
  -- Slug de la pantalla que abre el aviso; null = la de inicio.
  screen            text,
  row_id            uuid,
  title             text not null,
  body              text not null default '',
  actor_name        text not null default '',
  silent            boolean not null default false,
  dedupe_key        text not null,
  read_at           timestamptz,
  created_at        timestamptz not null default now(),

  constraint custom_app_notices_title_len check (char_length(title) between 1 and 200),
  constraint custom_app_notices_key_len check (char_length(dedupe_key) <= 300)
);

create unique index if not exists custom_app_notices_dedupe_idx
  on public.custom_app_notices (dedupe_key);
-- La bandeja de una persona, de lo más nuevo a lo más viejo.
create index if not exists custom_app_notices_inbox_idx
  on public.custom_app_notices (organization_id, app_id, recipient_kind, recipient_id, created_at desc);
-- Lo no leído (los contadores por pantalla).
create index if not exists custom_app_notices_unread_idx
  on public.custom_app_notices (app_id, recipient_kind, recipient_id)
  where read_at is null;
-- Anti-ráfaga: cuántos del mismo grupo llegaron en la última ventana.
create index if not exists custom_app_notices_burst_idx
  on public.custom_app_notices (app_id, recipient_kind, recipient_id, kind, tracker_id, created_at desc);

create table if not exists public.custom_app_notice_prefs (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  app_id            uuid not null references public.custom_apps (id) on delete cascade,
  recipient_kind    text not null check (recipient_kind in ('member', 'app_user')),
  recipient_id      uuid not null,
  level             text not null default 'all' check (level in ('all', 'mine', 'none')),
  email             boolean not null default false,
  muted_until       timestamptz,
  updated_at        timestamptz not null default now()
);

create unique index if not exists custom_app_notice_prefs_person_idx
  on public.custom_app_notice_prefs (app_id, recipient_kind, recipient_id);

create table if not exists public.custom_app_notice_config (
  app_id            uuid primary key references public.custom_apps (id) on delete cascade,
  organization_id   text not null,
  config            jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  updated_by        uuid,
  updated_at        timestamptz not null default now()
);

comment on table public.custom_app_notices is
  'Bandeja de avisos automáticos de una app, por persona (miembro o externo). dedupe_key única = idempotencia por suceso; silent = guardado sin sonar.';
comment on table public.custom_app_notice_prefs is
  'Lo que cada persona elige recibir en una app: all | mine | none, correo y silenciar hasta una hora.';
comment on table public.custom_app_notice_config is
  'Qué avisos automáticos recibe cada rol de una app (JSON validado en código; lo omitido toma el valor por defecto).';

alter table public.custom_app_notices enable row level security;
alter table public.custom_app_notice_prefs enable row level security;
alter table public.custom_app_notice_config enable row level security;

revoke all on table public.custom_app_notices from public, anon, authenticated;
revoke all on table public.custom_app_notice_prefs from public, anon, authenticated;
revoke all on table public.custom_app_notice_config from public, anon, authenticated;

grant select, insert, update, delete on table public.custom_app_notices to service_role;
grant select, insert, update, delete on table public.custom_app_notice_prefs to service_role;
grant select, insert, update, delete on table public.custom_app_notice_config to service_role;
