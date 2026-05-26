create type chat_surface as enum ('web', 'desktop', 'mcp');
create type message_role as enum ('user', 'assistant', 'system', 'tool');

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete restrict,
  surface chat_surface not null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_user_idx on public.conversations(user_id, created_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role message_role not null,
  content text not null default '',
  tool_calls jsonb,
  tool_results jsonb,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages(conversation_id, created_at);
