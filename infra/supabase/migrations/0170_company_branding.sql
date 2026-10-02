-- ===========================================================================
-- LA MARCA DE LA EMPRESA: LOGO, COLORES Y NOMBRE PARA MOSTRAR
-- ===========================================================================
-- Las vistas (0156) salen de Cortex: un tablero que se comparte con un cliente
-- por WhatsApp, un informe que se imprime para la junta. Hasta ahora salían
-- todas con el índigo de Cortex y el nombre con el que alguien registró el
-- espacio. Esta tabla guarda lo que la empresa quiere que se vea:
--
--   · `display_name`  — cómo se llama de cara afuera («Transportes Andinos»),
--                       si no es el nombre del espacio. Opcional.
--   · `primary_color` — el color de la marca, `#rrggbb`. Es el acento por
--                       defecto de cada vista; una vista que eligió su propio
--                       tono en el tema lo conserva. El texto que va encima se
--                       calcula con contraste suficiente en el navegador
--                       (apps/web/lib/branding/colors.ts): aquí se guarda el
--                       color tal cual lo eligieron, no una versión «arreglada».
--   · `secondary_color` — un segundo color opcional para series de gráficos.
--   · `logo_path`     — la ruta del logo en `app_files` (bucket 'branding').
--                       El logo NO vive aquí: vive con los demás archivos, y
--                       se sirve por /api/branding/logo (con sesión) o por
--                       /api/views/public/logo?token=… (sólo el de la empresa
--                       dueña de esa vista compartida).
--   · `logo_version`  — huella corta del contenido, para que la URL cambie
--                       cuando cambia el logo y los navegadores puedan
--                       guardarlo en caché sin mostrar uno viejo.
--
-- Una fila por empresa: la llave primaria ES organization_id. Sin fila = sin
-- marca, y todo se ve como siempre.
--
-- Tenencia: `organization_id` en la fila, `tenant()` en tenancy/tables.ts.
-- Sólo service_role: la tabla la toca el servidor, nunca un navegador.

create table if not exists public.company_branding (
  organization_id  text primary key references public.ba_organization(id) on delete cascade,
  display_name     text check (display_name is null or char_length(display_name) between 1 and 80),
  primary_color    text check (primary_color is null or primary_color ~ '^#[0-9a-f]{6}$'),
  secondary_color  text check (secondary_color is null or secondary_color ~ '^#[0-9a-f]{6}$'),
  logo_path        text check (logo_path is null or char_length(logo_path) <= 300),
  logo_version     text check (logo_version is null or logo_version ~ '^[0-9a-f]{8,64}$'),
  updated_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.company_branding is
  'La marca de cada empresa: nombre para mostrar, color principal y secundario (#rrggbb) y la ruta del logo en app_files (bucket branding). Una fila por empresa; sin fila, las vistas se ven con los colores de Cortex.';
comment on column public.company_branding.primary_color is
  'Color de la marca tal cual lo eligieron (#rrggbb, minúsculas). El contraste del texto se calcula al pintar, no se guarda.';
comment on column public.company_branding.logo_version is
  'Huella del contenido del logo (sha256 recortado). Va en la URL para que el caché del navegador nunca muestre un logo viejo.';

alter table public.company_branding enable row level security;
revoke all on table public.company_branding from public, anon, authenticated;
grant select, insert, update, delete on table public.company_branding to service_role;
