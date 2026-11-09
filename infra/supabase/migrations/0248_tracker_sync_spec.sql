-- ===========================================================================
-- SINCRONIZACIÓN POR RECETA: UNA PESTAÑA → UNA TABLA DE FILAS Y OTRA DE GRUPOS
-- ===========================================================================
-- La 0161 llena UNA tabla con «campo = encabezado» y una clave de campos. Una
-- hoja operativa real (guías con su manifiesto, cargos del manifiesto en filas
-- sueltas, nombres de cliente escritos de diez maneras, fechas en dos formatos)
-- necesita más: limpiar valores, buscar la fila de otra tabla, sumar cargos al
-- grupo y armar una clave compuesta. Eso es una RECETA (`spec`), guardada aquí
-- como datos —no código por cliente—; la forma está en
-- packages/agent-tools/src/table-sync/sheet-spec.ts.
--
-- `last_report`: el informe de la última corrida (o ensayo): conteos, conflictos
-- y lo que ya no está en la hoja. Se muestra en el chat y en el aviso.
-- Una sincronización con `spec` nace pausada (enabled = false) hasta que se
-- ensaya y se aplica la primera corrida a mano.

alter table public.tracker_syncs
  add column if not exists spec jsonb
    check (spec is null or jsonb_typeof(spec) = 'object'),
  add column if not exists last_report jsonb;

comment on column public.tracker_syncs.spec is
  '0248: receta de lectura (vars, filas, relaciones, padre/hijas, clave). Si existe, manda sobre mapping/key_fields.';
comment on column public.tracker_syncs.last_report is
  '0248: informe de la última corrida o ensayo de una sincronización con receta.';
