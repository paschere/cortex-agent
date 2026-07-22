-- external_key: maps a conversation to an external channel's native session id
-- so non-web surfaces share the same memory ("same agent, same memory,
-- everywhere"). First user: the MCP endpoint keys conversations by Claude's
-- Mcp-Session-Id ("mcp:<session-id>"). Future channels reuse the same column
-- (WhatsApp thread id, Slack thread ts, inbound email Message-ID, ...).
alter table public.conversations
  add column if not exists external_key text;

create unique index if not exists conversations_user_external_key_idx
  on public.conversations(user_id, external_key)
  where external_key is not null;
