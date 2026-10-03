-- 0190 — Ayuda y soporte.
--
-- La ayuda en sí (los artículos) NO vive en la base: es Markdown versionado en
-- apps/web/content/ayuda y viaja con el código. Aquí sólo queda lo que escriben
-- las personas:
--
--   support_tickets          «Escribir a soporte»: asunto, estado y el contexto
--                            que la app adjunta sola (pantalla, navegador,
--                            empresa, errores recientes) para no tener que
--                            preguntarlo. Por empresa.
--   support_ticket_messages  El hilo: lo que escribió la persona y lo que le
--                            contestó soporte. Por empresa (la del ticket).
--   help_feedback            «¿Te sirvió?» de cada artículo: un voto por
--                            persona y artículo, que puede cambiar.
--
-- Quien opera la plataforma lee los tickets de todas las empresas desde
-- /overview/soporte, con una puerta propia (apps/web/lib/support/operator.ts);
-- todo lo demás pasa por el cliente con la empresa clavada.
--
-- Idempotente: `if not exists` en todo.

-- ---------------------------------------------------------------------------
-- 1. Tickets
-- ---------------------------------------------------------------------------
create table if not exists public.support_tickets (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  -- El número que se le dice a la persona («tu caso #42»). Global y creciente:
  -- con soporte se habla de un número, no de un uuid.
  number           bigint      generated always as identity,
  created_by       uuid        references public.users(id) on delete set null,
  -- Copia del correo al crear: si la persona se va del directorio, soporte
  -- sigue sabiendo a quién contestarle.
  created_by_email text        check (created_by_email is null or length(created_by_email) <= 320),
  subject          text        not null check (length(btrim(subject)) between 3 and 160),
  status           text        not null default 'abierto'
                               check (status in ('abierto', 'en_curso', 'esperando_cliente',
                                                 'resuelto', 'cerrado')),
  -- La pantalla desde la que se escribió y el navegador. Los pone la app.
  route            text        check (route is null or length(route) <= 300),
  user_agent       text        check (user_agent is null or length(user_agent) <= 500),
  -- Lo demás que la app adjunta: nombre de la empresa, tamaño de pantalla,
  -- idioma, errores recientes del navegador. Nunca documentos ni conversaciones.
  context          jsonb       not null default '{}'::jsonb,
  -- Pantallazo opcional, guardado en app_files (bucket 'support').
  screenshot_path  text        check (screenshot_path is null or length(screenshot_path) <= 400),
  screenshot_type  text        check (screenshot_type is null or screenshot_type in
                                      ('image/png', 'image/jpeg', 'image/webp')),
  -- El aviso por correo a SUPPORT_EMAIL. Un fallo no pierde el ticket.
  email_sent_at    timestamptz,
  email_error      text        check (email_error is null or length(email_error) <= 300),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz
);

create unique index if not exists support_tickets_number_idx
  on public.support_tickets (number);
create index if not exists support_tickets_org_created_idx
  on public.support_tickets (organization_id, created_at desc);
create index if not exists support_tickets_open_idx
  on public.support_tickets (status, created_at desc)
  where status in ('abierto', 'en_curso', 'esperando_cliente');

comment on table public.support_tickets is
  'Mensajes a soporte («Escribir a soporte» en /ayuda/soporte). El contexto (pantalla, navegador, empresa, errores recientes) lo adjunta la app; el pantallazo vive en app_files bucket support. Se avisa por correo a SUPPORT_EMAIL.';

-- ---------------------------------------------------------------------------
-- 2. El hilo de cada ticket
-- ---------------------------------------------------------------------------
create table if not exists public.support_ticket_messages (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  ticket_id        uuid        not null references public.support_tickets(id) on delete cascade,
  author_kind      text        not null check (author_kind in ('cliente', 'soporte')),
  author_user_id   uuid        references public.users(id) on delete set null,
  author_email     text        check (author_email is null or length(author_email) <= 320),
  body             text        not null check (length(btrim(body)) between 1 and 8000),
  created_at       timestamptz not null default now()
);

create index if not exists support_ticket_messages_ticket_idx
  on public.support_ticket_messages (ticket_id, created_at);
create index if not exists support_ticket_messages_org_idx
  on public.support_ticket_messages (organization_id, created_at desc);

comment on table public.support_ticket_messages is
  'Lo que escribió la persona (cliente) y lo que contestó quien opera la plataforma (soporte), en orden.';

-- ---------------------------------------------------------------------------
-- 3. «¿Te sirvió?»
-- ---------------------------------------------------------------------------
create table if not exists public.help_feedback (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  user_id          uuid        not null references public.users(id) on delete cascade,
  -- El nombre del archivo del artículo (apps/web/content/ayuda/<slug>.md).
  article_slug     text        not null check (article_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                                               and length(article_slug) <= 120),
  helpful          boolean     not null,
  comment          text        check (comment is null or length(comment) <= 1000),
  route            text        check (route is null or length(route) <= 300),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, user_id, article_slug)
);

create index if not exists help_feedback_slug_idx
  on public.help_feedback (article_slug, helpful);

comment on table public.help_feedback is
  'Voto «¿Te sirvió?» por persona y artículo de ayuda; cambiar de opinión actualiza la fila.';

-- ---------------------------------------------------------------------------
-- 4. Acceso
-- ---------------------------------------------------------------------------
alter table public.support_tickets         enable row level security;
alter table public.support_ticket_messages enable row level security;
alter table public.help_feedback           enable row level security;

revoke all on table public.support_tickets         from public, anon, authenticated;
revoke all on table public.support_ticket_messages from public, anon, authenticated;
revoke all on table public.help_feedback           from public, anon, authenticated;

grant select, insert, update, delete on table public.support_tickets         to service_role;
grant select, insert, update, delete on table public.support_ticket_messages to service_role;
grant select, insert, update, delete on table public.help_feedback           to service_role;
