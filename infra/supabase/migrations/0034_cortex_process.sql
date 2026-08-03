-- cortex.* tool family: server-side LLM delegation (cortex.process) — heavy
-- content is processed by Cortex's own model and only the distilled result
-- returns to the calling model.
update public.agents
set allowed_tool_ids = array_append(allowed_tool_ids, 'cortex.*')
where slug = 'cortex'
  and not ('cortex.*' = any(allowed_tool_ids));
