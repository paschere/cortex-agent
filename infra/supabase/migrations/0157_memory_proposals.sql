-- ===========================================================================
-- LO QUE SE DICE EN EL CHAT, PROPUESTO PARA LA MEMORIA DE LA EMPRESA
-- ===========================================================================
-- «Quedamos en 45 días con Nexa», «la tarifa a Cali subió a 2,1 millones», «el
-- contacto de compras de Acme ahora es Laura». Se dicen en una conversación y
-- al cerrarla se pierden: el chat sólo guarda mensajes, `cortex.remember` es de
-- UNA persona (preferencias, 240 caracteres) y la ficha de la empresa (0104) no
-- la escribe Cortex, a propósito. Un gerente que no retiene los acuerdos no es
-- un gerente.
--
-- LA PUERTA. Cortex PROPONE y una persona con permiso de aportar en el espacio
-- de destino ACEPTA. Aceptar escribe una nota en Brain Knowledge —con quién lo
-- dijo, cuándo y en qué conversación— y desde ahí la encuentra la búsqueda de
-- cada turno, con su cita y su fecha, como cualquier otro documento. No se
-- inyecta entera en el prompt como la ficha: se recupera cuando viene al caso,
-- y la detección de conflictos (kb_conflict_candidates) la compara con lo que
-- ya había.
--
-- POR QUÉ NO SE ESCRIBE DIRECTO. Lo que entra a un espacio común lo leen las
-- respuestas de todos. Un modelo que escribiera ahí solo convertiría una frase
-- mal entendida —o un correo con instrucciones incrustadas— en la verdad de la
-- empresa. La propuesta guarda la CITA literal de la persona para que quien
-- acepta vea de dónde salió, no la interpretación.
--
-- Tenencia: `organization_id` en cada fila, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS deny-all + service_role.

create table public.memory_proposals (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null,
  proposed_by         uuid not null,
  conversation_id     uuid,
  kind                text not null default 'other',
  subject             text,
  statement           text not null,
  quote               text not null,
  target_space_id     uuid references public.kb_collections (id) on delete set null,
  status              text not null default 'pending',
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  review_note         text,
  document_id         uuid references public.kb_documents (id) on delete set null,
  created_at          timestamptz not null default now(),

  constraint memory_proposals_kind check (
    kind in ('agreement', 'price', 'contact', 'decision', 'process', 'other')
  ),
  constraint memory_proposals_subject_len check (subject is null or char_length(subject) between 1 and 120),
  constraint memory_proposals_statement_len check (char_length(btrim(statement)) between 8 and 600),
  constraint memory_proposals_quote_len check (char_length(btrim(quote)) between 3 and 600),
  constraint memory_proposals_status check (status in ('pending', 'accepted', 'rejected')),
  -- Una decisión deja rastro completo; una pendiente no tiene ninguno.
  constraint memory_proposals_review_shape check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null and document_id is null)
    or (status = 'rejected' and reviewed_by is not null and reviewed_at is not null and document_id is null)
    or (status = 'accepted' and reviewed_by is not null and reviewed_at is not null)
  )
);

-- La misma frase no se propone dos veces mientras espera.
create unique index memory_proposals_pending_unique
  on public.memory_proposals (organization_id, lower(btrim(statement)))
  where status = 'pending';

create index memory_proposals_org_status_idx
  on public.memory_proposals (organization_id, status, created_at desc);

comment on table public.memory_proposals is
  'Hechos dichos en el chat que Cortex propone guardar en la memoria de la empresa. Una persona con permiso de aportar los acepta (se vuelven una nota en Brain Knowledge) o los descarta.';

alter table public.memory_proposals enable row level security;
revoke all on table public.memory_proposals from public, anon, authenticated;
grant select, insert, update, delete on table public.memory_proposals to service_role;
