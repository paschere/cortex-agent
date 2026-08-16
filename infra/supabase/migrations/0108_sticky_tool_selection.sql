-- La lista de herramientas de una conversación, para que el caché de prompts
-- deje de reescribirse en cada turno.
--
-- ===========================================================================
-- EL PROBLEMA, MEDIDO
-- ===========================================================================
-- En producción (turn_latencies, 7 días): de 618k tokens de prompt del chat,
-- 384k fueron ESCRITURAS al caché de Anthropic (cobradas al 125 %) y sólo 212k
-- lecturas (al 10 %). El caché es un prefijo — `tools` → `system` → `messages`
-- — y las herramientas van primero; como la selección semántica re-elegía la
-- lista en cada turno contra un texto que cambia en cada turno, el prefijo se
-- movía desde el byte cero y casi cada turno pagaba el prefijo completo de
-- nuevo en vez de leerlo a una décima del precio.
--
-- El arreglo (packages/agent-tools/src/tool-selection/sticky.ts) hace la lista
-- ESTABLE Y CRECIENTE dentro de una conversación: lo ya ofrecido conserva su
-- posición y lo nuevo se agrega al final. Para conservar posiciones entre
-- turnos hay que escribirlas en algún lado, y ese lado es esta columna.
--
-- ===========================================================================
-- POR QUÉ UNA COLUMNA AQUÍ Y NO UNA TABLA NUEVA
-- ===========================================================================
-- `turn_context_settings` (0080) ya es la fila «estado por conversación que no
-- es el transcript»: clave primaria conversation_id, muere en cascada con la
-- conversación, y el turno ya la consulta. Una tabla nueva duplicaría exacta-
-- mente esa forma para una sola columna.
--
-- Lo que esta columna NO es: un ajuste de la persona. Los tres knobs de 0080
-- los toca alguien diagnosticando; esto lo escribe el propio turno, solo. Por
-- eso el código lo lee y escribe aparte (`sticky-store.ts`), `hasOverrides` no
-- lo cuenta, y la escritura automática no toca `updated_by`/`updated_at` de
-- una fila existente — esas columnas siguen diciendo quién tocó los AJUSTES.
--
-- NULL significa «conversación de antes de esta migración o sin turnos aún» y
-- se comporta como lista vacía: el próximo turno la siembra. No hay backfill
-- que hacer — la lista se reconstruye sola al primer turno de cada
-- conversación, al precio de una reescritura de caché que ya se estaba
-- pagando en todos los turnos.

alter table public.turn_context_settings
  add column if not exists sticky_tool_ids text[];

comment on column public.turn_context_settings.sticky_tool_ids is
  'Ids de las herramientas ya ofrecidas al modelo en esta conversación, en orden de primera aparición. Lo mantiene el propio turno (tool-selection/sticky.ts) para que la lista sea estable y creciente y el prefijo del caché de prompts sobreviva de un turno al siguiente. No es un ajuste de la persona: el panel de diagnóstico ni lo muestra ni lo escribe. NULL equivale a lista vacía.';
