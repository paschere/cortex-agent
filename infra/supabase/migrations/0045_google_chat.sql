-- Google Chat as a first-class Cortex surface.
--
-- The Chat app talks to one endpoint (/api/chat-app/google) and needs two
-- things persisted: which Chat user maps to which Zipdev user (so every tool
-- call still runs with a real person's credentials and lands in the audit
-- trail under their name), and where to send proactive messages — the DM
-- space Google creates the first time someone messages the app.
create table if not exists public.google_chat_links (
  -- Google's stable id for the person, e.g. "users/1234567890".
  chat_user_name text primary key,
  user_id        uuid not null references public.users(id) on delete cascade,
  email          text not null,
  display_name   text,
  -- "spaces/AAAA…" for the 1:1 DM with the app. Proactive messages (digests,
  -- meeting briefings, approval requests) are posted here.
  dm_space       text,
  last_seen_at   timestamptz not null default now(),
  created_at     timestamptz not null default now()
);
create index if not exists google_chat_links_user_idx on public.google_chat_links(user_id);

alter table public.google_chat_links enable row level security;

-- Chat threads map onto the same conversations table every other surface uses,
-- so history is shared: ask Cortex something in Chat, see it in Zipdev OS.
-- The existing conversations.external_key carries "gchat:<space>/<thread>".

-- Delivery preference: people who linked Chat can receive digests there.
alter table public.user_preferences
  add column if not exists deliver_chat_dm boolean not null default false;
