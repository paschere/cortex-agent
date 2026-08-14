-- ---------------------------------------------------------------------------
-- QUÉ LEYÓ CORTEX DEL CEREBRO PARA CONTESTAR
-- ---------------------------------------------------------------------------
--
-- Cortex usa Brain Knowledge por dos caminos y sólo uno se veía. Cuando el
-- modelo llama a `kb.search` a mitad del turno, eso sale como un paso en la
-- lista. Pero el camino NORMAL es otro: antes de que el modelo vea la pregunta,
-- `/api/chat` busca en el cerebro y pega los fragmentos encima del turno. Eso
-- no es una llamada a ninguna herramienta, así que no dejaba ni un píxel en
-- pantalla — la respuesta citaba un contrato y nada decía que lo hubiera leído.
--
-- En un producto cuya firma es la procedencia, ése era el hueco más grande que
-- quedaba. Y había una pista de que ya se había intentado: `CitationFootnote`
-- existía con cero importaciones. La interfaz estaba escrita y no se pudo
-- conectar nunca, porque el dato no se guardaba en ninguna parte.
--
-- ---------------------------------------------------------------------------
-- LO QUE VA AQUÍ, Y LO QUE NO
-- ---------------------------------------------------------------------------
-- El título del documento, su edad y si la coincidencia fue floja. NUNCA EL
-- TEXTO DEL FRAGMENTO. El texto ya vive en `kb_chunks`, y copiarlo aquí sería
-- una segunda copia del documento dentro de `messages` —que se lee entero cada
-- vez que alguien abre una conversación— y que nadie va a acordarse de borrar
-- cuando eliminen el documento original. Un documento borrado del cerebro tiene
-- que desaparecer del cerebro.
--
-- jsonb y no una tabla aparte: son como mucho ocho objetos pequeños que sólo se
-- quieren junto a su mensaje y nunca se consultan por su cuenta. Una tabla
-- costaría una consulta más en cada apertura de conversación, que es
-- exactamente lo que las migraciones 0090 y 0092 argumentaron al poner los
-- seguimientos y la marca de captura en esta misma fila.
-- ---------------------------------------------------------------------------

alter table public.messages
  add column if not exists brain_sources jsonb;

-- ---------------------------------------------------------------------------
-- LA FORMA, DEFENDIDA — y el CASE no es estilo
-- ---------------------------------------------------------------------------
-- `jsonb_array_length` LANZA UN ERROR si lo que recibe no es un array, así que
-- la comprobación del tipo tiene que ejecutarse ANTES. Postgres no garantiza
-- que `and` evalúe de izquierda a derecha ni que corte al primer falso — el
-- planificador puede reordenar los operandos de una expresión booleana. `case`
-- sí garantiza el orden, y por eso está escrito así en vez de con un `and`.
--
-- Y se exige AL MENOS UNA. Un array vacío y un NULL se dibujarían igual —sin
-- nada—, así que tener dos maneras de escribir el mismo hecho es dos maneras de
-- que diverjan. «No se usó el cerebro» es NULL, y punto. (La lección de
-- `array_length('{}', 1)`, que devuelve NULL y hace que un CHECK PASE, está en
-- la migración 0090 y en la 0101: aquí el NULL se cubre con su propia rama.)
alter table public.messages
  drop constraint if exists messages_brain_sources_shape;

alter table public.messages
  add constraint messages_brain_sources_shape
  check (
    brain_sources is null
    or (
      case
        when jsonb_typeof(brain_sources) = 'array'
          then jsonb_array_length(brain_sources) between 1 and 8
        else false
      end
    )
  );

comment on column public.messages.brain_sources is
  'Los documentos de Brain Knowledge que se pegaron encima de esta pregunta, sin repetir y sin su contenido: solo id, titulo, edad y si la coincidencia fue floja. NULL significa que no se uso el cerebro en este turno, o que se uso y no encontro nada -- las dos cosas se dibujan igual (sin nada) y por eso comparten representacion. Nunca un array vacio. Solo se escribe en filas de assistant.';
