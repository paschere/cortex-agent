-- ===========================================================================
-- UN SEXTO VALOR EN EL CHECK DE kind: 'answer'
-- ===========================================================================
-- La 0079 escribió «Three, and only three. A fourth is a code change plus a
-- migration, which is the correct amount of friction». La 0088 pagó esa
-- fricción por 'chart', la 0100 por 'weekly', y ésta la paga por 'answer': una
-- respuesta del chat que alguien decidió conservar desde la fila de acciones
-- que hay bajo cada respuesta de Cortex.
--
-- EN QUÉ LISTA ENTRA Y EN CUÁL NO. Sólo en REPORT_KINDS, nunca en
-- GENERATED_REPORT_KINDS, exactamente igual que 'chart' y por la misma razón:
-- no es una receta que se compute a partir de un tipo y unos parámetros. Es lo
-- que Cortex contestó en una conversación un día concreto. Un botón «generar
-- una respuesta» en el selector de /reports sería un botón que no puede
-- funcionar, porque no hay consulta que repetir — y no repetirla es justo lo
-- que hace que el informe siga diciendo lo mismo en noviembre.
--
-- LO QUE SE GUARDA, PARA QUE SE ENTIENDA LA FILA. `document` lleva la pregunta
-- que la provocó y el texto de la respuesta tal cual se dijo; `params` lleva el
-- id del mensaje, que es lo que impide que pulsar dos veces cree dos informes
-- idénticos (se busca antes de insertar). `conversation_id` ya existía en la
-- tabla y aquí es la fuente: la dirección donde están las llamadas a
-- herramientas que produjeron esas cifras.
--
-- Se reescribe entero en vez de ensancharlo porque un check en línea no tiene
-- nombre que alterar; el drop es `if exists` para que una segunda pasada no
-- encuentre nada que hacer.

alter table public.reports
  drop constraint if exists reports_kind_check;

alter table public.reports
  add constraint reports_kind_check
  check (kind in ('expiries', 'fleet', 'client_activity', 'chart', 'weekly', 'answer'));

comment on column public.reports.kind is
  'Qué informe es. Los tres primeros son recetas que el constructor computa a partir de parámetros; ''chart'' es un gráfico rescatado de una conversación; ''weekly'' es el parte que sale solo cada lunes y que reclama su semana en period_start; ''answer'' es una respuesta del chat conservada tal como se dijo. Ver la 0088 sección 1, la 0100 sección 2 y la 0103.';
