-- The conversational model moves from Opus 5 to Sonnet 5.
--
-- Same 1M context, same adaptive thinking with visible reasoning, roughly half
-- the cost. On a product whose shape is many tool calls per turn, that ratio is
-- the whole bill. See packages/agent-tools/src/model.ts.
--
-- WHY THIS MIGRATION EXISTS AT ALL. `resolveModelId` honours the id stored on
-- the agent row and only falls back to CHAT_MODEL when there is none. So the
-- constant in model.ts does not govern any workspace that already has an agent
-- — every existing row still names Opus, and changing the code alone would have
-- looked like it worked while every real conversation kept billing at the old
-- rate. The row is the source of truth; this is where the switch actually
-- happens.
--
-- Scoped to rows that name Opus. A workspace that deliberately picked something
-- else keeps its choice: the point is to move the default, not to overrule an
-- operator who went into /agents and chose.

update public.agents
   set default_model = 'claude-sonnet-5'
 where default_model = 'claude-opus-5';

-- Migration 0064 gave every workspace its own copy of the agents, cloned from a
-- template workspace. The update above reaches all of them (it filters on the
-- model, not on the workspace) — including the template, so a workspace created
-- after this migration is born on Sonnet rather than inheriting Opus.

alter table public.agents
  alter column default_model set default 'claude-sonnet-5';
