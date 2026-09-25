-- ===========================================================================
-- 0158 · El libro de avisos del seguimiento de Gerencia
-- ===========================================================================
-- Gerencia (0130) mostraba los asuntos que necesitaban atención pero no le
-- escribía a nadie: el responsable de escalamiento aparecía con nombre y nunca
-- recibía un mensaje. El vigilante nuevo (apps/web/inngest/functions/
-- management-follow-up.ts) avisa cada mañana hábil al responsable y, si en dos
-- días hábiles el asunto no cambió, escala. Esta tabla es cómo sabe que ya lo
-- dijo.
--
-- ¿POR QUÉ UNA TABLA NUEVA Y NO LAS QUE HAY?
--   commitment_notices (0069)  su clave es commitment_id con foránea a
--                              commitments; un asunto no es un compromiso.
--   goal_notices (0101)        lo mismo con goals.
--   notifications (0132)       tiene dedupe_key, y el aviso en la app lo usa,
--                              pero es la bandeja de UNA persona: no guarda si
--                              el correo salió, ni el día desde el que se
--                              cuentan los dos días hábiles del escalado, ni
--                              sobrevive a que la persona lo borre.
--
-- LA IDENTIDAD ES (asunto, revisión, paso). Todo cambio guardado sube la
-- revisión del asunto, así que «el responsable respondió» es «la revisión ya no
-- es la del aviso», sin adivinar. El índice único decide «¿ya dijimos esto?»,
-- igual que commitment_notices_once_idx: correr el cron diez veces manda un
-- aviso. El paso `unowned` (a administradores, sin responsable) sale UNA vez
-- por asunto en toda su vida; lo impone el segundo índice, no el código.
--
-- UNA SOLA PUERTA: se escribe únicamente desde claimFollowUpNotice() /
-- settleFollowUpNotice() / releaseFollowUpNotice() en
-- packages/agent-tools/src/management/follow-up-store.ts.
--
-- TENANCY: organization_id NOT NULL, registrada como tenant() en
-- packages/agent-tools/src/tenancy/tables.ts en el mismo cambio, RLS deny-all +
-- service_role como la 0069 y la 0101.
--
-- El interruptor por empresa NO necesita columna: vive en
-- management_profiles.data.followUp (encendido si falta), que ya se guarda con
-- management_save_profile y su control de revisión.
--
-- Idempotente de principio a fin.

create table if not exists public.management_case_notices (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    text        not null references public.ba_organization(id) on delete cascade,
  case_id            uuid        not null references public.management_cases(id) on delete cascade,
  -- La revisión del asunto que motivó el aviso. Parte de la identidad.
  case_revision      integer     not null check (case_revision >= 1),
  step               text        not null check (step in ('owner','escalation','unowned')),
  reasons            text[]      not null default '{}'
                     check (reasons <@ array['review_due','overdue','blocked_stale','unowned']::text[]),
  -- El día de Bogotá en que salió (o se reintentó con éxito). Desde aquí se
  -- cuentan los días hábiles del escalado.
  sent_on            date        not null,
  -- Siempre miembros de la empresa, resueltos contra el directorio con el
  -- handle de la empresa. Sin foránea porque es un arreglo; el código no
  -- admite otro origen.
  recipient_user_ids uuid[]      not null default '{}' check (cardinality(recipient_user_ids) <= 20),
  -- Por dónde se resolvió un escalado: nombrado en el perfil, jefe, administrador.
  via                text        check (via in ('named','manager','admin')),
  -- El resultado, separado de la reclamación: un aviso reclamado que no llegó
  -- por ningún canal se queda en false y lo reintenta la mañana siguiente.
  delivered          boolean     not null default false,
  note               text        check (length(note) <= 500),
  settled_at         timestamptz,
  created_at         timestamptz not null default now()
);

create unique index if not exists management_case_notices_once_idx
  on public.management_case_notices (case_id, case_revision, step);

create unique index if not exists management_case_notices_unowned_once_idx
  on public.management_case_notices (case_id) where step = 'unowned';

create index if not exists management_case_notices_org_recent_idx
  on public.management_case_notices (organization_id, created_at desc);

comment on table public.management_case_notices is
  'Libro de avisos del seguimiento de Gerencia. Un aviso por (asunto, revisión, paso): owner al responsable, escalation a quien está encima tras dos días hábiles sin cambio, unowned a administradores una sola vez por asunto. Se escribe únicamente desde management/follow-up-store.ts.';

alter table public.management_case_notices enable row level security;
revoke all on table public.management_case_notices from public, anon, authenticated;
grant select, insert, update, delete on table public.management_case_notices to service_role;
