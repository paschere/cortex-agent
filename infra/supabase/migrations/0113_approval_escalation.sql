-- El rastro de una aprobación que subió un escalón porque nadie la contestó.
--
-- ===========================================================================
-- EL HUECO QUE ESTO TAPA, MEDIDO
-- ===========================================================================
-- La 0077 puso la cola de aprobaciones que de verdad se queda parada:
-- `public.actions` en `state='proposed'`, viva siete días (`PROPOSAL_TTL_MS`,
-- packages/agent-tools/src/actions/shape.ts). El barrido de las 06:30 de Bogotá
-- (apps/web/inngest/functions/actions-sweep.ts) las propone cada mañana y luego
-- cierra el ciclo de las que ya se ejecutaron. Entre esas dos cosas no hay
-- nada, y ese hueco es el modo de fallo entero de la función:
--
--   Cortex redacta el cobro un lunes. Se lo deja a Ana, que es quien responde
--   por esa cartera. Ana no entra el lunes, ni el martes. El miércoles la
--   propuesta sigue ahí, idéntica, sin que se haya movido nada — y el índice
--   `actions_open_origin_idx` impide (con razón) que se proponga una segunda.
--   El domingo expira. Nadie se enteró nunca. La factura sigue sin cobrarse y
--   NO HAY NINGUNA PANTALLA DONDE ESO SE VEA ROTO: la fila existe, el barrido
--   corrió los siete días, todos los registros dicen «ok».
--
-- Un silencio que no deja rastro es indistinguible de un «no hacía falta». Con
-- estas tres columnas, a las N horas (`APPROVAL_ESCALATION_HOURS`, 48 por
-- defecto) el jefe de Ana recibe un correo diciendo que eso lleva dos días
-- parado, y la fila guarda cuándo se avisó, a quién y por qué camino.
--
-- ===========================================================================
-- ESCALAR NO ES TRANSFERIR. NUNCA SE TOCA `user_id`
-- ===========================================================================
-- `claimAction` (packages/agent-tools/src/actions/store.ts) sólo deja aprobar
-- al `user_id` dueño de la fila, y eso NO es una restricción que este archivo
-- pueda relajar: el correo sale del Gmail de esa persona y va firmado con su
-- nombre. Que lo aprobara su jefe sería una firma falsificada con traza de
-- auditoría — el propio comentario de `actions.user_id` en la 0077 lo dice.
--
-- Así que escalar aquí significa exactamente una cosa: AVISARLE AL JEFE QUE ESO
-- LLEVA N HORAS PARADO. El jefe no puede aprobarlo desde el correo, y el texto
-- se lo dice; lo que puede hacer es ir y mover a su gente, que es justo lo que
-- nadie estaba haciendo. Por eso las columnas de abajo son un rastro de aviso y
-- ninguna de ellas cambia quién decide.
--
-- ===========================================================================
-- POR QUÉ ESTO VIVE SOBRE `actions` Y NO SOBRE `mcp_pending_actions`
-- ===========================================================================
-- Este producto tiene DOS colas de aprobación y sólo una de ellas se puede
-- escalar con un barrido:
--
--   `public.actions` (0077)              expira a los 7 DÍAS.
--   `public.mcp_pending_actions` (0033)  expira a los 15 MINUTOS
--                                        (`APPROVAL_TTL_MS`, apps/web/lib/approval-email.ts).
--
-- Un barrido diario no puede escalar nada que muera en quince minutos: para
-- cuando el cron de las 06:30 mira la tabla, todo lo que había ya expiró hace
-- horas, y lo único que se conseguiría es mandarle al jefe un correo sobre una
-- llamada que ya nadie puede aprobar. Ese es ruido puro y además desprestigia
-- el canal — un jefe al que le llegan tres avisos inútiles deja de abrir el
-- cuarto, que es el que importaba.
--
-- La cola de quince minutos ya tiene su propia respuesta al silencio y es la
-- correcta para su escala: la petición se manda a la vez por correo y por DM de
-- Google Chat (apps/web/lib/approval-email.ts) para alcanzar la superficie que
-- la persona tenga abierta AHORA. Si esa ventana hay que atenderla mejor, se
-- arregla ahí, en segundos, no aquí con un cron diario.
--
-- ===========================================================================
-- LAS TRES COLUMNAS, O NINGUNA
-- ===========================================================================
-- Un rastro a medias es peor que no tener rastro: «escalado el martes, no se
-- sabe a quién» no se puede auditar ni corregir, y encima el barrido lo ve como
-- ya escalado y no lo vuelve a intentar. El CHECK de abajo está escrito con
-- `is null` / `is not null` en TODAS sus ramas a propósito: un CHECK que
-- devuelve NULL PASA, y esa trampa ya mordió a este repositorio una vez
-- (`array_length('{}',1)`, ver la 0106). Aquí no hay ninguna comparación que
-- pueda devolver NULL.
--
-- LA ASIMETRÍA DE `escalated_to` NO ES UN DESCUIDO. La segunda rama exige
-- `escalated_at` y `escalated_via`, pero NO `escalated_to`, porque esa columna
-- es `on delete set null`: el día que se borre la cuenta del jefe, Postgres la
-- pone a NULL sobre una fila que sí fue escalada. Exigirla ahí convertiría
-- «borrar a un usuario» en un error de restricción sobre una tabla que no tiene
-- nada que ver. El hecho de que se escaló y por qué camino sobrevive a la
-- cuenta; el id de la persona no tiene por qué.
--
-- Idempotente de principio a fin.

alter table public.actions
  add column if not exists escalated_at  timestamptz,
  add column if not exists escalated_to  uuid references public.users(id) on delete set null,
  add column if not exists escalated_via text;

-- El vocabulario, aparte de la columna para que `add column if not exists`
-- siga siendo idempotente en una base donde las columnas ya existen.
--
-- Dos valores y no cuatro: `escalationTarget` sabe resolver también 'named' y
-- 'none' (packages/agent-tools/src/directory/line.ts), pero una acción no tiene
-- dónde nombrar a nadie a mano —eso es de `commitments`— y 'none' no se escribe
-- nunca, porque sin destinatario no hay fila que marcar. Cuando este rastro
-- admita un tercer camino, será una migración, igual que el cuarto `kind` de la
-- 0077: un vocabulario con valores que nadie escribe se lee mal para siempre.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'actions_escalated_via_known') then
    alter table public.actions
      add constraint actions_escalated_via_known
      check (escalated_via is null or escalated_via in ('manager','admin'));
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'actions_escalation_complete') then
    alter table public.actions
      add constraint actions_escalation_complete
      check (
        (escalated_at is null and escalated_to is null and escalated_via is null)
        or
        (escalated_at is not null and escalated_via is not null)
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- La pregunta que hace el barrido, y sólo esa
-- ---------------------------------------------------------------------------
-- «¿Qué lleva parado y todavía no se ha escalado?» — una vez por espacio de
-- trabajo, cada mañana. Parcial por las dos condiciones a la vez porque las dos
-- son permanentes en el sentido que importa: una acción decidida no vuelve a
-- 'proposed' (ver la 0077) y un escalado no se deshace, así que una fila sale
-- de este índice y no regresa. En una empresa con años de historia lo que queda
-- indexado son las pocas decenas de filas que de verdad están esperando.
--
-- Por `created_at` ascendente y no descendente, al revés que el resto de
-- índices de esta tabla: aquí lo primero que se quiere es LO MÁS VIEJO, que es
-- lo que lleva más tiempo sin que nadie lo mire.
create index if not exists actions_escalation_pending_idx
  on public.actions (organization_id, created_at)
  where state = 'proposed' and escalated_at is null;

-- ---------------------------------------------------------------------------

comment on column public.actions.escalated_at is
  'Cuándo se le avisó a alguien por encima del dueño de que esta propuesta llevaba demasiado tiempo sin contestar. Nulo es lo normal: la inmensa mayoría se aprueban o se descartan antes. Es además la marca de idempotencia del barrido — el UPDATE que la escribe lleva `escalated_at is null` en su WHERE, así que dos corridas simultáneas mandan un aviso, no dos.';

comment on column public.actions.escalated_to is
  'A quién se le avisó. NO es quien puede aprobar: aprobar sigue siendo exclusivo de user_id, porque el correo sale de su Gmail y va firmado con su nombre (ver actions.user_id). Se queda en NULL si esa cuenta se borra, y la fila sigue siendo un rastro válido gracias a escalated_via.';

comment on column public.actions.escalated_via is
  'Por dónde se resolvió el destinatario: manager = el jefe del dueño (users.manager_id, migración 0106), admin = el primer administrador en orden estable, porque el dueño no tenía jefe puesto. La decisión entera vive en escalationsDue() + escalationTarget(), funciones puras con pruebas, porque un escalado que va a la persona equivocada no se ve roto en ninguna pantalla.';
