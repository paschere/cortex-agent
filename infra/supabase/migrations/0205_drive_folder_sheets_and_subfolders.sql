-- 0205 — La carpeta de Drive lee sus hojas sin modelo, entra a subcarpetas y
-- lee fotos y escaneos.
--
-- HOJAS. Una hoja de cálculo dentro de la carpeta (Sheets, .xlsx, .csv) ya no
-- se le pasa al modelo: cada fila es un registro. `sheet_mapping` guarda el
-- mapeo { "campo": "Encabezado de la hoja" } que la persona aprobó al crear la
-- tabla; sin él (sincronizaciones anteriores a 0205) la hoja se sigue leyendo
-- con el modelo, como antes. Una carpeta de sólo hojas no tiene campos «a leer
-- del documento», así que `extract_fields` puede quedar vacío.
--
-- SUBCARPETAS. `recursive` y `max_depth`: la sincronización entra a las
-- subcarpetas (hasta `max_depth` niveles). Apagado por defecto en las que ya
-- existen; la propuesta lo enciende si el inventario encuentra subcarpetas.
--
-- LIBRO. `read_via` dice cómo se leyó cada archivo (texto, hoja, imagen,
-- pdf_escaneado) y `folder_path` en qué subcarpeta estaba: si el archivo se
-- mueve de subcarpeta se vuelve a leer sólo para actualizar el campo «Carpeta»,
-- y las filas siguen siendo las mismas (la clave de una fila de hoja usa el id
-- del archivo, nunca su ruta).

alter table public.drive_folder_syncs
  add column sheet_mapping jsonb not null default '{}'::jsonb
    check (jsonb_typeof(sheet_mapping) = 'object'),
  add column recursive boolean not null default false,
  add column max_depth smallint not null default 3 check (max_depth between 1 and 5);

alter table public.drive_folder_syncs
  drop constraint if exists drive_folder_syncs_extract_fields_check;

alter table public.drive_folder_syncs
  add constraint drive_folder_syncs_extract_fields_check check (
    jsonb_typeof(extract_fields) = 'array'
    and jsonb_array_length(extract_fields) between 0 and 20
  );

alter table public.drive_folder_sync_files
  add column read_via text not null default 'text'
    check (read_via in ('text', 'sheet', 'image', 'pdf_scan')),
  add column folder_path text not null default '' check (char_length(folder_path) <= 500);

comment on column public.drive_folder_syncs.sheet_mapping is
  'Mapeo aprobado { campo: encabezado } para leer las hojas de cálculo de la carpeta fila por fila, sin modelo. Vacío = las hojas se leen con el modelo.';
comment on column public.drive_folder_sync_files.read_via is
  'Cómo se leyó el archivo: text (texto del documento), sheet (hoja fila por fila), image (foto o imagen enviada al modelo) o pdf_scan (PDF sin texto enviado al modelo).';
