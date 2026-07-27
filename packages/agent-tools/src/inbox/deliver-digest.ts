import { z } from 'zod';
import { writeAuditEvent } from '../audit';
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
 *     themselves (their account email, their own Chat webhook). There is no
 *     recipient parameter.
 *  3. It returns counts and destinations — never the digest text. So a routine
 *     fanning this out across the company reports "delivered to 6 people" and
 *     has read nobody's mail.
 *
 * `userId` exists for exactly one caller: the scheduled routine that walks the
 * opted-in users. Because of (2) and (3), targeting someone else discloses
 * nothing to the caller — the mail is read with that person's own Google token
 * and lands in that person's own inbox.
 */

interface DeliveryOutcome {
  channel: 'email' | 'google_chat';
  sent: boolean;
  destination: string;
  reason?: string;
}

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
    "Build a person's daily inbox digest and deliver it the way they asked for it in their own settings — by email, to their Google Chat space, or both. Use this for the scheduled daily digest. It only runs for people who turned the digest on themselves; for anyone who has not, it stops and reports the reason instead of failing, and it will not send the same person two digests in one day. It reports how many conversations needed attention and where the digest was delivered — never the contents, which stay between Zippy and the mailbox's owner. Pass userId only when running the digest on someone else's behalf from a scheduled routine; leave it out to run it for yourself.",
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
        channel: z.enum(['email', 'google_chat']),
        sent: z.boolean(),
        destination: z.string(),
        reason: z.string().optional(),
      }),
    ),
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
    if (!wantsEmail && !wantsChat) {
      return skip(
        'the digest is on but no delivery channel is set up — no email and no Google Chat webhook',
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

    const delivered = channels.some((c) => c.sent);

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
      .map((c) =>
        c.channel === 'email' ? `email (${c.destination})` : `Google Chat (${c.destination})`,
      )
      .join(' and ');
    const failures = channels.filter((c) => !c.sent).map((c) => `${c.channel}: ${c.reason}`);

    return {
      userId: targetId,
      delivered,
      skipped: false,
      reason: delivered ? null : failures.join('; ') || 'nothing could be delivered',
      channels,
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
