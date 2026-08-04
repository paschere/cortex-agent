import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const Output = z.object({
  id: z.string(),
  type: z.enum(['call', 'note', 'meeting']),
  associatedObjectType: z.enum(['contact', 'company']),
  associatedObjectId: z.string(),
});

// HubSpot v4 default association type IDs (activity → object).
const ASSOCIATION_TYPE_ID: Record<
  'call' | 'note' | 'meeting',
  Record<'contact' | 'company', number>
> = {
  call: { contact: 194, company: 182 },
  note: { contact: 202, company: 190 },
  meeting: { contact: 200, company: 188 },
};

export const logActivity = registerTool({
  id: 'hubspot.log_activity',
  description:
    'Log a call, note, or meeting activity in HubSpot and associate it with a contact or company.',
  inputSchema: z.object({
    type: z.enum(['call', 'note', 'meeting']),
    subject: z.string().min(1),
    body: z.string().optional(),
    associatedObjectType: z.enum(['contact', 'company']),
    associatedObjectId: z.string(),
    durationMs: z.number().int().optional().describe('For calls only'),
    meetingStartTime: z.string().optional().describe('ISO datetime for meetings'),
  }),
  outputSchema: Output,
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.notes.write'] }],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const timestamp = String(Date.now());
    const properties: Record<string, string> = {};

    if (input.type === 'note') {
      properties.hs_note_body = input.body ?? input.subject;
      properties.hs_timestamp = timestamp;
    } else if (input.type === 'call') {
      properties.hs_call_title = input.subject;
      if (input.body !== undefined) properties.hs_call_body = input.body;
      if (input.durationMs !== undefined) properties.hs_call_duration = String(input.durationMs);
      properties.hs_timestamp = timestamp;
    } else {
      properties.hs_meeting_title = input.subject;
      if (input.body !== undefined) properties.hs_meeting_body = input.body;
      const start = input.meetingStartTime ?? new Date().toISOString();
      properties.hs_meeting_start_time = start;
      properties.hs_timestamp = String(Date.parse(start));
    }

    type A = { id: string };
    const activity = await hsFetch<A>(ctx, `/crm/v3/objects/${input.type}s`, {
      method: 'POST',
      body: JSON.stringify({ properties }),
    });

    const associationTypeId = ASSOCIATION_TYPE_ID[input.type][input.associatedObjectType];
    await hsFetch(
      ctx,
      `/crm/v4/associations/${input.type}s/${activity.id}/${input.associatedObjectType}s/batch/create`,
      {
        method: 'POST',
        body: JSON.stringify({
          inputs: [
            {
              _from: { id: activity.id },
              to: { id: input.associatedObjectId },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }],
            },
          ],
        }),
      },
    );

    return {
      id: activity.id,
      type: input.type,
      associatedObjectType: input.associatedObjectType,
      associatedObjectId: input.associatedObjectId,
    };
  },
});
