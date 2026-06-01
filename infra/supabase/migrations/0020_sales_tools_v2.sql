-- Enable the full v2 tool surface for the Sales agent: HubSpot reads + writes,
-- Gmail send, Drive, and web research. This is what lets the agent actually
-- send emails, research prospects, and chain multi-step workflows end to end.
update public.agents
set allowed_tool_ids = array[
  -- HubSpot (read)
  'hubspot.search_companies','hubspot.get_company','hubspot.search_deals','hubspot.get_deal',
  'hubspot.list_recent_activities','hubspot.search_contacts','hubspot.get_contact',
  'hubspot.get_pipeline_summary','hubspot.get_contact_timeline',
  -- HubSpot (write — confirmation-gated)
  'hubspot.create_deal','hubspot.update_deal','hubspot.create_contact','hubspot.log_activity',
  -- Rate calculator
  'rate.estimate','rate.estimate_from_document',
  -- Gmail
  'gmail.search','gmail.read_thread','gmail.draft','gmail.send_draft','gmail.list_threads',
  -- Calendar + Sheets
  'gcal.list_events','gcal.create_event','gsheets.read_range','gsheets.append_row',
  -- Google Drive
  'gdrive.search_files','gdrive.read_doc',
  -- Web research
  'web.search','web.scrape',
  -- Knowledge base + composite
  'kb.search','kb.list_collections','sales.draft_proposal'
]
where slug = 'sales';
