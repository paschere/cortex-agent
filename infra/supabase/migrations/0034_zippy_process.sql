-- zippy.* tool family: server-side LLM delegation (zippy.process) — heavy
-- content is processed by Zippy's own model and only the distilled result
-- returns to the calling model.
update public.agents
set allowed_tool_ids = array_append(allowed_tool_ids, 'zippy.*')
where slug = 'zippy'
  and not ('zippy.*' = any(allowed_tool_ids));
