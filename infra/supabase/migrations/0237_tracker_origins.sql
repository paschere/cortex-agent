-- ===========================================================================
-- DE DÓNDE VIENE UNA TABLA: MARCA DE ORIGEN
-- ===========================================================================
-- Las tablas que llenan los programas contables (Siigo, Alegra, QuickBooks),
-- las hojas de cálculo (0161) y las carpetas de Drive (0164) se podían EDITAR
-- como si fueran propias: el cambio no llegaba al origen y la siguiente
-- sincronización lo pisaba, o los dos quedaban distintos.
--
-- `trackers.origins` guarda, por tabla, de dónde viene y qué campos escribe
-- ese origen:
--   [{ "kind": "accounting" | "sheet" | "drive_folder",
--      "provider": "siigo",            -- sólo accounting
--      "label": "Siigo" | "la hoja «Vuelos»" | "la carpeta «Guías»",
--      "ref": "<id de la conexión / tracker_syncs / drive_folder_syncs>",
--      "fields": ["numero", "total", ...],  -- los campos del ORIGEN (sólo lectura)
--      "creates": true,                -- el origen agrega filas (update_only no)
--      "writeBack": false }]           -- escritura de vuelta a la hoja, apagada
--
-- Los campos que NO están en `fields` son propios de la empresa: la
-- sincronización no los toca, y se editan con los permisos normales. Una tabla
-- puede tener varios orígenes (carpeta de Drive + API de vuelos): se unen.
--
-- El servidor rechaza escribir un campo del origen (upsertRow, vistas, apps,
-- automatizaciones, importación) y agregar filas a mano a una tabla que se
-- llena sola. La última lectura y su estado NO se copian aquí: se leen de la
-- conexión / sincronización (`ref`), que es donde ya viven.
--
-- Backfill: las tablas que ya existen quedan marcadas. En las contables sólo se
-- marcan como del origen los campos que produce la definición de la entidad
-- (la lista conocida por tabla, de accounting/tables.ts); los campos que el
-- equipo agregó encima quedan propios desde el primer momento. La siguiente
-- sincronización vuelve a escribir la misma lista.
--
-- REGLAS (ajuste previo al despliegue): programas contables — ni filas a mano ni
-- campos del programa. Hojas y carpetas — el candado es sólo de las filas que
-- trajo el origen (tienen external_key) y de sus campos; las filas hechas a
-- mano (formulario, grilla, chat, apps) se crean y editan libremente y la
-- sincronización nunca las toca ni las borra.

alter table public.trackers
  add column if not exists origins jsonb not null default '[]'::jsonb
  check (jsonb_typeof(origins) = 'array');

comment on column public.trackers.origins is
  'De dónde se llena la tabla (programa contable, hoja, carpeta de Drive) y qué campos escribe cada origen (sólo lectura para la empresa). Los demás campos son propios.';

with spec_fields (slug, keys) as (
  -- Los campos que produce la definición de cada tabla contable (accounting/tables.ts).
  -- Lo que el equipo agregó encima NO está aquí: queda como campo propio.
  values
  ('siigo_clientes', 'nombre,nit,relacion,tipo,ciudad,direccion,telefono,correo,estado,creado'),
  ('siigo_productos', 'nombre,codigo,tipo,grupo,precio,existencias,unidad,referencia,estado'),
  ('siigo_facturas', 'numero,cliente,nit,fecha,vence,total,saldo,moneda,estado,factura_electronica,cufe,mensaje_dian,pdf,observaciones,enlace'),
  ('siigo_pagos', 'numero,cliente,nit,fecha,tipo,valor,moneda,facturas,forma_pago,observaciones'),
  ('siigo_notas_credito', 'numero,cliente,nit,fecha,factura,valor,moneda,factura_electronica,cufe,mensaje_dian,pdf,observaciones'),
  ('siigo_compras', 'numero,documento,tipo,proveedor,nit,fecha,vence,total,saldo,moneda,estado,observaciones'),
  ('siigo_pagos_proveedores', 'numero,proveedor,nit,fecha,valor,moneda,compras,forma_pago,estado,observaciones'),
  ('siigo_movimientos_contables', 'comprobante,fecha,mes,cuenta,nombre_cuenta,movimiento,debito,credito,nit_tercero,tercero,centro_costo,descripcion'),
  ('siigo_cotizaciones', 'numero,cliente,nit,fecha,vigencia,total,moneda,vendedor,observaciones'),
  ('siigo_existencias', 'producto,codigo,bodega,existencias,minimo,unidad,alerta'),
  ('siigo_estados_financieros', 'periodo,mes,estado,seccion,codigo,renglon,valor,en_curso'),
  ('siigo_costo_nomina', 'periodo,mes,area,grupo,concepto,valor,en_curso'),
  ('siigo_centros_costo', 'nombre,codigo,estado'),
  ('siigo_impuestos', 'nombre,codigo,tipo,porcentaje,estado'),
  ('siigo_formas_pago', 'nombre,codigo,tipo,estado'),
  ('siigo_bodegas', 'nombre,codigo,estado'),
  ('siigo_tipos_documento', 'nombre,codigo,tipo,estado'),
  ('siigo_vendedores', 'nombre,codigo,estado'),
  ('siigo_cuentas_por_pagar', 'documento,cuota,proveedor,nit,vence,saldo,moneda,moneda_extranjera,saldo_extranjero,centro_costo,estado,ultima_lectura'),
  ('siigo_saldos_terceros', 'periodo,mes,cuenta,nombre_cuenta,nit_tercero,tercero,saldo_inicial,debito,credito,saldo_final,en_curso'),
  ('siigo_precios_productos', 'producto,codigo,lista,posicion,moneda,precio'),
  ('siigo_activos_fijos', 'nombre,codigo,tipo,estado'),
  ('siigo_listas_precios', 'nombre,codigo,tipo,estado'),
  ('siigo_grupos_inventario', 'nombre,codigo,estado'),
  ('siigo_conceptos_gasto', 'nombre,codigo,estado'),
  ('siigo_ciudades', 'nombre,codigo,tipo,estado'),
  ('alegra_clientes', 'nombre,nit,relacion,tipo,ciudad,direccion,telefono,correo,estado,creado'),
  ('alegra_productos', 'nombre,codigo,tipo,grupo,precio,existencias,unidad,referencia,estado'),
  ('alegra_facturas', 'numero,cliente,nit,fecha,vence,total,saldo,moneda,estado,factura_electronica,cufe,mensaje_dian,pdf,observaciones,enlace'),
  ('alegra_pagos', 'numero,cliente,nit,fecha,tipo,valor,moneda,facturas,forma_pago,observaciones'),
  ('alegra_compras', 'numero,documento,tipo,proveedor,nit,fecha,vence,total,saldo,moneda,estado,observaciones'),
  ('alegra_existencias', 'producto,codigo,bodega,existencias,minimo,unidad,alerta'),
  ('alegra_estados_financieros', 'periodo,mes,estado,seccion,codigo,renglon,valor,en_curso'),
  ('quickbooks_clientes', 'nombre,nit,relacion,tipo,ciudad,direccion,telefono,correo,estado,creado'),
  ('quickbooks_productos', 'nombre,codigo,tipo,grupo,precio,existencias,unidad,referencia,estado'),
  ('quickbooks_facturas', 'numero,cliente,nit,fecha,vence,total,saldo,moneda,estado,factura_electronica,cufe,mensaje_dian,pdf,observaciones,enlace'),
  ('quickbooks_pagos', 'numero,cliente,nit,fecha,tipo,valor,moneda,facturas,forma_pago,observaciones'),
  ('quickbooks_compras', 'numero,documento,tipo,proveedor,nit,fecha,vence,total,saldo,moneda,estado,observaciones'),
  ('quickbooks_estados_financieros', 'periodo,mes,estado,seccion,codigo,renglon,valor,en_curso')
),
sources as (
  -- Programas contables: una tabla por cosa que la conexión trae.
  select (e.value)::uuid as tracker_id,
         jsonb_build_object(
           'kind', 'accounting',
           'provider', c.provider,
           'label', case c.provider when 'siigo' then 'Siigo' when 'alegra' then 'Alegra'
                                    when 'quickbooks' then 'QuickBooks' else c.provider end,
           'ref', c.id::text,
           'fields', coalesce((
             select jsonb_agg(f ->> 'key')
               from jsonb_array_elements(t.fields) f
              where (f ->> 'key') = any (string_to_array(coalesce(sf.keys, ''), ','))
           ), '[]'::jsonb),
           'creates', true
         ) as origin
    from public.accounting_connections c
    cross join lateral jsonb_each_text(c.trackers) e
    join public.trackers t on t.id = (e.value)::uuid
    left join spec_fields sf on sf.slug = t.slug
   where e.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  union all
  -- Hojas de cálculo del Feed.
  select s.tracker_id,
         jsonb_build_object(
           'kind', 'sheet',
           'label', 'la hoja «' || coalesce(nullif(fs.name, ''), 'del Feed') || '»',
           'ref', s.id::text,
           'fields', coalesce((
             select jsonb_agg(k) from jsonb_object_keys(s.mapping) k
              where s.mode = 'upsert' or not (k = any (s.key_fields))
           ), '[]'::jsonb),
           'creates', s.mode = 'upsert'
         )
    from public.tracker_syncs s
    left join public.feed_sources fs on fs.id = s.source_id
  union all
  -- Carpetas de Drive: lo que se lee del documento y la clave.
  select d.tracker_id,
         jsonb_build_object(
           'kind', 'drive_folder',
           'label', 'la carpeta «' || coalesce(nullif(d.folder_name, ''), 'de Drive') || '»',
           'ref', d.id::text,
           'fields', coalesce((
             select jsonb_agg(distinct k) from (
               select x ->> 'key' as k from jsonb_array_elements(d.extract_fields) x
               union select unnest(d.key_fields)
             ) q where k is not null
           ), '[]'::jsonb),
           'creates', true
         )
    from public.drive_folder_syncs d
),
folded as (
  select tracker_id, jsonb_agg(origin) as origins from sources group by tracker_id
)
update public.trackers t
   set origins = f.origins
  from folded f
 where t.id = f.tracker_id
   and t.origins = '[]'::jsonb;
