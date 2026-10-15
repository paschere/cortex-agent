-- 0226 · REPETICIÓN COMPARTIDA, GALERÍA DE TAREAS Y TAREAS POR CORREO / WHATSAPP.
--
-- 1. task_shares / task_share_shots: un enlace público de SOLO LECTURA a la
--    repetición de una tarea (plan, pasos con frases, capturas y respuesta
--    final). Lo que se ve es una FOTO ya depurada tomada al compartir (nunca se
--    lee la conversación en vivo), y de la clave sólo se guarda su hash.
--    Las capturas del servicio de navegador caducan a las 6 h: se copian aquí.
-- 2. task_templates: plantillas de tarea de la empresa (texto, sin código).
-- 3. task_intake_prefs / task_intake_log: quién aceptó pedir tareas por correo
--    o WhatsApp, y el registro que vuelve idempotente cada mensaje.

create table if not exists public.task_shares (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  task_id          uuid not null references public.background_tasks(id) on delete cascade,
  created_by       uuid not null references public.users(id) on delete cascade,
  -- sha256 (hex) del token; el token en claro sólo existe en el enlace.
  token_hash       text not null unique check (length(token_hash) = 64),
  hide_personal    boolean not null default true,
  include_shots    boolean not null default true,
  -- La foto depurada: { title, request, status, plan, steps[], answer, ... }.
  snapshot         jsonb not null check (jsonb_typeof(snapshot) = 'object' and pg_column_size(snapshot) <= 400000),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  revoked_by       uuid references public.users(id) on delete set null,
  view_count       integer not null default 0 check (view_count >= 0),
  last_viewed_at   timestamptz,
  created_at       timestamptz not null default now()
);
comment on table public.task_shares is
  'Enlaces públicos de solo lectura a la repetición de una tarea (0226). Foto depurada; token solo por hash.';
create index if not exists task_shares_task_idx on public.task_shares (task_id, created_at desc);
create index if not exists task_shares_org_idx on public.task_shares (organization_id, created_at desc);

create table if not exists public.task_share_shots (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  share_id         uuid not null references public.task_shares(id) on delete cascade,
  shot_key         text not null check (shot_key ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- JPEG chico en base64 (tope por foto en el código: 150 KB).
  data_b64         text not null check (length(data_b64) <= 220000),
  created_at       timestamptz not null default now(),
  unique (share_id, shot_key)
);

create table if not exists public.task_templates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  created_by       uuid references public.users(id) on delete set null,
  title            text not null check (length(btrim(title)) between 3 and 90),
  summary          text not null check (length(btrim(summary)) between 5 and 280),
  prompt           text not null check (length(btrim(prompt)) between 10 and 6000),
  needs            text[] not null default '{}',
  minutes          integer not null default 10 check (minutes between 1 and 120),
  archived_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists task_templates_org_idx
  on public.task_templates (organization_id, created_at desc) where archived_at is null;

create table if not exists public.task_intake_prefs (
  user_id            uuid primary key references public.users(id) on delete cascade,
  organization_id    text not null references public.ba_organization(id) on delete cascade,
  email_enabled      boolean not null default false,
  email_enabled_at   timestamptz,
  whatsapp_enabled   boolean not null default false,
  -- Palabra extra además de «Cortex» (p. ej. «tarea»). Una sola palabra.
  whatsapp_keyword   text check (whatsapp_keyword is null or whatsapp_keyword ~ '^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,20}$'),
  updated_at         timestamptz not null default now()
);

create table if not exists public.task_intake_log (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  source           text not null check (source in ('email', 'whatsapp')),
  -- id del mensaje de Gmail / de WhatsApp: una entrega repetida no crea otra tarea.
  external_id      text not null check (length(external_id) between 1 and 300),
  task_id          uuid references public.background_tasks(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (organization_id, source, external_id)
);
create index if not exists task_intake_log_user_idx
  on public.task_intake_log (user_id, source, created_at desc);

alter table public.task_shares enable row level security;
alter table public.task_share_shots enable row level security;
alter table public.task_templates enable row level security;
alter table public.task_intake_prefs enable row level security;
alter table public.task_intake_log enable row level security;
do $$
declare t text;
begin
  foreach t in array array['task_shares','task_share_shots','task_templates','task_intake_prefs','task_intake_log'] loop
    execute format('drop policy if exists %I on public.%I', t || '_service_only', t);
    execute format('create policy %I on public.%I for all to service_role using (true) with check (true)', t || '_service_only', t);
  end loop;
end $$;
