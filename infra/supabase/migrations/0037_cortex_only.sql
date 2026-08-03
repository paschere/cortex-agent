-- One agent: Cortex.
--
-- The sales/recruiting/cortex split was an implementation detail that leaked
-- into the product (an agent picker in chat, a directory page). Cortex already
-- carries every tool family, so the others are archived rather than deleted:
-- historical conversations keep a valid agent_id (conversations.agent_id is
-- ON DELETE RESTRICT) and the audit trail stays intact.
--
-- Everything that lists agents (chat picker, /agents, the MCP tool catalog)
-- must filter on archived = false.
alter table public.agents
  add column if not exists archived boolean not null default false;

update public.agents set archived = true where slug <> 'cortex';
update public.agents set archived = false where slug = 'cortex';
