-- Per-user opt-ins for anything Cortex does on someone's behalf without being
-- asked in the moment — reading their mailbox, messaging them proactively.
--
-- Explicitly opt-in: nothing here defaults to on. Cortex reading a teammate's
-- inbox is exactly the kind of capability that must be granted deliberately,
-- from the UI, by the person themselves — never enabled for the workspace and
-- inherited silently.
create table if not exists public.user_preferences (
  user_id            uuid primary key references public.users(id) on delete cascade,
  -- Daily inbox digest: Cortex reads the person's recent mail server-side and
  -- sends back a prioritized summary. Off unless the person turns it on.
  inbox_digest_enabled boolean not null default false,
  inbox_digest_time    text not null default '07:30',      -- HH:MM, local to timezone
  timezone             text not null default 'America/Bogota',
  -- Delivery: email always available; Google Chat needs a webhook URL the
  -- person creates in their own space (no extra OAuth scope, no admin setup).
  deliver_email        boolean not null default true,
  deliver_chat         boolean not null default false,
  chat_webhook_url     text,
  -- Free-form guidance the person gives Cortex about what matters to them
  -- ("clients first, ignore newsletters") — folded into the digest prompt.
  digest_focus         text,
  updated_at           timestamptz not null default now(),
  created_at           timestamptz not null default now()
);

alter table public.user_preferences enable row level security;
-- Service-role only, like the rest of the schema.
