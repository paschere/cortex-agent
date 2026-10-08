-- ===========================================================================
-- WHATSAPP: QUE CORTEX ESCRIBA EN UN GRUPO QUE LA EMPRESA HABILITÓ
-- ===========================================================================
-- Hasta hoy el número de la empresa NUNCA escribía primero: sólo contestaba a
-- menciones en grupos y a clientes que abrieron la conversación. Esto agrega un
-- permiso aparte y explícito, grupo por grupo: «Permitir mensajes de Cortex»
-- (`send_enabled`). Con él Cortex puede, por herramienta (whatsapp.group_send,
-- whatsapp.group_messages), mandar un mensaje a ESE grupo y leer lo que ahí
-- respondan — p. ej. preguntar por la guía a un grupo de despachos y capturar el
-- número de vuelo. NUNCA a contactos individuales.
--
-- RIESGO, dicho claro: el número está vinculado como dispositivo (Baileys), no
-- usa la API oficial de WhatsApp Business. WhatsApp puede bloquear números que
-- escriben de forma automática. Por eso los topes son estrictos (por grupo y
-- hora, por empresa y día; ver packages/agent-tools/src/whatsapp/group-send/
-- rules.ts), el texto sale con pausa y «escribiendo…», hay un apagado general y
-- uno por grupo, y cada envío queda registrado.
--
--   · whatsapp_groups.send_enabled  — el permiso por grupo (apagado por defecto).
--   · whatsapp_sessions.group_send_paused — el apagado general de la empresa.
--   · wa_group_outbox  — cola + registro de cada mensaje que Cortex manda a un
--                        grupo. Viaja en el latido del puente y el puente avisa
--                        si salió (mismo mecanismo que las respuestas a clientes).
--   · wa_group_inbox   — lo que se dice en los grupos habilitados, sólo para que
--                        Cortex lea las respuestas (whatsapp.group_messages).
--                        Se borra a los 7 días. Sólo grupos con send_enabled; es
--                        independiente del archivo de Brain Knowledge.
-- Tenencia como las demás tablas de WhatsApp: organization_id + tenant().

alter table public.whatsapp_groups
  add column if not exists send_enabled boolean not null default false;
alter table public.whatsapp_groups
  add column if not exists send_enabled_by uuid references public.users(id) on delete set null;
alter table public.whatsapp_groups
  add column if not exists send_enabled_at timestamptz;

alter table public.whatsapp_sessions
  add column if not exists group_send_paused boolean not null default false;

create table if not exists public.wa_group_outbox (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  group_jid        text not null check (group_jid like '%@g.us'),
  body             text not null check (char_length(btrim(body)) between 1 and 1000),
  status           text not null default 'pendiente'
                   check (status in ('pendiente', 'enviando', 'enviado', 'fallido', 'cancelado')),
  -- Quién lo pidió y por qué camino: el chat (con confirmación) o una automatización.
  requested_by     uuid references public.users(id) on delete set null,
  via              text not null default 'chat' check (via in ('chat', 'automation')),
  -- El id que WhatsApp le dio al mensaje: es lo que otros citan al responder.
  wa_message_id    text,
  error            text,
  claimed_at       timestamptz,
  sent_at          timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists wa_group_outbox_pending_idx
  on public.wa_group_outbox (organization_id, status, created_at)
  where status in ('pendiente', 'enviando');
-- Los topes cuentan lo enviado/encolado por grupo y por empresa en una ventana.
create index if not exists wa_group_outbox_caps_idx
  on public.wa_group_outbox (organization_id, group_jid, created_at);

create table if not exists public.wa_group_inbox (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  group_jid        text not null check (group_jid like '%@g.us'),
  message_id       text not null,
  from_me          boolean not null default false,
  sender_jid       text,
  sender_name      text,
  sent_at          timestamptz not null,
  body             text not null check (char_length(body) <= 4000),
  -- Si respondió citando otro mensaje: su id y su texto (recortado).
  quoted_message_id text,
  quoted_body      text,
  created_at       timestamptz not null default now()
);
create unique index if not exists wa_group_inbox_msg_idx
  on public.wa_group_inbox (organization_id, group_jid, message_id);
create index if not exists wa_group_inbox_read_idx
  on public.wa_group_inbox (organization_id, group_jid, sent_at desc);

comment on table public.wa_group_outbox is
  'Cola y registro de cada mensaje que Cortex manda a un grupo con send_enabled. Nunca a un contacto individual. Ver migración 0213.';
comment on table public.wa_group_inbox is
  'Mensajes de los grupos con send_enabled, para que Cortex lea las respuestas. Retención 7 días.';

alter table public.wa_group_outbox enable row level security;
alter table public.wa_group_inbox enable row level security;
revoke all on table public.wa_group_outbox from public, anon, authenticated;
revoke all on table public.wa_group_inbox from public, anon, authenticated;
grant select, insert, update, delete on table public.wa_group_outbox to service_role;
grant select, insert, update, delete on table public.wa_group_inbox to service_role;
