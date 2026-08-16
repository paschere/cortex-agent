-- =============================================================================
-- LOS ARCHIVOS SE MUDAN A LA BASE, Y CON ESO SE PUEDE MUDAR LA BASE.
-- =============================================================================
--
-- Cortex guarda archivos en dos buckets de Supabase Storage ('kb-uploads' y
-- el de presentaciones). Storage es el ÚNICO servicio de Supabase que el
-- producto usa además de Postgres — el auth es de better-auth, el realtime no
-- se usa, y las queries son PostgREST, que corre donde sea. O sea: los
-- archivos eran lo único que amarraba el producto a Supabase.
--
-- Esta tabla corta esa amarra. Los archivos viven como bytea al lado de los
-- datos que los describen, con las mismas ventajas que decidieron todo lo
-- demás en este esquema: un solo backup, una sola migración, una sola
-- factura. A la escala de este producto (documentos, PDF de presentaciones,
-- audio de reuniones — megabytes, no gigabytes) un blob en Postgres es
-- aburrido y correcto; un CDN sería optimizar un problema que nadie tiene.
--
-- El acceso pasa por packages/agent-tools/src/files/store.ts, que habla
-- PostgREST con el contenido en hex — el mismo cliente scopeado de siempre,
-- ninguna dependencia nueva. Las URLs firmadas que Storage regalaba las emite
-- ahora /api/files/blob/[token] con un HMAC de vida corta.
-- =============================================================================

create table if not exists public.app_files (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  -- Se conservan los nombres de bucket viejos ('kb-uploads', …) para que la
  -- copia desde Storage sea path→path, sin renombres que auditar.
  bucket text not null,
  path text not null,
  content bytea not null,
  content_type text,
  size_bytes bigint not null check (size_bytes >= 0),
  created_at timestamptz not null default now(),
  -- La identidad de un archivo es su ruta dentro del bucket, igual que en
  -- Storage: subir a la misma ruta reemplaza, no duplica.
  unique (bucket, path)
);

comment on table public.app_files is
  'Los archivos del producto (antes en Supabase Storage), como bytea junto a los datos que los describen. La identidad es (bucket, path); subir a la misma ruta reemplaza. Servidos por /api/files/blob con token HMAC de vida corta.';

create index if not exists app_files_org_idx
  on public.app_files (organization_id, bucket, created_at desc);

alter table public.app_files enable row level security;

-- Solo el rol de servicio: los archivos se sirven siempre a través de la app,
-- que ya decidió quién puede ver qué. La misma política que tenían los
-- buckets ('kb_uploads_service_only', migración 0013).
drop policy if exists app_files_service_only on public.app_files;
create policy app_files_service_only on public.app_files
  for all to service_role using (true) with check (true);
