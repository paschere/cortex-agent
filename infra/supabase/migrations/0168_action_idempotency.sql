-- ===========================================================================
-- ACCIONES SEGURAS DE REPETIR
-- ===========================================================================
-- Un reintento del modelo, de la red, de un paso de Inngest o de pg-boss, o un
-- doble clic en «Aprobar» podían mandar el mismo correo dos veces, crear el
-- mismo evento dos veces o anotar el mismo pago dos veces. La segunda llegada
-- no es una segunda intención: es la primera otra vez.
--
-- `action_idempotency` es el reclamo. Una fila por (empresa, clave), donde la
-- clave es el sha256 de quién actúa + qué herramienta + sus datos canonizados
-- (+ la ejecución de la rutina, cuando la hay). `runTool`
-- (packages/agent-tools/src/registry.ts) la reclama antes de ejecutar:
--
--   · primera vez: `insert`; la restricción única deja entrar a uno solo;
--   · después: `update … where attempt_id = <leído> and status = <leído>`,
--     compare-and-swap, para reintentar un fallo o repetir a sabiendas.
--
-- Estados: in_flight → succeeded | failed. Un `succeeded` dentro de su ventana
-- (`window_ends_at`) se devuelve en vez de repetirse; un `failed` se puede
-- reintentar; un `in_flight` reciente rechaza la ejecución concurrente.
--
-- QUÉ GUARDA. El resultado de la herramienta sólo si cabe (8 kB) — ids,
-- destinatario, asunto: lo que hace falta para decir «ya lo hice» con lo que se
-- hizo. Nunca el input: de él sólo queda la huella. Y la verificación posterior
-- (`verified` / `not_verified` / `unverifiable`) con su frase.
--
-- RETENCIÓN. `action_idempotency_purge()` borra lo que venció hace más de dos
-- días; la llama el barrido nocturno de latencias
-- (apps/web/inngest/functions/turn-context-purge.ts).
--
-- Tenencia: `organization_id` en cada fila, `tenant()` en tenancy/tables.ts.
-- Sólo service_role: la tabla la toca el runtime, nunca un navegador.

create table public.action_idempotency (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      text not null,
  key                  text not null check (key ~ '^[0-9a-f]{64}$'),
  tool_id              text not null check (char_length(tool_id) between 1 and 200),
  user_id              uuid not null,
  conversation_id      uuid,
  -- La ejecución concreta (p. ej. `routine:<id>:<hora programada>`), si la hay.
  scope                text check (scope is null or char_length(scope) <= 300),
  status               text not null check (status in ('in_flight', 'succeeded', 'failed')),
  -- Quién tiene el reclamo ahora. Cambia en cada toma; es el testigo del CAS.
  attempt_id           uuid not null,
  attempts             integer not null default 1 check (attempts >= 1),
  claimed_at           timestamptz not null default now(),
  finished_at          timestamptz,
  -- Hasta cuándo lo hecho se devuelve en vez de repetirse. Sólo en `succeeded`.
  window_ends_at       timestamptz,
  result               jsonb,
  result_summary       text check (result_summary is null or char_length(result_summary) <= 300),
  error                text check (error is null or char_length(error) <= 500),
  verification         text check (verification is null or verification in ('verified', 'not_verified', 'unverifiable')),
  verification_detail  text check (verification_detail is null or char_length(verification_detail) <= 300),
  created_at           timestamptz not null default now(),
  -- La unicidad ES el índice de búsqueda: (organization_id, key).
  constraint action_idempotency_org_key unique (organization_id, key)
);

create index action_idempotency_purge_idx
  on public.action_idempotency ((coalesce(window_ends_at, claimed_at)));

comment on table public.action_idempotency is
  'Reclamo de idempotencia de las herramientas con efectos: una fila por acción (empresa + huella de quién, qué y con qué datos). runTool la reclama antes de ejecutar; lo ya hecho dentro de la ventana se devuelve en vez de repetirse.';

alter table public.action_idempotency enable row level security;
revoke all on table public.action_idempotency from public, anon, authenticated;
grant select, insert, update, delete on table public.action_idempotency to service_role;

create or replace function public.action_idempotency_purge()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted bigint;
begin
  with removed as (
    delete from public.action_idempotency
    where coalesce(window_ends_at, claimed_at) < now() - interval '2 days'
    returning 1
  )
  select count(*) into v_deleted from removed;

  return v_deleted;
end;
$$;

comment on function public.action_idempotency_purge() is
  'Retención de action_idempotency: borra las filas cuya ventana (o reclamo) venció hace más de dos días y devuelve cuántas. Mantenimiento de toda la instalación — sin argumento de empresa, nada visible por empresa.';

revoke all on function public.action_idempotency_purge() from public;
revoke all on function public.action_idempotency_purge() from anon, authenticated;
grant execute on function public.action_idempotency_purge() to service_role;
