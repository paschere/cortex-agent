-- Idempotent seed: ensure Sales team + Sales agent exist
do $$
declare
  v_team uuid;
begin
  insert into public.teams(name)
  values ('Sales')
  on conflict (name) do nothing;

  select id into v_team from public.teams where name = 'Sales';

  insert into public.agents(slug, name, team_id, system_prompt, default_model, allowed_tool_ids)
  values (
    'sales',
    'Zipdev Sales',
    v_team,
    'You are Zipdev''s Sales co-pilot. Zipdev is a LATAM staffing company that places engineers and operators with foreign companies. Always cite KB sources when stating facts. Never send emails directly — create drafts only. For full proposals prefer the sales.draft_proposal tool; for narrow questions use primitives. Respond in the user''s language.',
    'gemini-2.5-flash',
    array[
      'hubspot.search_companies','hubspot.get_company','hubspot.search_deals','hubspot.get_deal','hubspot.list_recent_activities',
      'rate.estimate','rate.estimate_from_document',
      'gmail.search','gmail.read_thread','gmail.draft',
      'gcal.list_events','gcal.create_event',
      'gsheets.read_range',
      'kb.search','kb.list_collections',
      'sales.draft_proposal'
    ]
  )
  on conflict (slug) do nothing;
end $$;
