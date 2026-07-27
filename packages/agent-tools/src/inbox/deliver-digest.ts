import { z } from 'zod';
import { writeAuditEvent } from '../audit';
import { chatSendDm } from '../chat/send-dm';
import { chatSendMessage } from '../chat/send-message';
import { isGoogleChatWebhookUrl } from '../chat/webhook';
import { registerTool, runTool } from '../index';
import { createIntegrationsClient } from '../integrations';
import type { ToolContext } from '../types';
import { sendToolEmail } from './mailer';
import { loadDigestPreferences } from './preferences';
import { inboxPriorities } from './priorities';
import { DELIVERY_TOOL_ID, hasDigestToday } from './window';

/**
 * `inbox.deliver_digest` — build one person's digest and deliver it the way
 * THEY asked to receive it.
 *
 * Three properties make this safe enough to run unattended:
 *
 *  1. It is gated on the person's own opt-in. No `user_preferences` row, or
 *     `inbox_digest_enabled = false`, and it stops — and stops as a SKIP with a
 *     reason, not an error, because "this person did not ask for it" is the
 *     expected outcome for most of the roster, not a failure.
 *  2. It only ever delivers to that same person, at destinations they entered
 *     themselves (their account email, their own Chat webhook, their own DM
 *     thread with the Zippy Chat app). There is no recipient parameter.
 *  3. It returns counts and destinations — never the digest text. So a routine
 *     fanning this out across the company reports "delivered to 6 people" and
 *     has read nobody's mail.
 *
 * `userId` exists for exactly one caller: the scheduled routine that walks the
 * opted-in users. Because of (2) and (3), targeting someone else discloses
 * nothing to the caller — the mail is read with that person's own Google token
 * and lands in that person's own inbox.
 */

/**
 * Every channel the digest can go out on. `google_chat` is the shared SPACE
 * (webhook); `google_chat_dm` is the private 1:1 with the Zippy Chat app.
 */
type DeliveryChannel = 'email' | 'google_chat' | 'google_chat_dm';

interface DeliveryOutcome {
  channel: DeliveryChannel;
  sent: boolean;
  destination: string;
  reason?: string;
}

/**
 * Per-channel verdict, so a routine's summary can be honest about what actually
 * went out: 'skipped' means the person did not ask for that channel, 'failed'
 * means they did and it did not work. Collapsing those two into "not sent" is
 * how a digest quietly stops arriving for weeks without anyone noticing.
 */
type ChannelStatus = 'sent' | 'skipped' | 'failed';

function statusOf(channels: DeliveryOutcome[], channel: DeliveryChannel): ChannelStatus {
  const outcome = channels.find((c) => c.channel === channel);
  if (!outcome) return 'skipped';
  return outcome.sent ? 'sent' : 'failed';
}

const CHANNEL_LABELS: Record<DeliveryChannel, string> = {
  email: 'email',
  google_chat: 'Google Chat space',
  google_chat_dm: 'Google Chat direct message',
};

/** A tool context bound to the person the digest is for. */
function contextFor(ctx: ToolContext, userId: string): ToolContext {
  if (userId === ctx.userId) return ctx;
  return {
    ...ctx,
    userId,
    // Gmail must be read with THAT person's token, not the caller's.
    integrations: createIntegrationsClient(ctx.db, userId, ctx.logger),
  };
}

async function userEmail(ctx: ToolContext, userId: string): Promise<string | null> {
  const { data } = await ctx.db.from('users').select('email').eq('id', userId).maybeSingle();
  const email = (data?.email as string | null | undefined) ?? null;
  return email?.includes('@') ? email : null;
}

export const inboxDeliverDigest = registerTool({
  id: DELIVERY_TOOL_ID,
  description:
    "Build a person's daily inbox digest and deliver it the way they asked for it in their own settings — by email, into their Google Chat space, as a private Google Chat direct message from Zippy, or any combination. Use this for the scheduled daily digest. It only runs for people who turned the digest on themselves; for anyone who has not, it stops and reports the reason instead of failing, and it will not send the same person two digests in one day. It reports how many conversations needed attention and where the digest was delivered — never the contents, which stay between Zippy and the mailbox's owner. Pass userId only when running the digest on someone else's behalf from a scheduled routine; leave it out to run it for yourself.",
  inputSchema: z.object({
    userId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'The person whose digest to build and deliver to themselves. Defaults to the caller.',
      ),
    hours: z.number().int().min(1).max(168).default(24).describe('How far back the digest looks.'),
    force: z
      .boolean()
      .default(false)
      .describe('Send even if one was already delivered today. Off by default.'),
  }),
  outputSchema: z.object({
    userId: z.string(),
    delivered: z.boolean(),
    skipped: z.boolean(),
    reason: z.string().nullable(),
    channels: z.array(
      z.object({
        channel: z.enum(['email', 'google_chat', 'google_chat_dm']),
        sent: z.boolean(),
        destination: z.string(),
        reason: z.string().optional(),
      }),
    ),
    /** One verdict per channel — 'skipped' = not requested, 'failed' = tried and did not work. */
    delivery: z.object({
      email: z.enum(['sent', 'skipped', 'failed']),
      chatSpace: z.enum(['sent', 'skipped', 'failed']),
      chatDm: z.enum(['sent', 'skipped', 'failed']),
    }),
    needsYouCount: z.number(),
    waitingOnOthersCount: z.number(),
    scanned: z.number(),
    subject: z.string().nullable(),
    markdown: z.string(),
  }),
  // Delivery puts a message in front of a person. Interactively that is one
  // click; on a schedule it rides on the job's allow_unattended_writes, which
  // is what the opt-in in Settings ultimately authorizes.
  requiresConfirmation: true,
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const targetId = input.userId ?? ctx.userId;
    const target = contextFor(ctx, targetId);
    const prefs = await loadDigestPreferences(ctx.db, targetId);

    const skip = (reason: string) => ({
      userId: targetId,
      delivered: false,
      skipped: true,
      reason,
      channels: [] as DeliveryOutcome[],
      delivery: {
        email: 'skipped' as ChannelStatus,
        chatSpace: 'skipped' as ChannelStatus,
        chatDm: 'skipped' as ChannelStatus,
      },
      needsYouCount: 0,
      waitingOnOthersCount: 0,
      scanned: 0,
      subject: null,
      markdown: `Skipped: ${reason}`,
    });

    if (!prefs.enabled) {
      return skip('this person has not turned on the daily inbox digest');
    }
    const wantsEmail = prefs.deliverEmail;
    const wantsChat = prefs.deliverChat && !!prefs.chatWebhookUrl;
    const wantsChatDm = prefs.deliverChatDm;
    if (!wantsEmail && !wantsChat && !wantsChatDm) {
      return skip(
        'the digest is on but no delivery channel is set up — no email, no Google Chat webhook and no Chat direct message',
      );
    }
    if (!input.force && (await hasDigestToday(ctx.db, targetId, prefs.timezone))) {
      return skip("today's digest has already been delivered to this person");
    }

    // Built with the target's own Gmail token; the content never comes back
    // into the caller's result.
    const digest = await runTool(
      inboxPriorities,
      { hours: input.hours ?? 24, maxThreads: 40, unreadOnly: false },
      target,
    );

    const channels: DeliveryOutcome[] = [];

    if (wantsEmail) {
      const address = await userEmail(ctx, targetId);
      if (!address) {
        channels.push({
          channel: 'email',
          sent: false,
          destination: 'unknown',
          reason: 'no email address on file for this person',
        });
      } else {
        const result = await sendToolEmail({
          to: address,
          subject: digest.subject,
          text: digest.markdown,
          html: digest.emailHtml,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        channels.push({
          channel: 'email',
          sent: result.sent,
          destination: address,
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }
    }

    if (wantsChat) {
      const webhook = prefs.chatWebhookUrl ?? '';
      if (!isGoogleChatWebhookUrl(webhook)) {
        channels.push({
          channel: 'google_chat',
          sent: false,
          destination: 'saved webhook',
          reason: 'the saved Google Chat webhook is not a valid chat.googleapis.com URL',
        });
      } else {
        try {
          // The opt-in in Settings IS the confirmation for this one post: the
          // person chose the destination and asked for the daily delivery.
          const posted = await runTool(
            chatSendMessage,
            { text: digest.markdown, threadKey: `inbox-digest-${targetId}` },
            target,
            { confirmed: true },
          );
          channels.push({ channel: 'google_chat', sent: posted.ok, destination: posted.space });
        } catch (err) {
          channels.push({
            channel: 'google_chat',
            sent: false,
            destination: 'saved webhook',
            reason: (err as Error).message.slice(0, 200),
          });
        }
      }
    }

    if (wantsChatDm) {
      try {
        // Same reasoning as the space above: the opt-in in Settings is the
        // confirmation, and the message goes to the person themselves. Composed
        // from the digest MARKDOWN, never the email HTML — Chat renders neither
        // HTML nor markdown headings, and `chat.send_dm` flattens what it gets.
        const dm = await runTool(
          chatSendDm,
          {
            userId: targetId,
            text: digest.markdown,
            threadKey: `inbox-digest-${targetId}`,
          },
          target,
          { confirmed: true },
        );
        // "not linked" is the one failure a person can fix themselves, so it
        // says what to do rather than leaving a two-word verdict in the report.
        const reason =
          dm.reason === 'not linked'
            ? 'not linked — they have never messaged Zippy in Google Chat, so there is no direct-message thread'
            : dm.reason;
        channels.push({
          channel: 'google_chat_dm',
          sent: dm.sent,
          destination: dm.space ?? 'Zippy direct message',
          ...(reason ? { reason } : {}),
        });
      } catch (err) {
        // chat.send_dm itself never throws; this catches the layers around it
        // (rate limit, confirmation) so the other channels still count.
        channels.push({
          channel: 'google_chat_dm',
          sent: false,
          destination: 'Zippy direct message',
          reason: (err as Error).message.slice(0, 200),
        });
      }
    }

    const delivered = channels.some((c) => c.sent);
    const delivery = {
      email: statusOf(channels, 'email'),
      chatSpace: statusOf(channels, 'google_chat'),
      chatDm: statusOf(channels, 'google_chat_dm'),
    };

    // Written under the TARGET's user id so the "already sent today" check and
    // the person's own audit trail both see it, even when a routine owned by
    // somebody else is the one that ran it.
    if (delivered) {
      await writeAuditEvent({
        db: ctx.db,
        userId: targetId,
        agentId: ctx.agentId,
        toolId: DELIVERY_TOOL_ID,
        input: { hours: input.hours ?? 24 },
        status: 'ok',
        latencyMs: 0,
        metadata: {
          deliveredBy: ctx.userId,
          channels: channels.filter((c) => c.sent).map((c) => c.channel),
          needsYouCount: digest.needsYouCount,
        },
        surface: ctx.surface ?? 'schedule',
      });
    }

    const where = channels
      .filter((c) => c.sent)
      .map((c) => `${CHANNEL_LABELS[c.channel]} (${c.destination})`)
      .join(' and ');
    const failures = channels
      .filter((c) => !c.sent)
      .map((c) => `${CHANNEL_LABELS[c.channel]}: ${c.reason ?? 'unknown reason'}`);

    return {
      userId: targetId,
      delivered,
      skipped: false,
      reason: delivered ? null : failures.join('; ') || 'nothing could be delivered',
      channels,
      delivery,
      needsYouCount: digest.needsYouCount,
      waitingOnOthersCount: digest.waitingOnOthersCount,
      scanned: digest.scanned,
      subject: digest.subject,
      markdown: delivered
        ? `Digest delivered via ${where}. ${digest.needsYouCount} conversation${
            digest.needsYouCount === 1 ? '' : 's'
          } need a reply.${failures.length ? ` Not delivered to: ${failures.join('; ')}.` : ''}`
        : `Nothing was delivered. ${failures.join('; ')}`,
    };
  },
});
