-- ---------------------------------------------------------------------------
-- Una promesa entre dos personas de la empresa es un compromiso más.
-- ---------------------------------------------------------------------------
--
-- La 0069 creó `commitments` para papeles con vencimiento: SOAT, tecnomecánica,
-- contratos, pólizas, aduana. Ocho tipos, y los ocho se los debe la empresa a
-- alguien de fuera. «Ana quedó de mandar el informe el viernes» solo cabía en
-- `other`, que avisa con quince días de antelación — es decir, avisaba hoy de
-- algo que es el viernes, y así es como se le enseña a alguien a no leer los
-- correos de Cortex.
--
-- POR QUÉ UN VALOR MÁS Y NO UNA TABLA APARTE. Una tabla nueva significaría una
-- segunda copia de siete mecanismos que ya existen y ya están probados: el
-- estado derivado contra el día de hoy en Bogotá, el libro de avisos con su
-- índice único, la escalación con supresión por acuse de recibo, la sincronía
-- con el calendario, el vigilante de las 06:00, el barrido que redacta el
-- recordatorio y los informes. Siete caminos duplicados es exactamente la forma
-- de repetir a escala lo que pasó entre la 0051 y la 0064.
--
-- La objeción legítima —un SOAT es una obligación legal y una promesa entre
-- colegas es social— es cierta, y toda esa diferencia vive en tres sitios que
-- YA son por tipo: cuántos días de aviso merece (`DEFAULT_NOTICE_DAYS`, que
-- para este vale 1), a los cuántos días se sube por encima de la persona
-- (`escalate_after_days`, que se fija por fila) y cómo se redacta el
-- recordatorio. Eso es la diferencia de una fila, no la de una tabla.
--
-- LO QUE NO CAMBIA, Y ES DELIBERADO. `source_kind` sigue siendo
-- ('manual','system','document'). Una promesa que alguien le dice a Cortex en
-- el chat ES `manual`, y `source_user_id` es quien la dijo. Una que Cortex lee
-- en un acta de reunión ES `document`, con la cita literal y en
-- `review_state='pending'` — o sea invisible para el vigilante hasta que una
-- persona la confirme. Cortex no debe perseguir a nadie porque un modelo creyó
-- leer una promesa en una transcripción.
-- ---------------------------------------------------------------------------

alter table public.commitments
  drop constraint if exists commitments_kind_check;

alter table public.commitments
  add constraint commitments_kind_check
  check (kind in ('soat','rtm','contract','policy',
                  'warranty','customs','payment','internal','other'));

comment on column public.commitments.kind is
  'Qué clase de cosa es. Los ocho primeros son papeles con vencimiento frente a '
  'terceros; `internal` es una promesa entre dos personas de la empresa. La lista '
  'canónica vive en COMMITMENT_KINDS (packages/agent-tools/src/commitments/shape.ts) '
  'y un test compara este CHECK con ella.';
