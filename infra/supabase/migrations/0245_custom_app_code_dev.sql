-- ===========================================================================
-- APPS CON CÓDIGO · FASE 4 (DESARROLLADORES): QUIÉN CAMBIÓ CADA ARCHIVO Y EL
-- VÍNCULO CON GITHUB
-- ===========================================================================
-- Cortex y las personas editan los mismos archivos (docs/plans/apps-con-codigo.md):
--
--   · file_meta   — { "<ruta>": { "by": "<id de miembro | 'cortex'>", "at": "<ISO>" } }:
--                   el último que tocó cada archivo del borrador. Cortex lo lee
--                   para respetar lo que una persona cambió; el editor, para
--                   avisar de cambios ajenos. `updated_at` del proyecto es la
--                   revisión del borrador (concurrencia optimista: un guardado
--                   basado en una revisión vieja se rechaza).
--   · github_*    — vínculo opcional con un repo: dónde enviar y de dónde traer
--                   el borrador, y el commit con que se sincronizó por última vez.
--
-- Sin tablas nuevas: la tenencia y la RLS de 0243 cubren las columnas.

alter table public.custom_app_code
  add column if not exists file_meta jsonb not null default '{}'::jsonb
    check (jsonb_typeof(file_meta) = 'object');
alter table public.custom_app_code
  add column if not exists github_repo text;
alter table public.custom_app_code
  add column if not exists github_branch text;
alter table public.custom_app_code
  add column if not exists github_path text;
alter table public.custom_app_code
  add column if not exists github_last_sha text;

comment on column public.custom_app_code.file_meta is
  'Último autor por archivo del borrador: { ruta: { by: id de miembro | cortex, at: ISO } }.';
comment on column public.custom_app_code.github_repo is
  'Repo vinculado, «propietario/nombre»; null = sin vínculo.';
comment on column public.custom_app_code.github_branch is 'Rama vinculada.';
comment on column public.custom_app_code.github_path is
  'Carpeta del repo donde viven los archivos (vacío = la raíz).';
comment on column public.custom_app_code.github_last_sha is
  'Commit con que se sincronizó por última vez (enviar o traer).';
