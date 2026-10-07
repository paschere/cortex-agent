-- ===========================================================================
-- APLICACIONES: VARIAS PANTALLAS, UN MENÚ, ROLES Y QUIÉN VE QUÉ
-- ===========================================================================
-- Una Vista (0156) es UNA pantalla que todos los del espacio ven igual. Una
-- Aplicación es un conjunto de pantallas con menú y con roles: el operario de
-- planta ve «Registrar» y «Mis registros» (sólo sus filas), el supervisor ve
-- «Por aprobar» (todas), gerencia ve el tablero y puede exportar.
-- Ver docs/plans/aplicaciones.md y docs/features/apps.md.
--
-- PRINCIPIO: REUTILIZAR, NO DUPLICAR. Una pantalla ES una vista: su spec vive
-- en `custom_views` (con `app_id` puesto) y `custom_app_screens` sólo dice en
-- qué app está, en qué orden, con qué ícono y qué roles la ven. Así los
-- formularios, ediciones, botones, versiones, envíos y eventos de una pantalla
-- son los mismos de una vista, con las mismas tablas (`custom_view_submissions`,
-- `custom_view_events`, `custom_view_versions`) y sin un segundo motor. Las
-- vistas de una app NO salen en /views: `listViews` filtra `app_id is null`.
--
--   · custom_apps          — la app: slug, nombre, ícono, tema, estado.
--   · custom_app_screens   — pantalla = vista + orden + ícono + roles (text[]).
--                            Un `roles` vacío = la ven todos los roles.
--   · custom_app_roles     — rol de la app con sus permisos en JSON:
--       { "tables": { "<slug>": { "read": "all" | "own" | {"field","equals":"$user.<atributo>"},
--                                 "create": bool, "edit": "none"|"own"|"all",
--                                 "fields"?: [campos que puede escribir],
--                                 "actions": [ids de botones, "__approve", "__reject"] } },
--         "export": bool }
--     La forma se valida en código (packages/agent-tools/src/apps/permissions.ts),
--     no aquí: cambiar un permiso no es una migración. Una tabla que NO está en
--     `tables` no se lee: el permiso se niega por defecto.
--   · custom_app_members   — qué miembro de Cortex entra con qué rol, y sus
--                            atributos (p.ej. {"cliente": "Andina"}) para los
--                            filtros `$user.<atributo>`. Quien es owner/admin de
--                            la empresa entra siempre como administrador, sin fila.
--
-- «Own» = `tracker_rows.created_by = usuario`: la columna existe desde la 0115
-- y `submitViewForm` ya la escribe para los miembros, así que no hace falta
-- otra. Los usuarios externos (fase 2) traerán su propia columna.
--
-- Tenencia: `organization_id` en cada fila y `tenant()` en tenancy/tables.ts.
-- RLS como 0160: sólo service_role, con el cliente acotado (`getOrgScopedClient`).

alter table public.custom_views
  add column if not exists app_id uuid;

create table if not exists public.custom_apps (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  slug              text not null,
  name              text not null,
  description       text not null default '',
  -- Un emoji corto o la URL https de un ícono.
  icon              text not null default '📱',
  -- { accent?: primary|emerald|amber|sky|rose, style?: clean|bold|dark-panel }
  theme             jsonb not null default '{}'::jsonb check (jsonb_typeof(theme) = 'object'),
  -- Slug de la pantalla con la que abre; null = la primera del menú.
  home_screen       text,
  status            text not null default 'draft' check (status in ('draft', 'published')),
  version           integer not null default 1 check (version >= 1),
  created_by        uuid,
  updated_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz,

  constraint custom_apps_slug_shape check (slug ~ '^[a-z][a-z0-9_]{1,47}$'),
  constraint custom_apps_name_len check (char_length(btrim(name)) between 1 and 80),
  constraint custom_apps_description_len check (char_length(description) <= 500),
  constraint custom_apps_icon_len check (char_length(icon) between 1 and 400)
);

create unique index if not exists custom_apps_org_slug_idx
  on public.custom_apps (organization_id, slug);
create index if not exists custom_apps_org_updated_idx
  on public.custom_apps (organization_id, updated_at desc);

alter table public.custom_views
  drop constraint if exists custom_views_app_fk;
alter table public.custom_views
  add constraint custom_views_app_fk
  foreign key (app_id) references public.custom_apps (id) on delete cascade;
create index if not exists custom_views_org_app_idx
  on public.custom_views (organization_id, app_id)
  where app_id is not null;

create table if not exists public.custom_app_screens (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  app_id            uuid not null references public.custom_apps (id) on delete cascade,
  view_id           uuid not null references public.custom_views (id) on delete cascade,
  slug              text not null,
  title             text not null,
  -- Nombre de un ícono de lucide (p.ej. "ClipboardList") o un emoji.
  icon              text not null default 'LayoutPanelTop',
  position          integer not null default 0,
  -- Claves de los roles que la ven. Vacío = todos.
  roles             text[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint custom_app_screens_slug_shape check (slug ~ '^[a-z][a-z0-9_]{1,47}$'),
  constraint custom_app_screens_title_len check (char_length(btrim(title)) between 1 and 60),
  constraint custom_app_screens_icon_len check (char_length(icon) between 1 and 60)
);

create unique index if not exists custom_app_screens_app_slug_idx
  on public.custom_app_screens (app_id, slug);
create unique index if not exists custom_app_screens_view_idx
  on public.custom_app_screens (view_id);
create index if not exists custom_app_screens_org_app_pos_idx
  on public.custom_app_screens (organization_id, app_id, position);

create table if not exists public.custom_app_roles (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  app_id            uuid not null references public.custom_apps (id) on delete cascade,
  key               text not null,
  name              text not null,
  description       text not null default '',
  permissions       jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  position          integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint custom_app_roles_key_shape check (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint custom_app_roles_name_len check (char_length(btrim(name)) between 1 and 60),
  constraint custom_app_roles_description_len check (char_length(description) <= 300)
);

create unique index if not exists custom_app_roles_app_key_idx
  on public.custom_app_roles (app_id, key);
create index if not exists custom_app_roles_org_app_idx
  on public.custom_app_roles (organization_id, app_id, position);

create table if not exists public.custom_app_members (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  app_id            uuid not null references public.custom_apps (id) on delete cascade,
  user_id           uuid not null,
  role_key          text not null,
  -- { "cliente": "Andina", "sede": "Norte" }: lo que leen los filtros $user.<x>.
  attributes        jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint custom_app_members_role_shape check (role_key ~ '^[a-z][a-z0-9_]{1,31}$')
);

create unique index if not exists custom_app_members_app_user_idx
  on public.custom_app_members (app_id, user_id);
create index if not exists custom_app_members_org_user_idx
  on public.custom_app_members (organization_id, user_id);

comment on table public.custom_apps is
  'Una aplicación de la empresa: varias pantallas (vistas con app_id) con menú, roles y miembros. Ver docs/features/apps.md.';
comment on table public.custom_app_screens is
  'Una pantalla de la app: la vista que la pinta, su orden, su ícono y qué roles la ven (vacío = todos).';
comment on table public.custom_app_roles is
  'Un rol de la app con sus permisos por tabla (read all|own|{field,equals:$user.x}, create, edit, fields, actions) y si exporta.';
comment on table public.custom_app_members is
  'Qué miembro de Cortex entra a la app con qué rol y con qué atributos ($user.<atributo> en los filtros de fila).';
comment on column public.custom_views.app_id is
  'Si no es null, esta vista es una pantalla de esa app y no sale en /views.';

alter table public.custom_apps enable row level security;
alter table public.custom_app_screens enable row level security;
alter table public.custom_app_roles enable row level security;
alter table public.custom_app_members enable row level security;

revoke all on table public.custom_apps from public, anon, authenticated;
revoke all on table public.custom_app_screens from public, anon, authenticated;
revoke all on table public.custom_app_roles from public, anon, authenticated;
revoke all on table public.custom_app_members from public, anon, authenticated;

grant select, insert, update, delete on table public.custom_apps to service_role;
grant select, insert, update, delete on table public.custom_app_screens to service_role;
grant select, insert, update, delete on table public.custom_app_roles to service_role;
grant select, insert, update, delete on table public.custom_app_members to service_role;
