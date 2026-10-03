-- ===========================================================================
-- ATENCIÓN A CLIENTES POR WHATSAPP
-- ===========================================================================
-- Hasta aquí el número de la empresa sólo le contestaba al EQUIPO (números
-- vinculados en `whatsapp_links`, 0068) y a quien lo mencionaba en un grupo
-- (0072). Un cliente que escribía recibía «este número solo responde a
-- personas registradas». Con esto, si la empresa lo enciende, ese cliente
-- recibe respuesta: estado de su pedido o guía, sus facturas y su saldo, los
-- datos públicos de la empresa y las preguntas frecuentes que la empresa
-- aprobó. Todo lo demás — o lo que el bot no sabe con seguridad — pasa a una
-- persona.
--
-- LAS REGLAS QUE ESTAS TABLAS SOSTIENEN
--   * Sólo se responde a quien escribió primero. El bot nunca abre una
--     conversación; una persona del equipo sólo puede contestar DENTRO de una
--     conversación abierta en la que el cliente escribió en las últimas 24 h
--     (la misma ventana que usa WhatsApp Business para «atención»).
--   * Nunca se le muestra a un cliente lo de otro. La conversación sabe a qué
--     cliente pertenece (`client_id`) y CÓMO se supo (`verification`): por el
--     teléfono de un contacto del cliente, o porque escribió su NIT y el número
--     de una de SUS facturas. Sin eso, no sale ni un peso.
--   * Lista cerrada de lo que se puede decir (`share_*`), apagado por defecto
--     el servicio entero (`enabled = false`).
--   * Higiene contra bloqueos: techo de respuestas por hora y conversación,
--     palabras de baja respetadas (`opted_out`), nada masivo ni saliente.
--
-- Tenencia: `organization_id` en cada fila; `tenant()` en tenancy/tables.ts.
-- Sólo `service_role`: la app lee con un handle con alcance de espacio.

-- ---------------------------------------------------------------------------
-- 1. La configuración, una fila por empresa
-- ---------------------------------------------------------------------------
create table if not exists public.wa_customer_settings (
  organization_id       text        primary key references public.ba_organization(id) on delete cascade,
  enabled               boolean     not null default false,
  -- Zona y horario de atención. `business_hours` es {"1":[["08:00","18:00"]], …}
  -- con la llave = día ISO (1 lunes … 7 domingo). Vacío = siempre.
  time_zone             text        not null default 'America/Bogota' check (length(time_zone) <= 60),
  business_hours        jsonb       not null default '{}'::jsonb
                                    check (jsonb_typeof(business_hours) = 'object' and pg_column_size(business_hours) <= 4000),
  -- Fuera de horario, ¿el bot igual responde lo que sale de los datos?
  bot_after_hours       boolean     not null default true,
  greeting              text        check (greeting is null or length(greeting) <= 600),
  after_hours_message   text        check (after_hours_message is null or length(after_hours_message) <= 600),
  -- Lo que se puede compartir. Lista cerrada: lo que no está aquí, no sale.
  share_order_status    boolean     not null default true,
  share_invoices        boolean     not null default true,
  share_balance         boolean     not null default true,
  share_company_info    boolean     not null default true,
  -- Datos públicos de la empresa (dirección, horarios, canales), como los
  -- escribió la empresa. Se copian tal cual; el bot no los redacta.
  company_info          text        check (company_info is null or length(company_info) <= 2000),
  -- Preguntas frecuentes APROBADAS: [{"q": "...", "a": "...", "keywords": ["..."]}].
  faq                   jsonb       not null default '[]'::jsonb
                                    check (jsonb_typeof(faq) = 'array' and pg_column_size(faq) <= 40000),
  -- De qué tablas sale el estado de un pedido o guía:
  -- [{"trackerId": uuid, "label": "Guías", "numberField": "guia",
  --   "statusField": "estado", "etaField": "entrega"?, "clientField": "cliente"?}]
  order_sources         jsonb       not null default '[]'::jsonb
                                    check (jsonb_typeof(order_sources) = 'array' and pg_column_size(order_sources) <= 8000),
  -- A quién se le pasa: una persona y, si se quiere, el nombre de un equipo.
  escalation_user_id    uuid        references public.users(id) on delete set null,
  escalation_team       text        check (escalation_team is null or length(escalation_team) <= 80),
  max_replies_per_hour  integer     not null default 12 check (max_replies_per_hour between 1 and 60),
  updated_by            uuid        references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.wa_customer_settings is
  'Atención a clientes por WhatsApp (0185): encendido (apagado por defecto), horario, saludo, qué se puede compartir, preguntas frecuentes aprobadas, de qué tablas sale el estado de un pedido, a quién se escala y el techo de respuestas por hora. Ver packages/agent-tools/src/whatsapp/customer.';

-- ---------------------------------------------------------------------------
-- 2. Las conversaciones
-- ---------------------------------------------------------------------------
create table if not exists public.wa_customer_conversations (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    text        not null references public.ba_organization(id) on delete cascade,
  -- E.164 sin «+», como lo guarda `whatsapp_links`.
  phone              text        not null check (phone ~ '^\d{8,15}$'),
  jid                text        not null check (length(jid) <= 120),
  push_name          text        check (push_name is null or length(push_name) <= 120),
  client_id          uuid        references public.clients(id) on delete set null,
  contact_id         uuid        references public.client_contacts(id) on delete set null,
  status             text        not null default 'abierta'
                                 check (status in ('abierta', 'escalada', 'cerrada')),
  assigned_to        uuid        references public.users(id) on delete set null,
  -- Cómo se sabe quién es:
  --   ninguna     no se sabe; no se comparte nada de ningún cliente.
  --   telefono    el número es el de un contacto de UN cliente.
  --   pendiente   se le pidió NIT + número de factura y se espera.
  --   verificado  dio un NIT y una factura que son del mismo cliente.
  --   bloqueada   falló demasiadas veces; sólo una persona sigue.
  verification       text        not null default 'ninguna'
                                 check (verification in ('ninguna', 'telefono', 'pendiente', 'verificado', 'bloqueada')),
  verified_until     timestamptz,
  verify_attempts    integer     not null default 0 check (verify_attempts between 0 and 20),
  -- Qué se le preguntó y quedó esperando respuesta (p. ej. 'saldo' tras pedir NIT).
  pending_intent     text        check (pending_intent is null or length(pending_intent) <= 40),
  opted_out          boolean     not null default false,
  opted_out_at       timestamptz,
  last_message_at    timestamptz not null default now(),
  last_inbound_at    timestamptz,
  escalated_at       timestamptz,
  escalation_reason  text        check (escalation_reason is null or length(escalation_reason) <= 300),
  closed_at          timestamptz,
  closed_by          uuid        references public.users(id) on delete set null,
  work_item_id       uuid        references public.work_items(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint wa_customer_conversations_client_needs_proof
    check (client_id is null or verification in ('telefono', 'verificado', 'bloqueada'))
);

-- Una sola conversación viva por número: la cerrada queda de historia y el
-- próximo mensaje abre otra.
create unique index if not exists wa_customer_conversations_live_idx
  on public.wa_customer_conversations (organization_id, phone)
  where status <> 'cerrada';

create index if not exists wa_customer_conversations_org_status_idx
  on public.wa_customer_conversations (organization_id, status, last_message_at desc);

create index if not exists wa_customer_conversations_client_idx
  on public.wa_customer_conversations (organization_id, client_id, last_message_at desc)
  where client_id is not null;

comment on table public.wa_customer_conversations is
  'Una conversación de atención con alguien de fuera que le escribió al número de la empresa. Sabe de qué cliente es y cómo se supo (verification); nada de un cliente sale sin eso. Ver packages/agent-tools/src/whatsapp/customer.';

-- ---------------------------------------------------------------------------
-- 3. Los mensajes
-- ---------------------------------------------------------------------------
create table if not exists public.wa_customer_messages (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  conversation_id  uuid        not null references public.wa_customer_conversations(id) on delete cascade,
  direction        text        not null check (direction in ('in', 'out')),
  body             text        not null check (length(body) between 1 and 4000),
  intent           text        check (intent is null or length(intent) <= 40),
  -- Quién contestó (sólo salientes): el bot o una persona del equipo.
  answered_by      text        check (answered_by is null or answered_by in ('bot', 'persona')),
  author_id        uuid        references public.users(id) on delete set null,
  -- De dónde salió cada cifra: [{"kind": "invoice", "id": "...", "label": "FV-12"}].
  sources          jsonb       not null default '[]'::jsonb
                               check (jsonb_typeof(sources) = 'array' and pg_column_size(sources) <= 8000),
  -- Id del mensaje en WhatsApp (entrantes): una entrega repetida no se cuenta dos veces.
  wa_message_id    text        check (wa_message_id is null or length(wa_message_id) <= 200),
  -- Sólo las respuestas de una persona viajan por la cola del puente:
  --   pendiente → enviando (el puente la tomó) → enviado | fallido.
  delivery         text        check (delivery is null or delivery in ('pendiente', 'enviando', 'enviado', 'fallido')),
  claimed_at       timestamptz,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  constraint wa_customer_messages_out_has_author
    check (direction = 'in' or answered_by is not null),
  constraint wa_customer_messages_person_queued
    check (answered_by is distinct from 'persona' or delivery is not null)
);

create unique index if not exists wa_customer_messages_wa_id_idx
  on public.wa_customer_messages (conversation_id, wa_message_id)
  where wa_message_id is not null;

create index if not exists wa_customer_messages_conversation_idx
  on public.wa_customer_messages (conversation_id, created_at);

create index if not exists wa_customer_messages_outbox_idx
  on public.wa_customer_messages (organization_id, delivery, created_at)
  where delivery in ('pendiente', 'enviando');

comment on table public.wa_customer_messages is
  'Lo que dijo el cliente y lo que se le contestó, con la intención detectada, quién contestó (bot o persona) y de dónde salió cada dato (sources). Las respuestas de una persona esperan en delivery=pendiente hasta que el puente las entrega como respuesta en esa conversación.';

-- ---------------------------------------------------------------------------
-- 4. Acceso
-- ---------------------------------------------------------------------------
alter table public.wa_customer_settings      enable row level security;
alter table public.wa_customer_conversations enable row level security;
alter table public.wa_customer_messages      enable row level security;

revoke all on table public.wa_customer_settings      from public, anon, authenticated;
revoke all on table public.wa_customer_conversations from public, anon, authenticated;
revoke all on table public.wa_customer_messages      from public, anon, authenticated;

grant select, insert, update, delete on table public.wa_customer_settings      to service_role;
grant select, insert, update, delete on table public.wa_customer_conversations to service_role;
grant select, insert, update, delete on table public.wa_customer_messages      to service_role;
