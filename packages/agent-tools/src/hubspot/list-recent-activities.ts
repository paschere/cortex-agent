import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const ActivityOut = z.object({
  id: z.string(),
  type: z.enum(['email', 'call', 'note', 'meeting', 'task']),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  createdAt: z.string(),
});

export const listRecentActivities = registerTool({
  id: 'hubspot.list_recent_activities',
  description: 'List recent engagements (emails, calls, notes, meetings, tasks) for a HubSpot company, newest first.',
  inputSchema: z.object({
    companyId: z.string(),
    days: z.number().int().min(1).max(365).default(30),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({ results: z.array(ActivityOut) }),
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.companies.read', 'sales-email-read'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const days = input.days ?? 30;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const types: Array<z.infer<typeof ActivityOut>['type']> = ['email', 'call', 'note', 'meeting', 'task'];
    const all: Array<z.infer<typeof ActivityOut>> = [];
    for (const t of types) {
      type R = { results: Array<{ id: string; properties: Record<string, string | null> }> };
      const data = await hsFetch<R>(ctx, `/crm/v3/objects/${t}s/search`, {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                { propertyName: 'associations.company', operator: 'EQ', value: input.companyId },
                { propertyName: 'hs_createdate', operator: 'GTE', value: since },
              ],
            },
          ],
          properties: [
            'hs_email_subject',
            'hs_email_text',
            'hs_call_title',
            'hs_call_body',
            'hs_note_body',
            'hs_meeting_title',
            'hs_meeting_body',
            'hs_task_subject',
            'hs_task_body',
            'hs_createdate',
          ],
          sorts: [{ propertyName: 'hs_createdate', direction: 'DESCENDING' }],
          limit: input.limit,
        }),
      });
      for (const r of data.results) {
        const subject =
          r.properties.hs_email_subject ??
          r.properties.hs_call_title ??
          r.properties.hs_meeting_title ??
          r.properties.hs_task_subject ??
          null;
        const body =
          r.properties.hs_email_text ??
          r.properties.hs_call_body ??
          r.properties.hs_note_body ??
          r.properties.hs_meeting_body ??
          r.properties.hs_task_body ??
          null;
        all.push({ id: r.id, type: t, subject, body, createdAt: r.properties.hs_createdate ?? since });
      }
    }
    return { results: all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, input.limit) };
  },
});
