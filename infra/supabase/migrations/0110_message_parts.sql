-- ---------------------------------------------------------------------------
-- EL CUERPO DE LA RESPUESTA EN EL ORDEN EN QUE PASÓ
-- ---------------------------------------------------------------------------
--
-- Una respuesta en vivo se dibuja desde `message.parts` del stream: texto,
-- razonamiento y llamadas a herramientas ENTRELAZADOS en el orden real. Al
-- recargar la conversación ese entrelazado no existía en ninguna parte — la
-- base guardaba el texto entero (`content`), las llamadas (`tool_calls`) y los
-- resultados (`tool_results`) POR SEPARADO, así que el cliente tenía que
-- inventarse un orden («los pasos antes del texto, que es el menos falso») y
-- el razonamiento se perdía del todo. La misma conversación se veía distinta
-- según si se estaba mirando o se estaba recordando, en un producto cuya
-- promesa es que esto se puede citar dos semanas después.
--
-- Esta columna guarda la cronología completa del mensaje del asistente, en la
-- misma forma que el SDK entrega al cliente (`parts`): entradas `text`,
-- `reasoning` y `tool-invocation` (con args Y resultado), en orden. Con ella,
-- una conversación reabierta se dibuja EXACTAMENTE igual que en vivo.
--
-- ---------------------------------------------------------------------------
-- EL TOPE DE TAMAÑO, Y DÓNDE VIVE
-- ---------------------------------------------------------------------------
-- Un resultado de herramienta puede ser enorme (una tabla entera, un scrape).
-- El que escribe (`onFinish` de /api/chat, vía lib/message-parts.ts) recorta
-- ANTES de insertar: ~100 KB por resultado de invocación — pasado el tope se
-- guarda truncado, con la marca `"__truncated": true` y el primer trozo — y
-- ~1 MB por mensaje en total. Los números exactos y el porqué están en
-- `apps/web/lib/message-parts.ts`, que es el único sitio que escribe esto.
-- El CHECK de abajo defiende la forma, no el peso: pesar jsonb en un CHECK
-- costaría serializarlo entero en cada insert.
--
-- NULL para los mensajes de usuario y para todo lo escrito antes de esta
-- migración; esas filas se siguen dibujando con el fallback de siempre
-- (tool_calls + tool_results, pasos antes del texto). Nunca un array vacío:
-- un array vacío y un NULL se dibujan igual, y dos maneras de escribir el
-- mismo hecho son dos maneras de que acaben significando cosas distintas
-- (la lección de la migración 0105, aplicada aquí).
-- ---------------------------------------------------------------------------

alter table public.messages
  add column if not exists parts jsonb;

-- El CASE y no un AND, por lo mismo que en 0105: `jsonb_array_length` lanza si
-- no recibe un array y Postgres no garantiza el orden de evaluación de un AND.
alter table public.messages
  drop constraint if exists messages_parts_shape;

alter table public.messages
  add constraint messages_parts_shape
  check (
    parts is null
    or (
      case
        when jsonb_typeof(parts) = 'array'
          then jsonb_array_length(parts) >= 1
        else false
      end
    )
  );

comment on column public.messages.parts is
  'La cronologia completa de un mensaje del asistente, en la forma `parts` del AI SDK: entradas text, reasoning y tool-invocation (con args y resultado) en el orden real en que pasaron. Es lo que permite que una conversacion reabierta se dibuje igual que en vivo. Recortada al escribir: ~100 KB por resultado de invocacion (truncado con la marca __truncated) y ~1 MB por mensaje -- ver apps/web/lib/message-parts.ts. NULL en mensajes de usuario y en todo lo anterior a esta migracion; nunca un array vacio.';
