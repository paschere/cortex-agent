-- Apariencia e Inicio de una aplicación (Aplicaciones, fase 5).
--
--   · brand — la marca PROPIA de la app, encima de la de la empresa
--             (company_branding, 0170), que sigue siendo el valor por defecto:
--             { primary?, accent?, shortName?, font?: system|serif|rounded,
--               welcome?: { title?, text? },
--               files?: { logo?|icon?|welcome?: { v: <huella>, t: png|jpg|webp } } }
--             Las imágenes viven en el bucket `branding` de app_files, en
--             <organización>/apps/<app>/<tipo>-<huella>.<ext>; aquí sólo se
--             guarda la huella. La forma se valida en código
--             (packages/agent-tools/src/apps/appearance.ts).
--   · home  — la pantalla «Inicio» con tarjetas por rol:
--             { enabled, greeting, cards: [counter|pending|shortcut] }.
--             No es una vista guardada: se calcula al abrirla con el rol de
--             quien mira.
--
-- Dos columnas nuevas en una tabla que ya tiene organization_id y RLS (0208):
-- no cambian la tenencia. Una app sin estos datos se ve igual que antes.

alter table public.custom_apps
  add column if not exists brand jsonb not null default '{}'::jsonb,
  add column if not exists home  jsonb not null default '{}'::jsonb;

alter table public.custom_apps
  drop constraint if exists custom_apps_brand_object,
  drop constraint if exists custom_apps_home_object;
alter table public.custom_apps
  add constraint custom_apps_brand_object check (jsonb_typeof(brand) = 'object'),
  add constraint custom_apps_home_object  check (jsonb_typeof(home) = 'object');
