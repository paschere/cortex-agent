-- Idempotent update: ensure the Sales agent has the full v1 tool list.
update public.agents
set allowed_tool_ids = array[
  'hubspot.search_companies','hubspot.get_company','hubspot.search_deals','hubspot.get_deal','hubspot.list_recent_activities',
  'rate.estimate','rate.estimate_from_document',
  'gmail.search','gmail.read_thread','gmail.draft',
  'gcal.list_events','gcal.create_event',
  'gsheets.read_range','gsheets.append_row',
  'kb.search','kb.list_collections',
  'sales.draft_proposal'
]
where slug = 'sales';
