import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const ActivityOut = z.object({
  id: z.string(),
  type: z.enum(['call', 'note', 'meeting', 'task', 'email']),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  createdAt: z.string().nullable(),
});

const Output = z.object({
  results: z.array(ActivityOut),
  markdown: z.string(),
});

type ActivityKind = z.infer<typeof ActivityOut>['type'];

// Each engagement object exposes its title/body under different property names.
const KINDS: Array<{
  kind: ActivityKind;
  path: string;
  properties: string[];
  subject: (p: Record<string, string | null>) => string | null;
  body: (p: Record<string, string | null>) => string | null;
}> = [
  {
    kind: 'call',
    path: '/crm/v3/objects/calls/search',
    properties: ['hs_call_title', 'hs_call_body', 'hs_createdate'],
    subject: (p) => p.hs_call_title ?? null,
    body: (p) => p.hs_call_body ?? null,
  },
  {
    kind: 'note',
    path: '/crm/v3/objects/notes/search',
    properties: ['hs_note_body', 'hs_createdate'],
    subject: (p) => (p.hs_note_body ? p.hs_note_body.slice(0, 120) : null),
    body: (p) => p.hs_note_body ?? null,
  },
  {
    kind: 'meeting',
    path: '/crm/v3/objects/meetings/search',
    properties: ['hs_meeting_title', 'hs_meeting_body', 'hs_createdate'],
    subject: (p) => p.hs_meeting_title ?? null,
    body: (p) => p.hs_meeting_body ?? null,
  },
  {
    kind: 'task',
    path: '/crm/v3/objects/tasks/search',
    properties: ['hs_task_subject', 'hs_task_body', 'hs_createdate'],
    subject: (p) => p.hs_task_subject ?? null,
    body: (p) => p.hs_task_body ?? null,
  },
  {
    kind: 'email',
    path: '/crm/v3/objects/emails/search',
    properties: ['hs_email_subject', 'hs_email_text', 'hs_createdate'],
    subject: (p) => p.hs_email_subject ?? null,
    body: (p) => p.hs_email_text ?? null,
  },
];

export const getContactTimeline = registerTool({
  id: 'hubspot.get_contact_timeline',
  description:
    'Get the full interaction history (calls, notes, meetings, tasks, emails) for a HubSpot contact over the last `days`, merged and sorted newest-first.',
  inputSchema: z.object({
    contactId: z.string(),
    days: z.number().int().min(1).max(365).default(90),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.contacts.read', 'sales-email-read'] }],
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const days = input.days ?? 90;
    const cutoff = String(Date.now() - days * 86_400_000);
    type SearchR = { results: Array<{ id: string; properties: Record<string, string | null> }> };

    const fetches = KINDS.map(async (k) => {
      const data = await hsFetch<SearchR>(ctx, k.path, {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                { propertyName: 'associations.contact', operator: 'EQ', value: input.contactId },
                { propertyName: 'hs_createdate', operator: 'GTE', value: cutoff },
              ],
            },
          ],
          properties: k.properties,
          sorts: [{ propertyName: 'hs_createdate', direction: 'DESCENDING' }],
          limit: input.limit,
        }),
      });
      return data.results.map((r) => ({
        id: r.id,
        type: k.kind,
        subject: k.subject(r.properties),
        body: k.body(r.properties),
        createdAt: r.properties.hs_createdate ?? null,
      }));
    });

    const all = (await Promise.all(fetches)).flat();
    all.sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return tb - ta;
    });
    const results = all.slice(0, input.limit);
    const markdown = results
      .map((r) => `- **${r.type}** (${r.createdAt ?? 'unknown date'}): ${r.subject ?? '(no subject)'}`)
      .join('\n');
    return { results, markdown };
  },
});
