import { IntegrationError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import type { ToolContext } from '../types';
import { CHAT_TEXT_LIMIT, flattenMarkdownForChat, parseChatWebhookUrl } from './webhook';

/**
 * `chat.send_message` — post a message into a Google Chat space.
 *
 * Reusable delivery: the daily inbox digest uses it, but so can any report.
 * Give it text (markdown is fine — it is flattened into the subset Chat
 * renders) and it posts to the space behind the caller's saved webhook, or to
 * one passed explicitly.
 *
 * This POSTS a real message that other people in the space will see, so it is
 * confirmation-gated. A scheduled routine gets past the gate only when the job
 * was created with unattended writes allowed — which, for the digest, means the
 * person opted in from their own settings page.
 */

/** Resolve the webhook for this call: explicit input, else the caller's saved one. */
async function resolveWebhook(
  ctx: ToolContext,
  explicit: string | undefined,
): Promise<{ url: string; space: string; source: 'input' | 'preferences' }> {
  if (explicit) {
    const target = parseChatWebhookUrl(explicit);
    return { ...target, source: 'input' };
  }

  const { data } = await ctx.db
    .from('user_preferences')
    .select('chat_webhook_url')
    .eq('user_id', ctx.userId)
    .maybeSingle();

  const saved = (data?.chat_webhook_url as string | null | undefined) ?? '';
  if (!saved.trim()) {
    throw new ValidationError(
      'No Google Chat webhook is set up. Open Settings → Daily inbox digest, add the webhook URL ' +
        'from your space (Apps & integrations → Webhooks), and try again.',
    );
  }
  const target = parseChatWebhookUrl(saved);
  return { ...target, source: 'preferences' };
}

export const chatSendMessage = registerTool({
  id: 'chat.send_message',
  description:
    "Post a message into a Google Chat space through an incoming webhook. Use it to deliver a report, a digest or a notification to a space the user has set up. If no webhook URL is given, the one saved in the user's own settings is used, so normally you just pass the text. Markdown is accepted and converted automatically to what Google Chat can render (headings and bold become bold lines, tables become bullet lines) — do not try to format for Chat yourself. Only Google Chat webhook URLs are accepted; anything else is refused. This posts a real message that everyone in the space can see, so it always needs approval first.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(40_000)
      .describe('The message. Plain text or markdown — it is converted for Google Chat.'),
    webhookUrl: z
      .string()
      .optional()
      .describe(
        "Optional https://chat.googleapis.com/... webhook. Omit to use the caller's saved webhook.",
      ),
    threadKey: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Group related messages into one Chat thread by reusing the same key.'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    /** `spaces/AAA` — identifies the destination without exposing the credential. */
    space: z.string(),
    threadKey: z.string().nullable(),
    charsSent: z.number(),
    truncated: z.boolean(),
    webhookSource: z.enum(['input', 'preferences']),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const target = await resolveWebhook(ctx, input.webhookUrl);
    const text = flattenMarkdownForChat(input.text);
    if (!text) throw new ValidationError('The message is empty after formatting.');
    const truncated = text.length >= CHAT_TEXT_LIMIT - 2;

    const url = new URL(target.url);
    if (input.threadKey) {
      url.searchParams.set('threadKey', input.threadKey);
      url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
    }

    const r = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
      signal: ctx.signal,
    });

    if (!r.ok) {
      // The response body can echo the request URL; keep the credential out of
      // the error, the audit log and the model's context.
      const detail = (await r.text().catch(() => ''))
        .replace(/https:\/\/chat\.googleapis\.com\/\S+/g, '[webhook url]')
        .slice(0, 300);
      throw new IntegrationError(
        r.status === 404
          ? 'That Google Chat webhook no longer exists — recreate it in the space and update it in Settings.'
          : `Google Chat rejected the message (${r.status}): ${detail}`,
        'google_chat',
      );
    }

    return {
      ok: true,
      space: target.space,
      threadKey: input.threadKey ?? null,
      charsSent: text.length,
      truncated,
      webhookSource: target.source,
      markdown: `Posted a ${text.length}-character message to Google Chat (${target.space}).${
        truncated ? ' It was trimmed to fit the Chat message limit.' : ''
      }`,
    };
  },
});
