-- PostgREST se entera de las tablas nuevas, sin esperar a que alguien lo reinicie.
--
-- ===========================================================================
-- EL DÍA QUE ESTO HIZO FALTA
-- ===========================================================================
-- La 0115 creó `trackers` y `tracker_rows` el 18 de agosto, un día DESPUÉS del
-- cutover a Railway. `deploy-migrate` las aplicó bien, el deploy salió READY…
-- y el panel de «Tablas» abría con «Could not find the table 'public.trackers'
-- in the schema cache». La base tenía la tabla; el PostgREST de `services/
-- pgrest` seguía sirviendo el esquema que cacheó al arrancar el día 16.
--
-- En Supabase esto nunca se vio porque su base trae event triggers
-- (`pgrst_ddl_watch` / `pgrst_drop_watch`) que hacen NOTIFY al canal `pgrst`
-- en cada DDL, y PostgREST escucha ese canal por defecto (db-channel-enabled
-- es true y el canal se llama `pgrst` de fábrica — start.sh no lo toca). El
-- bootstrap de Railway (`scripts/railway-db-setup.mjs`) no los instaló, así
-- que ESTA fue la primera tabla nueva después del cutover, y la primera vez
-- que la caché se quedó vieja. Esta migración cierra ese hueco para siempre:
-- a partir de aquí, cada migración futura avisa sola.
--
-- Nombres propios (`cortex_pgrst_watch*`) y no los de Supabase a propósito:
-- si algún día esto corriera contra la base de rollback de Supabase, los
-- suyos ya existen con otro dueño y chocaría. Y todo va envuelto en un DO que
-- degrada a un aviso si el rol no puede crear event triggers (requieren
-- superusuario; el `postgres` de Railway lo es, el de Supabase no): una
-- migración que no puede instalar el vigía no debe tumbar el deploy — el
-- NOTIFY final del propio archivo sigue arreglando la caché de hoy.

create or replace function public.cortex_pgrst_watch() returns event_trigger
  language plpgsql
  as $fn$
begin
  -- El canal por defecto de PostgREST. La entrega ocurre al hacer commit, es
  -- decir, cuando la tabla nueva ya es visible para quien recargue.
  notify pgrst, 'reload schema';
end;
$fn$;

comment on function public.cortex_pgrst_watch() is
  'Avisa al PostgREST de services/pgrest que el esquema cambió. Sin esto, una tabla nueva no existe para la API hasta reiniciar el contenedor — así se rompió el panel de Tablas (0115).';

do $$
begin
  -- ddl_command_end cubre CREATE/ALTER; sql_drop cubre los DROP, que
  -- ddl_command_end ve pero sin los objetos ya resueltos. Dos vigías, como
  -- los trae Supabase.
  if not exists (select 1 from pg_event_trigger where evtname = 'cortex_pgrst_watch_ddl') then
    create event trigger cortex_pgrst_watch_ddl
      on ddl_command_end
      execute function public.cortex_pgrst_watch();
  end if;

  if not exists (select 1 from pg_event_trigger where evtname = 'cortex_pgrst_watch_drop') then
    create event trigger cortex_pgrst_watch_drop
      on sql_drop
      execute function public.cortex_pgrst_watch();
  end if;
exception
  when insufficient_privilege then
    raise notice 'Sin permiso para crear event triggers: PostgREST habrá que recargarlo a mano tras cada DDL (NOTIFY pgrst, ''reload schema'').';
end
$$;

-- Y la recarga de HOY, explícita: los vigías recién creados no dispararon por
-- las tablas de la 0115/0116, que ya existían. Este NOTIFY es el que hace que
-- `trackers` aparezca en la API en cuanto este deploy aplique migraciones,
-- sin reiniciar el servicio pgrest.
notify pgrst, 'reload schema';
