/**
 * Why each gated tool is gated — shared by the MCP confirmation flow and the
 * web chat's ConfirmationPrompt so both surfaces explain stakes the same way.
 * Pure data: safe to import from client components.
 */
export const CONFIRMATION_NOTES: Record<string, string> = {
  'gmail.send_draft':
    'Sends a real email from your Gmail to its recipients. Once sent it cannot be unsent, and it represents you (and Zipdev) to whoever receives it.',
  'gmail.draft': 'Creates a draft in your Gmail. Nothing is sent, but it appears in your mailbox.',
  'gcal.create_event':
    'Creates a calendar event and emails invitations to every attendee listed — external people will see it immediately.',
  'slack.post_message':
    'Posts a message in Slack visible to everyone in the channel the moment it lands.',
  'hubspot.create_contact':
    'Creates a permanent CRM record the whole sales team will see and rely on.',
  'hubspot.create_deal':
    'Creates a deal in the sales pipeline — it will appear in forecasts and reports.',
  'hubspot.update_deal':
    'Modifies live deal data (stage, amount, fields) that the team and forecasts depend on. Previous values are overwritten.',
  'hubspot.log_activity':
    'Writes an activity note into the CRM timeline, visible to the whole team.',
  'workable.move_candidate':
    "Changes the candidate's stage in the ATS — the hiring team sees it, and stage history drives recruiting metrics.",
  'workable.create_comment':
    "Adds a permanent note to the candidate's profile, visible to the whole hiring team.",
  'github.create_issue':
    'Creates a public-to-the-team issue in the repository, notifying watchers.',
  'github.create_issue_comment': 'Posts a comment visible to everyone following the issue.',
  'linear.create_issue': 'Creates a tracked issue the engineering team will triage and act on.',
  'linear.create_comment': 'Posts a comment visible to everyone on the issue.',
  'gsheets.append_row': 'Appends a row to a shared spreadsheet others may use for reporting.',
  'schedule.create':
    'Creates an UNATTENDED job that will run on its own schedule without further supervision. It keeps running until paused.',
  'pipeline.create':
    'Saves a reusable playbook that anyone on the team can run from any surface — errors in its design get repeated on every run.',
  'pipeline.update':
    'Changes a shared playbook for everyone who uses it, effective on the next run.',
  'apollo.enrich_people':
    "Pulls up to ten people's verified work emails out of Apollo in one go, and spends one Apollo credit for every person found. Looking people up costs the company real money, so a batch is always somebody's decision.",
  'bamboo.compensation_report':
    "Pulls pay rates AND bill rates for a whole group of people out of BambooHR in one go — potentially the entire roster. Compensation is the most sensitive data Zipdev holds, and this is the bulk export of it: it belongs to whoever approved it, not to the room it gets pasted into. For one person, the employee lookup answers the same question without exporting anybody else's.",
  'recruit.generate_presentation':
    'Generates a client-facing candidate presentation document that may be shared externally.',
};

const FAMILY_SYSTEM: Record<string, string> = {
  gmail: 'your Gmail account',
  gcal: 'your Google Calendar',
  gsheets: 'a shared Google Sheet',
  hubspot: 'the HubSpot CRM',
  workable: 'the Workable ATS',
  github: 'GitHub',
  linear: 'Linear',
  slack: 'Slack',
  schedule: 'the unattended job scheduler',
  pipeline: 'the shared pipeline library',
  recruit: 'the recruiting system',
  apollo: 'the Apollo prospecting database',
  bamboo: 'BambooHR, the HR system of record',
  kb: 'the shared Knowledge Base',
};

export function confirmationReason(toolId: string): string {
  const note = CONFIRMATION_NOTES[toolId];
  if (note) return note;
  const family = toolId.split('.')[0] ?? '';
  const system = FAMILY_SYSTEM[family] ?? 'an external system';
  return `Executes a write against ${system} — it changes real data outside this conversation and may be visible to other people.`;
}
