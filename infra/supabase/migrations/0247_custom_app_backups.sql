-- ===========================================================================
-- COPIAS POR APP: UNA FOTO DE LA APP (CONFIGURACIÓN, CÓDIGO Y DATOS) PARA
-- VOLVER ATRÁS FILA POR FILA, TABLA POR TABLA O TODA LA CONFIGURACIÓN
-- ===========================================================================
-- Ver docs/plans/copias-por-app.md. Una fila de esta tabla es el ÍNDICE de una
-- copia; el contenido (JSON comprimido con gzip) vive en app_files, bucket
-- 'app-backups', ruta <organización>/<app>/<id>.json.gz (`storage_ref`), junto
-- al resto de los archivos del producto: un solo backup, sin columna bytea
-- gigante que arrastrar en cada listado.
--
--   · kind   — 'diaria' (2:00 a. m. Bogotá) | 'antes_de_cambio' (publicar,
--              migrar, restaurar…) | 'manual' (botón «Hacer copia ahora»).
--   · tables — resumen { "<slug>": filas } para listar sin abrir el archivo.
--   · status — 'ok' | 'failed' (la copia se intentó y no se pudo guardar;
--              `reason` dice por qué).
--
-- `app_id` NO lleva llave foránea a propósito: las copias sobreviven a la app
-- (es justo cuando más hacen falta) y el barrido de retención las limpia.
--
-- Tenencia: `organization_id` en cada fila y `tenant()` en tenancy/tables.ts.
-- RLS como 0243: sólo service_role, con el cliente acotado (`getOrgScopedClient`).

create table if not exists public.custom_app_backups (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  app_id           uuid not null,
  kind             text not null check (kind in ('diaria', 'antes_de_cambio', 'manual')),
  reason           text not null default '',
  status           text not null default 'ok' check (status in ('ok', 'failed')),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  size_bytes       bigint not null default 0 check (size_bytes >= 0),
  tables           jsonb not null default '{}'::jsonb check (jsonb_typeof(tables) = 'object'),
  storage_ref      text
);

create index if not exists custom_app_backups_app_idx
  on public.custom_app_backups (organization_id, app_id, created_at desc);
create index if not exists custom_app_backups_kind_idx
  on public.custom_app_backups (kind, created_at);

comment on table public.custom_app_backups is
  'Índice de las copias por app (diaria, antes de cambio, manual). El contenido es gzip JSON en app_files bucket app-backups (storage_ref). Ver docs/plans/copias-por-app.md.';

alter table public.custom_app_backups enable row level security;
revoke all on table public.custom_app_backups from public, anon, authenticated;
grant select, insert, update, delete on table public.custom_app_backups to service_role;

drop policy if exists custom_app_backups_service_only on public.custom_app_backups;
create policy custom_app_backups_service_only on public.custom_app_backups
  for all to service_role using (true) with check (true);
