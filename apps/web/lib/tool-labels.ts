export const TOOL_LABELS: Record<string, { label: string; icon: string }> = {
  qualify_lead: { label: 'Qualify Lead', icon: 'UserCheck' },
  hubspot_search_companies: { label: 'Search HubSpot Companies', icon: 'Building2' },
  hubspot_get_company: { label: 'Get Company Details', icon: 'Building2' },
  hubspot_search_deals: { label: 'Search Deals', icon: 'Briefcase' },
  hubspot_get_deal: { label: 'Get Deal Details', icon: 'Briefcase' },
  hubspot_search_contacts: { label: 'Search Contacts', icon: 'Users' },
  hubspot_get_contact: { label: 'Get Contact Details', icon: 'User' },
  hubspot_create_deal: { label: 'Create Deal', icon: 'PlusCircle' },
  hubspot_update_deal: { label: 'Update Deal', icon: 'Edit' },
  hubspot_create_contact: { label: 'Create Contact', icon: 'UserPlus' },
  hubspot_log_activity: { label: 'Log Activity', icon: 'ClipboardList' },
  hubspot_get_pipeline_summary: { label: 'Get Pipeline Summary', icon: 'BarChart2' },
  hubspot_list_recent_activities: { label: 'List Recent Activities', icon: 'Activity' },
  gmail_search: { label: 'Search Gmail', icon: 'Mail' },
  gmail_read_thread: { label: 'Read Email Thread', icon: 'MailOpen' },
  gmail_draft: { label: 'Draft Email', icon: 'Pencil' },
  gmail_send_draft: { label: 'Send Email Draft', icon: 'Send' },
  gmail_list_threads: { label: 'List Email Threads', icon: 'Inbox' },
  gcal_list_events: { label: 'List Calendar Events', icon: 'Calendar' },
  gcal_create_event: { label: 'Create Calendar Event', icon: 'CalendarPlus' },
  gsheets_read_range: { label: 'Read Spreadsheet', icon: 'Table' },
  gsheets_append_row: { label: 'Append Row to Sheet', icon: 'TableProperties' },
  kb_search: { label: 'Search Brain Knowledge', icon: 'BookOpen' },
  rate_estimate: { label: 'Estimate Rate', icon: 'DollarSign' },
  sales_draft_proposal: { label: 'Draft Proposal', icon: 'FileText' },
  web_search: { label: 'Web Search', icon: 'Globe' },
  web_scrape: { label: 'Fetch Web Page', icon: 'Link' },
  gdrive_search_files: { label: 'Search Drive Files', icon: 'FolderSearch' },
  gdrive_read_doc: { label: 'Read Drive Document', icon: 'FileSearch' },
  schedule_create: { label: 'Create Scheduled Job', icon: 'AlarmClockPlus' },
  schedule_list: { label: 'List Scheduled Jobs', icon: 'AlarmClock' },
  schedule_update: { label: 'Update Scheduled Job', icon: 'AlarmClockCheck' },
  // Vehicles. The two lookups name the registry they hit rather than the tool,
  // because that is what the person waiting recognises — and a RUNT check runs
  // for the better part of half a minute, so it is on screen a while.
  vehicles_register: { label: 'Register Vehicle', icon: 'Car' },
  vehicles_list: { label: 'List Vehicles', icon: 'Car' },
  vehicles_get: { label: 'Get Vehicle', icon: 'Car' },
  vehicles_check_runt: { label: 'Check RUNT (SOAT and inspection)', icon: 'ShieldCheck' },
  vehicles_check_simit: { label: 'Check SIMIT (traffic fines)', icon: 'ReceiptText' },
  vehicles_recently_changed: { label: 'Check Fleet Changes', icon: 'RefreshCw' },
};

function toTitleCase(s: string): string {
  return s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Maps a raw tool id to a human label and Lucide icon name.
 * Tool ids may arrive in dotted (`hubspot.search_deals`) or underscored
 * (`hubspot_search_deals`) form; both normalize to the same lookup key.
 */
export function toolLabel(toolId: string): { label: string; icon: string } {
  const key = toolId.replace(/\./g, '_');
  return TOOL_LABELS[key] ?? { label: toTitleCase(toolId), icon: 'Wrench' };
}

/**
 * `Family · Action` rendering of a tool id, for surfaces that have no curated
 * label to fall back on (approval emails, Chat DMs, archived transcripts).
 *
 * Ids reach us in two shapes: dotted as declared (`hubspot.update_deal`) and
 * underscored as the AI SDK / MCP persist them (`hubspot_update_deal`). Both
 * normalize to the same output.
 */
export function humanizeToolId(toolId: string): string {
  const [family = '', ...rest] = toolId.replace(/\./g, '_').split('_');
  const cap = (w: string) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w);
  const action = rest.map(cap).join(' ');
  return action ? `${cap(family)} · ${action}` : cap(family);
}

/**
 * The name a human should see for a tool. Curated label when we have one,
 * otherwise the `Family · Action` form — never the raw id.
 */
export function toolDisplayName(toolId: string): string {
  const key = toolId.replace(/\./g, '_');
  return TOOL_LABELS[key]?.label ?? humanizeToolId(toolId);
}

/**
 * Produces a plain-English summary of a confirmation-gated tool action so the
 * user can understand what will happen without reading raw JSON.
 */
export function confirmationSummary(toolId: string, input: Record<string, unknown>): string {
  const key = toolId.replace(/\./g, '_');
  switch (key) {
    case 'hubspot_update_deal':
      return `Update deal${input.dealstage ? ` stage to "${input.dealstage}"` : ''}${input.amount ? ` · amount $${input.amount}` : ''}`;
    case 'hubspot_create_deal':
      return `Create deal "${input.dealname}" in stage "${input.dealstage}"`;
    case 'hubspot_create_contact':
      return `Create contact ${[input.firstName, input.lastName].filter(Boolean).join(' ')} <${input.email}>`;
    case 'hubspot_log_activity':
      return `Log ${input.type} "${input.subject}" on ${input.associatedObjectType} ${input.associatedObjectId}`;
    case 'gmail_send_draft':
      return `Send Gmail draft ${input.draftId}`;
    case 'gcal_create_event':
      return `Create calendar event "${input.summary}" on ${input.start}`;
    case 'gsheets_append_row':
      return `Append row to sheet "${input.spreadsheetId}"`;
    case 'schedule_create': {
      const when =
        input.scheduleKind === 'once' ? `once at ${input.runAt}` : `on cron "${input.cron}" (${input.timezone ?? 'UTC'})`;
      const writes = input.allowUnattendedWrites ? ' · unattended writes ALLOWED' : '';
      return `Schedule "${input.name}" — runs ${when}${writes}`;
    }
    default:
      return `Run: ${toolLabel(toolId).label}`;
  }
}
