-- ===========================================================================
-- AUTOMATIZACIONES QUE ESPERAN A UNA PERSONA (trámites que se detienen)
-- ===========================================================================
-- Cuando «Pedirle algo a Cortex» corre un trámite aprendido del navegador
-- (browser.run_flow) y el portal se detiene —un código por SMS, un captcha, o
-- la sesión del perfil venció— nadie está delante para contestar. La corrida
-- NO falla ni se reintenta a ciegas: queda «esperando a una persona»
-- (`waiting_person`), se le avisa a quien puede resolverlo (campana, push y
-- correo) con un enlace, y al resolverse se reanuda y la automatización sigue
-- con el resultado. Si nadie lo atiende a tiempo, la corrida queda «sin
-- resolver» (`unresolved`) y se avisa.
--
--   custom_app_automation_waits  una espera por (corrida × acción) abierta a la
--                                vez; guarda a quién se le avisó, el
--                                checkpoint del trámite (0111) o el perfil por
--                                reabrir sesión, cuándo vence y, al resolverse,
--                                lo que el trámite devolvió (`outcome`).
--
-- Idempotencia: el índice único parcial deja UNA espera abierta por
-- (corrida, acción); resolver o vencer es un UPDATE condicionado a
-- `state = 'waiting'`, así que dos barridos no reencolan dos veces.
-- La pestaña del navegador la sostiene el servicio (BROWSER_HANDOFF_HOLD_MS);
-- sin subir ese valor sólo dura unos minutos.
-- ===========================================================================

alter table public.custom_app_automation_runs
  drop constraint if exists custom_app_automation_runs_status_check;
alter table public.custom_app_automation_runs
  add constraint custom_app_automation_runs_status_check
  check (status in ('queued', 'running', 'succeeded', 'failed', 'skipped', 'waiting_person', 'unresolved'));

create table if not exists public.custom_app_automation_waits (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  app_id           uuid not null references public.custom_apps (id) on delete cascade,
  automation_id    uuid not null references public.custom_app_automations (id) on delete cascade,
  run_id           uuid not null references public.custom_app_automation_runs (id) on delete cascade,
  -- Qué acción de la regla (ask_cortex) quedó esperando.
  action_index     integer not null check (action_index >= 0),
  -- 'checkpoint' = el trámite quedó parado (código/captcha) y se reanuda con
  --                su checkpoint; 'login' = hay que volver a iniciar sesión en
  --                el perfil y la persona avisa «ya está».
  kind             text not null check (kind in ('checkpoint', 'login')),
  checkpoint_id    uuid references public.browser_flow_checkpoints (id) on delete set null,
  flow_slug        text not null,
  flow_name        text not null,
  -- La pregunta, en las palabras del trámite (ya redactada, sin secretos).
  ask              text not null default '',
  -- A quién se le avisó y quién puede resolverla.
  notify_user_id   uuid references public.users (id) on delete set null,
  state            text not null default 'waiting'
                   check (state in ('waiting', 'resolved', 'unresolved')),
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  -- Lo que devolvió el trámite al resolverse: { ok, result?, error?, note? }.
  outcome          jsonb,
  -- Por qué quedó sin resolver.
  reason           text
);

create unique index if not exists custom_app_automation_waits_open_idx
  on public.custom_app_automation_waits (run_id, action_index)
  where state = 'waiting';
create index if not exists custom_app_automation_waits_due_idx
  on public.custom_app_automation_waits (expires_at)
  where state = 'waiting';
create index if not exists custom_app_automation_waits_run_idx
  on public.custom_app_automation_waits (run_id, action_index, created_at desc);

comment on table public.custom_app_automation_waits is
  'Una automatización que se detuvo esperando a una persona (código, captcha o volver a iniciar sesión en un trámite del navegador). Se resuelve, o vence como «sin resolver».';

alter table public.custom_app_automation_waits enable row level security;
revoke all on table public.custom_app_automation_waits from public, anon, authenticated;
grant select, insert, update, delete on table public.custom_app_automation_waits to service_role;
