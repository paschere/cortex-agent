-- Direct Workable (ATS ground truth) tools: workable.* family for Cortex and
-- the recruiting agent. Auth is a workspace service token (WORKABLE_API_TOKEN),
-- same model as the HubSpot private app.
update public.agents
set allowed_tool_ids = array_append(allowed_tool_ids, 'workable.*')
where slug in ('cortex', 'recruiting')
  and not ('workable.*' = any(allowed_tool_ids));
