-- EL PLAN CON EL QUE NACE UN ESPACIO DE TRABAJO PASA A SER `enterprise`.
--
-- ===========================================================================
-- QUÉ ESTABA PASANDO, Y POR QUÉ NO SE VEÍA
-- ===========================================================================
-- La 0085 puso un disparador que le escribe `plan_code = 'free'` a cada
-- `ba_organization` nueva. El plan Gratis da QUINCE documentos por asiento, y
-- pasarse de ahí no bloquea: DEGRADA. El documento se guarda, se puede leer y se
-- puede buscar por palabra — lo único que no ocurre es la vectorización.
--
-- Ese diseño es correcto y no se toca (ver LIMIT_POLICY en
-- packages/agent-tools/src/billing/plans.ts: nunca se pierde lo que el cliente
-- ya entregó). Lo que estaba mal era el número: quince documentos se agotan en
-- una tarde, y lo que la persona ve entonces es que Cortex «ya no encuentra»
-- cosas que sí subió. Medido en producción el 15-08-2026: el proveedor de
-- vectorización llevaba consumido el 0,1% de su cuota gratuita — no porque se
-- usara poco, sino porque el medidor había parado la indexación hacía rato. El
-- síntoma que llegó a soporte fue «se acabaron los créditos de vectorización»,
-- que apunta a un proveedor que no tenía nada que ver.
--
-- ===========================================================================
-- POR QUÉ `enterprise` Y NO UN NÚMERO MÁS GRANDE
-- ===========================================================================
-- `enterprise` (0086 § 4) ya existe y ya es exactamente esto: `answers_per_seat`
-- y `documents_per_seat` en NULL —sin tope— y `seats_maximum` en NULL. Subirle
-- el número a `free` en su lugar dejaría dos planes pareciéndose y a nadie
-- sabiendo cuál es el de verdad; repuntar el defecto a un plan que ya significa
-- «sin tope» dice la intención sin inventar una fila nueva.
--
-- `self_serve` sigue en `false` para `enterprise`, así que NO aparece como algo
-- que alguien pueda contratarse solo desde la pantalla de planes. Eso es lo
-- correcto mientras el producto no cobra: el catálogo se sigue leyendo, la
-- pantalla sigue diciendo la verdad, y el día que haya que cobrar se cambia
-- este defecto y ya.
--
-- ===========================================================================
-- LO QUE ESTA MIGRACIÓN DELIBERADAMENTE NO HACE
-- ===========================================================================
-- No toca `FALLBACK_PLAN` en el código, que sigue siendo el plan Gratis. Y no es
-- una contradicción: aquel contesta «¿qué hago si un espacio NO TIENE fila de
-- suscripción?», que es una anomalía, y su comentario explica por qué una
-- anomalía no puede regalar servicio ilimitado —nadie reporta la que le
-- beneficia—. Esto de aquí es lo contrario: un defecto DELIBERADO que escribe
-- una fila de verdad. Las dos respuestas siguen siendo las correctas para su
-- pregunta.
--
-- Idempotente de principio a fin.

-- ---------------------------------------------------------------------------
-- 1. Los que nazcan de ahora en adelante
-- ---------------------------------------------------------------------------
-- Misma función que la 0085, con una palabra distinta. Se reescribe entera en
-- vez de parchearse para que quien la lea vea el cuerpo completo y no tenga que
-- reconstruirlo a partir de dos migraciones.
create or replace function public.organization_default_subscription()
returns trigger
language plpgsql
as $$
begin
  if new.id in ('cortex-template', 'cortex-quarantine') then
    return null;
  end if;

  insert into public.organization_subscriptions (organization_id, plan_code)
  values (new.id, 'enterprise')
  on conflict (organization_id) do nothing;

  insert into public.organization_onboarding (organization_id)
  values (new.id)
  on conflict (organization_id) do nothing;

  return null;
end;
$$;

-- El disparador no cambia de forma; se vuelve a declarar por si esta migración
-- corre sobre una base donde la 0085 no lo dejó puesto.
drop trigger if exists ba_organization_default_plan on public.ba_organization;
create trigger ba_organization_default_plan
  after insert on public.ba_organization
  for each row execute function public.organization_default_subscription();

-- ---------------------------------------------------------------------------
-- 2. Los que ya existen
-- ---------------------------------------------------------------------------
-- Sólo los que están en `free`, y sólo los que están activos. Un espacio que
-- alguien puso a mano en otro plan tiene una razón detrás y no se pisa; uno
-- cancelado o suspendido no se resucita subiéndole el plan.
--
-- `status`, `started_at`, `notes`, `billing_customer_ref` y
-- `billing_subscription_ref` no se nombran, así que no se pueden perder — misma
-- disciplina que el repunte de `custom` a `enterprise` en la 0086.
update public.organization_subscriptions
   set plan_code = 'enterprise',
       updated_at = now()
 where plan_code = 'free'
   and status = 'active';

-- ---------------------------------------------------------------------------
-- 3. Lo que quedó sin indexar mientras el medidor estaba en Gratis
-- ---------------------------------------------------------------------------
-- No hay nada que hacer aquí, y conviene decirlo para que nadie lo busque:
-- `kb/embeddings.reindex` corre cada quince minutos, ya sabe encontrar los
-- trozos sin vector (`embedding is null`) y los va llenando solo en cuanto el
-- medidor deja de degradar. Nadie tiene que volver a subir un archivo.
