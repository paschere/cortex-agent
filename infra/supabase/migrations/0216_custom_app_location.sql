-- Aplicaciones: ubicación del equipo en un mapa, y tareas asignadas (0216).
--
-- Una app puede mostrar en un mapa DÓNDE están las personas que la usan y
-- asignarles tareas. Es el dato más delicado que guarda Cortex sobre una
-- persona (dónde está), y se diseña con la Ley 1581 de 2012 (habeas data) en la
-- mano: finalidad clara, consentimiento previo y revocable, mínimo necesario,
-- retención corta y acceso sólo para quien tiene el permiso.
--
--   · custom_apps.location       — { enabled, retentionDays }. Apagado por
--                                  defecto: sin esto nadie comparte nada.
--   · custom_app_location_consents — una fila por persona y app: qué versión del
--                                  texto aceptó y cuándo, si lo revocó, y si
--                                  está «en turno». Sin consentimiento vigente
--                                  el servidor NO acepta una posición.
--   · custom_app_locations       — la ÚLTIMA posición de cada persona en turno.
--                                  Al terminar el turno o revocar, se borra.
--   · custom_app_location_history — rastro corto (una muestra por minuto como
--                                  mucho) que un trabajo diario borra pasados
--                                  `retentionDays` (30 por defecto).
--
-- «Persona» = (kind, id): un miembro de Cortex (ba_user) o un usuario externo
-- de la app (custom_app_users). Son uuids de mundos distintos; nunca se cruzan.
--
-- Tenencia: organization_id en todo y tenant() en tenancy/tables.ts. RLS sólo
-- para service_role, como 0208/0209.

alter table public.custom_apps
  add column if not exists location jsonb not null default '{}'::jsonb;
alter table public.custom_apps
  drop constraint if exists custom_apps_location_object;
alter table public.custom_apps
  add constraint custom_apps_location_object check (jsonb_typeof(location) = 'object');

create table if not exists public.custom_app_location_consents (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  app_id           uuid not null references public.custom_apps (id) on delete cascade,
  subject_kind     text not null check (subject_kind in ('member', 'app_user')),
  subject_id       uuid not null,
  -- Versión del texto que la persona aceptó; si el texto cambia, vuelve a aceptar.
  text_version     text not null,
  accepted_at      timestamptz not null default now(),
  revoked_at       timestamptz,
  on_shift         boolean not null default false,
  shift_started_at timestamptz,
  shift_ended_at   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint custom_app_location_consents_version_len check (char_length(text_version) between 1 and 40)
);

create unique index if not exists custom_app_location_consents_subject_idx
  on public.custom_app_location_consents (app_id, subject_kind, subject_id);
create index if not exists custom_app_location_consents_org_idx
  on public.custom_app_location_consents (organization_id, app_id)
  where on_shift;

create table if not exists public.custom_app_locations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  app_id           uuid not null references public.custom_apps (id) on delete cascade,
  subject_kind     text not null check (subject_kind in ('member', 'app_user')),
  subject_id       uuid not null,
  lat              double precision not null check (lat between -90 and 90),
  lng              double precision not null check (lng between -180 and 180),
  accuracy_m       real check (accuracy_m is null or (accuracy_m >= 0 and accuracy_m <= 100000)),
  heading          real check (heading is null or (heading >= 0 and heading <= 360)),
  speed_mps        real check (speed_mps is null or (speed_mps >= 0 and speed_mps <= 400)),
  battery_pct      smallint check (battery_pct is null or (battery_pct between 0 and 100)),
  recorded_at      timestamptz not null default now(),
  -- Cuándo se guardó la última muestra del historial (para no guardar una por ping).
  history_at       timestamptz
);

create unique index if not exists custom_app_locations_subject_idx
  on public.custom_app_locations (app_id, subject_kind, subject_id);
create index if not exists custom_app_locations_org_idx
  on public.custom_app_locations (organization_id, app_id, recorded_at desc);

create table if not exists public.custom_app_location_history (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  app_id           uuid not null references public.custom_apps (id) on delete cascade,
  subject_kind     text not null check (subject_kind in ('member', 'app_user')),
  subject_id       uuid not null,
  lat              double precision not null check (lat between -90 and 90),
  lng              double precision not null check (lng between -180 and 180),
  accuracy_m       real check (accuracy_m is null or (accuracy_m >= 0 and accuracy_m <= 100000)),
  recorded_at      timestamptz not null default now()
);

create index if not exists custom_app_location_history_app_idx
  on public.custom_app_location_history (organization_id, app_id, recorded_at);
create index if not exists custom_app_location_history_subject_idx
  on public.custom_app_location_history (app_id, subject_kind, subject_id, recorded_at desc);

comment on column public.custom_apps.location is
  '{ enabled, retentionDays }: compartir ubicación del equipo. Apagado por defecto; la retención del historial es de 1 a 365 días (30 por defecto).';
comment on table public.custom_app_location_consents is
  'Consentimiento de ubicación por persona y app (versión del texto, fecha, revocación) y su turno. Sin consentimiento vigente y turno abierto, el servidor no guarda posiciones.';
comment on table public.custom_app_locations is
  'Última posición de cada persona en turno. Se borra al terminar el turno o revocar.';
comment on table public.custom_app_location_history is
  'Historial corto de posiciones; un trabajo diario borra lo que pasa la retención de la app.';

alter table public.custom_app_location_consents enable row level security;
alter table public.custom_app_locations enable row level security;
alter table public.custom_app_location_history enable row level security;

revoke all on table public.custom_app_location_consents from public, anon, authenticated;
revoke all on table public.custom_app_locations from public, anon, authenticated;
revoke all on table public.custom_app_location_history from public, anon, authenticated;

grant select, insert, update, delete on table public.custom_app_location_consents to service_role;
grant select, insert, update, delete on table public.custom_app_locations to service_role;
grant select, insert, update, delete on table public.custom_app_location_history to service_role;
