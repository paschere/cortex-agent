-- Los datos de la empresa: lo que Cortex sabe de ti sin que se lo preguntes.
--
-- ===========================================================================
-- EL HUECO QUE ESTO TAPA
-- ===========================================================================
-- El prompt de Cortex se arma en UN solo sitio —apps/web/lib/system-prompt.ts,
-- compartido por las tres superficies: web, Google Chat y MCP— y hasta hoy
-- llevaba tres cosas: el prompt del agente, las memorias de LA PERSONA, y las
-- secciones propias de cada superficie. CERO información de la empresa.
--
-- No es que no hubiera dónde ponerla; es que los dos sitios que parecían servir
-- no sirven, cada uno por su motivo:
--
--   `cortex.remember` (0051) es por-persona por diseño, y su propia descripción
--   lo dice en voz alta: los hechos que valen para todo el mundo «belong in a
--   company space». Escribir «cobramos a 30 días» ahí lo aprende UNA persona, y
--   la siguiente que pregunte recibe otra respuesta.
--
--   Brain Knowledge (`kb.*`) RECUPERA POR PARECIDO. Un dato permanente sólo
--   aparece cuando alguien pregunta con esas palabras — es decir, casi nunca
--   cuando de verdad hace falta. La 0051 ya escribió el argumento entero para
--   esta forma de dato y esta tabla lo hereda sin cambiarle una coma:
--
--     UN HECHO PERMANENTE SE INYECTA ENTERO, NUNCA SE RECUPERA.
--
--   La recuperación falla exactamente cuando el dato sigue aplicando pero la
--   pregunta no se le parece: «redáctale el correo al cliente» no menciona el
--   plazo de pago, y es justo el turno en el que el plazo de pago manda.
--
-- ===========================================================================
-- POR QUÉ UNA FILA POR HECHO Y NO UN TEXTO LARGO
-- ===========================================================================
-- La alternativa obvia era una columna `text` por espacio de trabajo con la
-- ficha de la empresa escrita a mano. Se descarta por tres cosas, y ninguna es
-- estética:
--
--   1. UN HECHO SE PUEDE BORRAR SOLO. Cuando el plazo de pago cambia de 30 a 45
--      días, se edita una fila. En un texto largo se edita un párrafo y se deja
--      la frase vieja tres renglones más abajo, donde nadie la ve y el modelo
--      sí.
--   2. EL PRESUPUESTO SE PUEDE MEDIR Y ENSEÑAR. Este bloque entra en CADA turno
--      de CADA superficie: es coste real y es contexto que se le quita a la
--      recuperación. Con filas, la pantalla dice «usaste 1.240 de 4.000». Con un
--      textarea, la pantalla dice «escribe lo que quieras» y alguien pega un
--      manual.
--   3. QUIÉN LO DIJO Y CUÁNDO, POR HECHO. Un dato de empresa envejece de forma
--      desigual: la razón social no, el organigrama sí. `updated_at` por fila es
--      lo único que permite ver cuál está viejo.
--
-- `sort` existe porque el ORDEN ES CONTENIDO en un bloque de prompt: la razón
-- social antes que el NIT, y «Lo que no» al final, que es donde una instrucción
-- pesa más.
--
-- ===========================================================================
-- LAS SECCIONES VIVEN EN TYPESCRIPT, NO EN UN CHECK
-- ===========================================================================
-- Igual que `goals.metric_key` (0101) y `document_extractions.doc_type` (0076),
-- el CHECK de `section` es DE FORMA y no de valor (`^[a-z][a-z0-9_]{2,39}$`). El
-- registro cerrado es COMPANY_SECTIONS en
-- packages/agent-tools/src/company/shape.ts, que además de la etiqueta en
-- español lleva los CAMPOS SUGERIDOS de cada sección — y eso es dato de
-- producto, no de esquema: añadir «Régimen tributario» a la lista de sugerencias
-- no puede costar una migración y un despliegue.
--
-- Lo que impide que aquí entre una sección inventada no es este patrón: es
-- `writeCompanyFact()`, que la busca en el registro antes de escribir.
--
-- ===========================================================================
-- UNA SOLA PUERTA DE ESCRITURA
-- ===========================================================================
--   public.company_facts  se escribe SÓLO desde `writeCompanyFact()` y se borra
--                         SÓLO desde `deleteCompanyFact()`, las dos en
--                         packages/agent-tools/src/company/store.ts.
--
-- La lección de la 0064 vale aquí también: una columna NOT NULL añadida sin
-- tocar la función que escribe dejó de guardar memorias durante semanas y nadie
-- se enteró, porque LA LECTURA seguía funcionando.
--
-- ===========================================================================
-- EL PRESUPUESTO NO SE HACE CUMPLIR AQUÍ, Y ESO ES UNA DECISIÓN
-- ===========================================================================
-- El tope duro de caracteres del bloque (COMPANY_FACTS_BUDGET) es una SUMA por
-- espacio de trabajo, y una suma no cabe en un CHECK: haría falta un trigger que
-- reagregara la tabla en cada INSERT. Se descarta porque el modo de fallo no lo
-- merece — pasarse de presupuesto es «el prompt salió más largo de lo que se
-- quería», no «se movió dinero de una empresa a otra». Vive en la puerta de
-- escritura, que lo rechaza con la cifra en la cara, y en la pantalla, que
-- enseña el medidor todo el rato. LO QUE NUNCA PASA ES QUE SE TRUNQUE EN
-- SILENCIO: el renderizador escribe todo lo que hay, siempre.
--
-- Los CHECK que sí hay son por fila y se probaron contra su caso nulo, que es la
-- trampa que ya mordió a este repositorio una vez: `array_length('{}',1)`
-- devuelve NULL y UN CHECK QUE DEVUELVE NULL PASA. Aquí no hay arreglos ni
-- comparaciones que puedan dar NULL: las tres columnas que se comprueban son NOT
-- NULL, así que `length(btrim(x))` es siempre un entero. `updated_by` es la
-- única nulable y deliberadamente no lleva CHECK ninguno.
--
-- ===========================================================================
-- TENANCY
-- ===========================================================================
-- `organization_id` NOT NULL desde la primera línea, registrada como `tenant()`
-- en packages/agent-tools/src/tenancy/tables.ts EN ESTE MISMO COMMIT —el cliente
-- con alcance rechaza una tabla sin clasificar y la primera consulta fallaría en
-- desarrollo—, y RLS deny-all + service_role igual que la 0069, la 0098 y la
-- 0101.
--
-- Idempotente de principio a fin.

create table if not exists public.company_facts (
  id              uuid        primary key default gen_random_uuid(),
  organization_id text        not null references public.ba_organization(id) on delete cascade,

  -- EN QUÉ PARTE DE LA FICHA VA. Slug de COMPANY_SECTIONS
  -- (packages/agent-tools/src/company/shape.ts). CHECK de forma, no de valor:
  -- ver la cabecera.
  section         text        not null check (section ~ '^[a-z][a-z0-9_]{2,39}$'),

  -- CÓMO SE LLAMA EL DATO. «NIT», «Plazo de pago», «Quién aprueba pagos».
  -- Corto a propósito: una etiqueta que necesita sesenta caracteres es una
  -- pregunta, y la respuesta va en `value`.
  label           text        not null check (length(btrim(label)) between 2 and 60),

  -- EL DATO, EN TEXTO LIBRE. Libre y no tipado porque un formulario de cuarenta
  -- casillas tipadas es un formulario que nadie termina: «a 30 días, salvo
  -- Bavaria que paga a 60» es la respuesta verdadera y ningún `interval` la
  -- guarda.
  value           text        not null check (length(btrim(value)) between 1 and 300),

  -- EL ORDEN ES CONTENIDO. Ver la cabecera. Se ordena dentro de la sección.
  sort            int         not null default 0 check (sort >= 0),

  -- QUIÉN LO DEJÓ ESCRITO, y `set null` A PROPÓSITO — aquí está la diferencia
  -- con `goals.created_by` (0101), que es NOT NULL con `on delete cascade`.
  --
  -- Una meta es la declaración de una persona y muere con ella. UN HECHO DE LA
  -- EMPRESA NO ES DE NADIE: el NIT no deja de ser el NIT porque quien lo tecleó
  -- se haya ido, y borrar en cascada lo que sabe la empresa cuando se da de baja
  -- a un empleado sería una pérdida de datos disfrazada de integridad
  -- referencial. Se pierde el nombre del autor y se conserva el hecho, que es el
  -- orden correcto.
  updated_by      uuid        references public.users(id) on delete set null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- DOS HECHOS CON LA MISMA ETIQUETA EN LA MISMA SECCIÓN SON DOS RESPUESTAS A LA
-- MISMA PREGUNTA, y quien las lea —persona o modelo— creerá que una de las dos
-- está mal sin poder decir cuál. `lower(btrim(...))` porque «NIT» y «nit» son la
-- misma casilla, y descubrirlo por duplicado en el prompt es descubrirlo tarde.
create unique index if not exists company_facts_label_once_idx
  on public.company_facts (organization_id, section, lower(btrim(label)));

-- El orden en que se lee la ficha y en que se arma el bloque, que es el mismo.
create index if not exists company_facts_org_section_idx
  on public.company_facts (organization_id, section, sort);

comment on table public.company_facts is
  'Los hechos estructurados de la empresa, una fila por hecho. Se INYECTAN ENTEROS en el prompt de cada turno de cada superficie (apps/web/lib/system-prompt.ts y el runner de rutinas), nunca se recuperan por parecido: ver la 0051 para el argumento completo. Una fila por hecho y no un texto largo para que un dato viejo se pueda borrar solo, para que el presupuesto de caracteres se pueda medir y enseñar, y para saber quién escribió cada cosa y cuándo. Se escribe únicamente desde writeCompanyFact().';

comment on column public.company_facts.section is
  'Slug de COMPANY_SECTIONS (packages/agent-tools/src/company/shape.ts). El CHECK es de forma y no de valor, igual que goals.metric_key: las secciones y sus campos sugeridos son dato de producto, y añadir una sugerencia no puede costar una migración. Lo que impide una sección inventada es writeCompanyFact().';

comment on column public.company_facts.value is
  'El dato en texto libre, sin tipar. Deliberado: «a 30 días, salvo Bavaria que paga a 60» es la respuesta verdadera y ningún tipo la guarda. Un formulario de cuarenta casillas tipadas es un formulario que nadie termina.';

comment on column public.company_facts.updated_by is
  'Quién lo dejó escrito. NULABLE y on delete set null, al revés que goals.created_by: una meta es la declaración de una persona y muere con ella, pero el NIT no deja de ser el NIT porque quien lo tecleó se haya ido. Se pierde el autor, se conserva el hecho.';

-- ===========================================================================
-- Acceso
-- ===========================================================================
-- Deny-all + service_role, igual que la 0069, la 0098 y la 0101. La frontera de
-- inquilino es createOrgScopedClient, no una política contra auth.uid().

alter table public.company_facts enable row level security;

revoke all on table public.company_facts from public, anon, authenticated;

-- Las cuatro, y las cuatro se usan: la pantalla crea, edita en sitio y borra un
-- hecho suelto. No hay ningún verbo que retirar aquí — a diferencia de
-- `goal_readings` (0101), donde UPDATE había que quitarlo porque la congelación
-- era el punto.
grant select, insert, update, delete on table public.company_facts to service_role;

-- EL REVOKE QUE SÍ HACE FALTA, Y QUE NO SE VE EN EL GRANT DE ARRIBA.
--
-- Supabase deja puesto un `alter default privileges in schema public grant all
-- on tables to service_role`, así que toda tabla nueva NACE con TODO concedido,
-- y `grant all` incluye TRUNCATE. Conceder de menos no es revocar: el `grant`
-- de arriba se lee bien en el diff, pasa la revisión, y no le quita nada.
--
-- TRUNCATE es la única sentencia que puede vaciar esta tabla ENTERA IGNORANDO
-- `organization_id`. Todo lo demás pasa por el cliente con alcance, que no sabe
-- escribir un DELETE sin filtro; TRUNCATE no admite WHERE por definición, así
-- que el filtro no es que se olvide — es que no existe. Ninguna ruta de este
-- producto trunca nada. Quitarlo cuesta una línea y cierra la única forma que
-- tiene esta tabla de perder los datos de todos los inquilinos a la vez.
revoke truncate on table public.company_facts from service_role;
