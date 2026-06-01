import { z } from 'zod';
import { registerTool } from '../index';
import { slackPostMessage } from './client';

export const postMessage = registerTool({
  id: 'slack.post_message',
  description:
    'Post a message to a Slack channel via the Slack Web API (chat.postMessage). ' +
    '`channel` may be a channel ID (e.g. C0123ABCD) or name (e.g. #recruiting). `text` is the message body (supports Slack mrkdwn). ' +
    'Requires the SLACK_BOT_TOKEN env var. Use to notify a team channel; this sends a real message, so it requires confirmation.',
  inputSchema: z.object({
    channel: z.string().min(1),
    text: z.string().min(1),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    ts: z.string().optional(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    const res = await slackPostMessage({ channel: input.channel, text: input.text });
    return {
      ok: res.ok,
      ts: res.ts,
      markdown: `Posted message to \`${res.channel ?? input.channel}\`${res.ts ? ` (ts ${res.ts})` : ''}.`,
    };
  },
});
