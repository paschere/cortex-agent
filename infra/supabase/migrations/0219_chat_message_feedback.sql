-- 0219 — Cortex aprende de cada error: 👍/👎 en cada respuesta del chat.
--
-- Una fila por persona y por respuesta (se puede cambiar o quitar el voto).
-- Guarda la pregunta y la respuesta tal como estaban, porque un 👎 sólo sirve
-- si después alguien puede ver QUÉ salió mal; de ahí salen los «casos
-- candidatos» para la evaluación (`case_status`): una persona los revisa en
-- /learning y decide si pasan a la suite de pruebas.
--
-- Tenencia: `organization_id` en cada fila (`tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts). RLS deny-all + service_role,
-- igual que memory_proposals (0157).

create table if not exists public.chat_message_feedback (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  -- La respuesta valorada. Sin FK a propósito: el id que conoce el navegador en
  -- el turno en vivo todavía no es el de la fila, y el servidor guarda el real.
  message_id       text not null,
  rating           smallint not null check (rating in (-1, 1)),
  reason           text check (reason is null or reason in ('wrong_data', 'not_requested', 'slow', 'other')),
  comment          text check (comment is null or char_length(comment) <= 1000),
  question         text check (question is null or char_length(question) <= 4000),
  answer           text check (answer is null or char_length(answer) <= 8000),
  -- Candidato a caso de prueba: sólo los 👎. null = nadie lo ha revisado.
  case_status      text check (case_status is null or case_status in ('promoted', 'dismissed')),
  case_decided_by  uuid references public.users(id) on delete set null,
  case_decided_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, message_id)
);

create index if not exists chat_message_feedback_org_idx
  on public.chat_message_feedback (organization_id, created_at desc);
create index if not exists chat_message_feedback_conversation_idx
  on public.chat_message_feedback (conversation_id, created_at);

comment on table public.chat_message_feedback is
  '👍/👎 de cada persona sobre una respuesta de Cortex, con motivo y comentario opcionales, la pregunta y la respuesta. Alimenta la señal de aprendizaje, las propuestas de memoria y los casos candidatos de evaluación.';

alter table public.chat_message_feedback enable row level security;
revoke all on table public.chat_message_feedback from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_message_feedback to service_role;

-- La señal de aprendizaje nueva: una respuesta valorada.
alter table public.learning_signals
  drop constraint if exists learning_signals_kind_check;
alter table public.learning_signals
  add constraint learning_signals_kind_check
  check (kind in (
    'reformulated',
    'abandoned',
    'moved_on',
    'fragment_copied',
    'extraction_corrected',
    'extraction_rejected',
    'extraction_confirmed',
    'field_corrected',
    'answer_rated'
  ));
