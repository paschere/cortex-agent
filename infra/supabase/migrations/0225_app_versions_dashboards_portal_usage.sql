-- Aplicaciones, fase 6: tableros por rol, portal de clientes, versiones y uso.
--
--   · custom_apps.dashboards — los «Tableros» de la app (una lista de
--       { id, title, roles, widgets: [kpi|chart|status|ranking|pending] }).
--       Como el Inicio (0215) no son vistas guardadas: se calculan al abrirlos
--       con el rol de quien mira. La forma se valida en código
--       (packages/agent-tools/src/apps/tablero.ts).
--   · custom_apps.portal — el portal de clientes: { enabled, roleKey, title,
--       shipments?, invoices?, documents?, upload?, pay? }, ver
--       packages/agent-tools/src/apps/client-portal.ts. Un rol «cliente» sigue
--       siendo un rol de siempre con scope `{field, equals: $user.cliente}`.
--   · app_versions — cada «Publicar» guarda una foto de la app (pantallas con
--       su spec, roles, inicio, apariencia, tableros, portal). Quien usa la app
--       (miembros con rol y usuarios externos) ve la ÚLTIMA versión; el trabajo
--       en curso es el borrador y sólo lo ve quien administra. Los datos de las
--       tablas no se versionan: viven una sola vez.
--   · custom_app_events — lo mínimo para «Uso»: abrir una pantalla, empezar y
--       enviar un formulario. Sin contenido de filas ni ubicación.
--
-- Todo en tablas con organization_id y acceso sólo para service_role, como las
-- demás de las apps (0208).

alter table public.custom_apps
  add column if not exists dashboards jsonb not null default '[]'::jsonb,
  add column if not exists portal     jsonb not null default '{}'::jsonb;

alter table public.custom_apps
  drop constraint if exists custom_apps_dashboards_array,
  drop constraint if exists custom_apps_portal_object;
alter table public.custom_apps
  add constraint custom_apps_dashboards_array check (jsonb_typeof(dashboards) = 'array'),
  add constraint custom_apps_portal_object check (jsonb_typeof(portal) = 'object');

create table if not exists public.app_versions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  app_id            uuid not null references public.custom_apps (id) on delete cascade,
  -- 1, 2, 3… por app. La publicada es la de número más alto.
  number            integer not null check (number >= 1),
  -- { v: 1, app: {...}, screens: [{ slug, title, icon, roles, viewId, viewName, spec }],
  --   roles: [{ key, name, description, permissions }], home, brand, dashboards, portal }
  spec              jsonb not null check (jsonb_typeof(spec) = 'object'),
  note              text not null default '',
  created_by        uuid,
  created_at        timestamptz not null default now(),

  constraint app_versions_note_len check (char_length(note) <= 500)
);

create unique index if not exists app_versions_app_number_idx
  on public.app_versions (app_id, number);
create index if not exists app_versions_org_app_idx
  on public.app_versions (organization_id, app_id, number desc);

create table if not exists public.custom_app_events (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  app_id            uuid not null references public.custom_apps (id) on delete cascade,
  -- screen_open | form_start | form_submit
  kind              text not null check (kind in ('screen_open', 'form_start', 'form_submit')),
  screen            text,
  block_id          text,
  actor_id          uuid,
  actor_kind        text not null default 'member' check (actor_kind in ('member', 'app_user')),
  role_key          text,
  -- Une un «empezó» con su «envió» (el clientId del formulario).
  ref               text,
  created_at        timestamptz not null default now(),

  constraint custom_app_events_ref_len check (ref is null or char_length(ref) <= 80)
);

create index if not exists custom_app_events_app_time_idx
  on public.custom_app_events (app_id, created_at desc);
create index if not exists custom_app_events_org_idx
  on public.custom_app_events (organization_id, app_id, kind, created_at desc);

comment on table public.app_versions is
  'Fotos de una app al publicar: pantallas (con su spec), roles, inicio, apariencia, tableros y portal. La publicada es la de número más alto.';
comment on table public.custom_app_events is
  'Uso de una app: abrir pantalla, empezar y enviar un formulario. Alimenta la pestaña «Uso» del editor.';

alter table public.app_versions enable row level security;
alter table public.custom_app_events enable row level security;
revoke all on table public.app_versions from public, anon, authenticated;
revoke all on table public.custom_app_events from public, anon, authenticated;
grant select, insert, update, delete on table public.app_versions to service_role;
grant select, insert, update, delete on table public.custom_app_events to service_role;

-- Las apps que YA estaban publicadas arrancan con la versión 1 = lo que hoy ven
-- sus usuarios. Así, desde esta migración, un cambio en el editor no le llega a
-- nadie hasta que alguien publique.
insert into public.app_versions (organization_id, app_id, number, spec, note)
select
  a.organization_id,
  a.id,
  1,
  jsonb_build_object(
    'v', 1,
    'app', jsonb_build_object(
      'name', a.name,
      'description', a.description,
      'icon', a.icon,
      'theme', a.theme,
      'homeScreen', a.home_screen
    ),
    'screens', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'slug', s.slug,
          'title', s.title,
          'icon', s.icon,
          'roles', to_jsonb(s.roles),
          'viewId', s.view_id,
          'viewName', coalesce(v.name, s.title),
          'spec', coalesce(v.spec, '{}'::jsonb)
        ) order by s.position
      )
      from public.custom_app_screens s
      left join public.custom_views v on v.id = s.view_id and v.archived_at is null
      where s.app_id = a.id
    ), '[]'::jsonb),
    'roles', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'key', r.key,
          'name', r.name,
          'description', r.description,
          'permissions', r.permissions
        ) order by r.position
      )
      from public.custom_app_roles r
      where r.app_id = a.id
    ), '[]'::jsonb),
    'home', a.home,
    'brand', a.brand,
    'dashboards', a.dashboards,
    'portal', a.portal
  ),
  'Versión inicial: lo que ya estaba publicado'
from public.custom_apps a
where a.status = 'published'
  and a.archived_at is null
  and not exists (select 1 from public.app_versions x where x.app_id = a.id);
