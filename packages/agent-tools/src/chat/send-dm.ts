import { z } from 'zod';
import { registerTool } from '../index';
import type { ToolContext } from '../types';
import {
  capForChat,
  isChatAppConfigured,
  normalizeChatSpace,
  postChatAppMessage,
} from './service-account';
import { CHAT_TEXT_LIMIT, flattenMarkdownForChat } from './webhook';

/**
 * `chat.send_dm` — direct-message a Zipdev user as the Cortex Chat app.
 *
 * The sibling tool `chat.send_message` posts into a SPACE through a webhook the
 * person pasted into settings. This one posts into the 1:1 conversation between
 * that person and the Chat app, which nobody else can see.
 *
 * The DM space cannot be created on demand — Google only hands it to us once
 * the person has messaged the app. `google_chat_links.dm_space` is written the
 * first time that happens (see /api/chat-app/google). So "this person never
 * said hi to Cortex" is a NORMAL outcome, not an error: it reports
 * `{ sent: false, reason: 'not linked' }` and explains what to do. Nothing here
 * throws — a digest with three channels must not lose the other two because
 * Chat is unreachable.
 */

/** Machine-ish reasons, stable enough for a caller to branch on. */
export type ChatDmReason =
  | 'not linked'
  | 'chat app not configured'
  | 'empty message'
  | 'invalid space'
  | 'lookup failed'
  | 'network error'
  | (string & {});

export interface ChatDmLink {
  space: string;
  displayName: string | null;
}

/**
 * The DM space recorded for a Zipdev user, or null when they have never
 * messaged the Chat app. Most recent link wins — someone can have more than one
 * Google identity pointed at the same Zipdev account.
 */
export async function findChatDmLink(
  ctx: Pick<ToolContext, 'db'>,
  userId: string,
): Promise<ChatDmLink | null> {
  if (!userId) return null;
  try {
    const { data } = await ctx.db
      .from('google_chat_links')
      .select('dm_space, display_name')
      .eq('user_id', userId)
      .not('dm_space', 'is', null)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const space = normalizeChatSpace((data?.dm_space as string | null | undefined) ?? '');
    if (!space) return null;
    return { space, displayName: (data?.display_name as string | null | undefined) ?? null };
  } catch {
    return null;
  }
}

/**
 * The sentence a person can act on when there is no DM thread yet. `subject` is
 * the pronoun to use — "you" when it is the caller, "they" for a teammate.
 */
export function notLinkedExplanation(subject: 'you' | 'they' = 'they'): string {
  const have = subject === 'you' ? "you haven't" : "they haven't";
  return `${have} messaged Cortex in Google Chat yet, so there's no direct-message thread to post into. Open Google Chat, search for the Cortex app and say hi — that creates the thread, and Cortex can write there from then on.`;
}

export const chatSendDm = registerTool({
  id: 'chat.send_dm',
  description:
    'Send a private direct message to a Zipdev teammate through the Cortex app in Google Chat. Only that person sees it — use it for anything personal (their own digest, a reminder, a heads-up) instead of posting into a shared space. Markdown is accepted and converted automatically to what Google Chat renders; do not format for Chat yourself. It only works for people who have messaged the Cortex app at least once, because that is what creates the direct-message thread; for anyone else it reports back that they are not linked instead of failing, and you should tell them to say hi to Cortex in Google Chat. Leave userId out to message the person you are working for.',
  inputSchema: z.object({
    userId: z
      .string()
      .uuid()
      .optional()
      .describe('The Zipdev user to DM. Defaults to the person you are working for.'),
    text: z
      .string()
      .min(1)
      .max(40_000)
      .describe('The message. Plain text or markdown — it is converted for Google Chat.'),
    threadKey: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Group related messages into one Chat thread by reusing the same key.'),
  }),
  outputSchema: z.object({
    sent: z.boolean(),
    /** null when it went through; a short reason otherwise. */
    reason: z.string().nullable(),
    userId: z.string(),
    /** `spaces/AAA` — the DM space, or null when the person is not linked. */
    space: z.string().nullable(),
    charsSent: z.number(),
    truncated: z.boolean(),
    markdown: z.string(),
  }),
  // It puts a message in front of a human. Interactively that is one click; on a
  // schedule it rides on the job's allow_unattended_writes, which for the digest
  // is exactly what the opt-in in Settings authorizes.
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const targetId = input.userId ?? ctx.userId;
    const self = targetId === ctx.userId;
    const who = self ? 'you' : 'that teammate';

    const fail = (reason: ChatDmReason, markdown: string, space: string | null = null) => ({
      sent: false,
      reason,
      userId: targetId,
      space,
      charsSent: 0,
      truncated: false,
      markdown,
    });

    if (!isChatAppConfigured()) {
      return fail(
        'chat app not configured',
        'The Cortex Google Chat app is not set up on this environment, so direct messages cannot be sent. Nothing was delivered.',
      );
    }

    const link = await findChatDmLink(ctx, targetId);
    if (!link) {
      return fail(
        'not linked',
        `No direct message was sent — ${notLinkedExplanation(self ? 'you' : 'they')}`,
      );
    }

    // Flatten first without a ceiling, then cap with a tail that points at the
    // full version — truncating raw markdown could cut a link in half.
    const flattened = flattenMarkdownForChat(input.text, Number.MAX_SAFE_INTEGER);
    if (!flattened.trim()) {
      return fail('empty message', 'The message was empty after formatting, so nothing was sent.');
    }
    const text = capForChat(flattened, CHAT_TEXT_LIMIT);
    const truncated = text.length < flattened.length;

    const payload: Parameters<typeof postChatAppMessage>[0] = { space: link.space, text };
    if (input.threadKey) payload.threadKey = input.threadKey;
    if (ctx.signal) payload.signal = ctx.signal;

    const result = await postChatAppMessage(payload);
    if (!result.sent) {
      return fail(
        result.reason ?? 'chat error',
        `Google Chat did not accept the direct message (${result.reason ?? 'unknown reason'}). Nothing was delivered to ${who}.`,
        link.space,
      );
    }

    return {
      sent: true,
      reason: null,
      userId: targetId,
      space: link.space,
      charsSent: text.length,
      truncated,
      markdown: `Sent a ${text.length}-character direct message in Google Chat to ${
        self ? 'you' : (link.displayName ?? 'that teammate')
      }.${truncated ? ' It was trimmed to fit the Chat message limit, with a link to the full version.' : ''}`,
    };
  },
});
