import { getChatDmSpace, isChatOutboundConfigured, sendChatMessage } from '@/lib/google-chat';
import { requireSession } from '@/lib/session';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * "Send test DM" from the settings page.
 *
 * Unlike the webhook test, there is no URL to validate: the destination is
 * whatever DM space Google recorded for THIS session's user, resolved
 * server-side. No body, no target parameter — so the endpoint can only ever
 * message the person calling it.
 *
 * The interesting failure is the boring one: someone ticks the box before ever
 * saying hi to the Cortex app, so no DM thread exists. That gets a plain answer
 * telling them how to create it, not a 500.
 */
export async function POST() {
  const user = await requireSession();

  if (!isChatOutboundConfigured()) {
    return NextResponse.json(
      {
        error:
          'The Cortex Google Chat app is not set up on this environment yet, so direct messages cannot be sent.',
      },
      { status: 503 },
    );
  }

  const space = await getChatDmSpace(user.id);
  if (!space) {
    return NextResponse.json(
      {
        error:
          "You haven't messaged Cortex in Google Chat yet, so there's no direct-message thread to post into. Open Google Chat, search for Cortex, say hi — then refresh this page.",
        linked: false,
      },
      { status: 422 },
    );
  }

  const result = await sendChatMessage({
    space,
    text: [
      '*Cortex test message*',
      '',
      `Hi ${user.name ?? user.email} — your daily inbox digest will arrive right here, just between us.`,
      'You can turn this off any time in Settings.',
    ].join('\n'),
    threadKey: `settings-test-${user.id}`,
  });

  if (!result.sent) {
    return NextResponse.json(
      {
        error: `Google Chat did not accept the message (${result.reason ?? 'unknown reason'}). Try again in a moment.`,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, linked: true });
}
