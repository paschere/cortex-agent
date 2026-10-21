-- 0236 — Experimento de modelos en el chat: Haiku 5.5 contra Sonnet 5.5.
--
-- Un porcentaje de las conversaciones (CHAT_HAIKU_SHARE, 15 por defecto) corre
-- en Haiku 5.5 y el resto en Sonnet 5.5. La asignación es estable por
-- conversación (hash del id; el caché de prompts es por modelo, así que no se
-- cambia a mitad). `model_usage` ya guarda el modelo de cada turno; aquí se le
-- agrega lo que hace falta para compararlos:
--
--   experiment_arm  el brazo ASIGNADO a la conversación ('haiku' | 'sonnet');
--                   null = turno fuera del experimento (agente con otro modelo,
--                   tareas, Google Chat…). Se guarda aparte de `model` porque
--                   una conversación de Haiku que cayó a Sonnet sigue siendo del
--                   brazo Haiku: comparar por brazo (intención de tratar) no
--                   esconde los fallos de Haiku detrás del rescate de Sonnet.
--   tool_errors     herramientas que devolvieron error en este turno.
--   retries         reintentos del turno: reparación de argumentos, llamada
--                   forzada repetida, caída a Sonnet tras un refusal.
--   refusals        veces que el modelo se negó (stop_reason = refusal).
--   fell_back       este turno corrió en Sonnet por un fallo previo del brazo
--                   Haiku (dos fallos de herramienta o un refusal).
--
-- Enteros y banderas, sin texto, igual que el resto del libro. Lo lee el panel
-- /admin/usage (comparación por modelo) y la decisión «¿sigue en Haiku?» de cada
-- turno (suma por conversación).

alter table public.model_usage
  add column if not exists experiment_arm text
    check (experiment_arm is null or experiment_arm in ('haiku', 'sonnet')),
  add column if not exists tool_errors integer not null default 0 check (tool_errors >= 0),
  add column if not exists retries integer not null default 0 check (retries >= 0),
  add column if not exists refusals integer not null default 0 check (refusals >= 0),
  add column if not exists fell_back boolean not null default false;

comment on column public.model_usage.experiment_arm is
  'Brazo del experimento de modelos asignado a la conversación (haiku | sonnet); null fuera del experimento (0236).';
comment on column public.model_usage.fell_back is
  'El turno corrió en Sonnet porque la conversación, asignada a Haiku, falló dos herramientas o recibió un refusal (0236).';

-- «¿Esta conversación de Haiku ya falló?»: una consulta por turno, sólo en el
-- brazo Haiku. El índice parcial ya existente por conversación la sirve; este
-- cubre la comparación del panel por brazo y fecha.
create index if not exists model_usage_experiment_idx
  on public.model_usage (organization_id, occurred_at desc)
  where experiment_arm is not null;
