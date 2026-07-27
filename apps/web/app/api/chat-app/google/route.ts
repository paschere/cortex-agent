import { sendEmail } from '@/lib/email';
import { sendChatDm, sendChatMessage, toChatText } from '@/lib/google-chat';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { logger } from '@zipdev/core';
import { type NextRequest, NextResponse, after } from 'next/server';
import {
  type ChatEvent,
  type ChatSpace,
  type ChatUser,
  SLASH_DIRECTIVES,
  audienceOf,
  conversationKey,
  detectSlashCommand,
  extractUserText,
} from './events';
import { runChatTurn } from './turn';
import { type ChatAuthFailureDetail, verifyGoogleChatRequest } from './verify';

/**
 * The Zippy Google Chat app — inbound webhook.
 *
 * Google Chat POSTs every interaction here: someone DMs Zippy, someone
 * @mentions it in a space, someone adds or removes it. It answers with the same
 * brain as the web chat (see ./turn.ts) and can also message people
 * proactively (see @/lib/google-chat).
 *
 * ── Authentication ────────────────────────────────────────────────────────
 * Every request carries a Bearer JWT signed by chat@system.gserviceaccount.com
 * whose `aud` is our project number. It is verified against Google's published
 * X.509 certificates before anything else happens; unverified requests get a
 * 401 and are never parsed. See ./verify.ts.
 *
 * ── The 5-second problem ──────────────────────────────────────────────────
 * Google Chat waits about 5 seconds for the HTTP response and shows
 * "Zippy isn't responding" if it doesn't get one. A real Zippy turn — retrieval
 * plus up to twelve tool steps — routinely takes longer than that.
 *
 * So the endpoint uses an ACK-THEN-ANSWER pattern:
 *
 *   1. Resolve who is asking and reply IMMEDIATELY with a short "on it ⚡".
 *      That synchronous body is what Chat posts into the thread.
 *   2. Run the actual turn in `after()`, which keeps the serverless invocation
 *      alive past the response, and post the finished answer back through the
 *      Chat REST API into the SAME thread.
 *
 * Everything that can fail in step 2 fails soft and is logged: a broken turn
 * must never leave the user staring at an un-answered mention, so the failure
 * itself is posted back as a message.
 *
 * ── Identity ──────────────────────────────────────────────────────────────
 * The actor is always the SENDER, resolved by email against `users` and cached
 * in `google_chat_links`. Tools run with that person's integrations and team
 * permissions, and every audit row is attributed to them — never to a shared
 * "bot" identity, and never to the space. An unlinked sender gets a polite
 * reply and nothing runs.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ACK_TEXT = 'On it ⚡';

interface LinkedUser {
  userId: string;
  email: string;
  name: string | null;
}

/**
 * Google Chat accepts two different response envelopes, and which one it wants
 * depends on how the app is configured in the console:
 *
 *   • "Chat app" (interaction events)  → { text: "…" }
 *   • "Workspace add-on" (Chat actions) → the reply must be wrapped in
 *     hostAppDataAction.chatDataAction.createMessageAction.message
 *
 * Sending the wrong shape fails with "Can't handle the app's response"
 * (code 3) — the reply never reaches the user even though everything else
 * worked. Rather than depend on a console checkbox staying a particular way,
 * we detect the add-on invocation from the request body and answer in kind.
 */
let respondAsAddOn = false;

function jsonText(text: string): NextResponse {
  if (respondAsAddOn) {
    return NextResponse.json({
      hostAppDataAction: {
        chatDataAction: { createMessageAction: { message: { text } } },
      },
    });
  }
  return NextResponse.json({ text });
}

/**
 * Add-on invocations wrap the Chat event under `chat` (e.g.
 * `{ chat: { messagePayload: { message, space, user } } }`) instead of sending
 * it at the top level. Unwrap it so the rest of the handler sees one shape.
 */
function unwrapChatEvent(body: Record<string, unknown>): {
  event: ChatEvent;
  isAddOn: boolean;
} {
  const chat = body.chat as Record<string, unknown> | undefined;
  if (!chat) return { event: body as ChatEvent, isAddOn: false };

  const payload = (chat.messagePayload ??
    chat.addedToSpacePayload ??
    chat.removedFromSpacePayload ??
    chat.buttonClickedPayload ??
    {}) as Record<string, unknown>;

  const type = chat.messagePayload
    ? 'MESSAGE'
    : chat.addedToSpacePayload
      ? 'ADDED_TO_SPACE'
      : chat.removedFromSpacePayload
        ? 'REMOVED_FROM_SPACE'
        : chat.buttonClickedPayload
          ? 'CARD_CLICKED'
          : 'MESSAGE';

  return {
    event: {
      type,
      message: payload.message,
      space: payload.space ?? (payload.message as Record<string, unknown> | undefined)?.space,
      user: payload.user ?? body.commonEventObject ? (body.authorizationEventObject as Record<string, unknown> | undefined) : undefined,
    } as unknown as ChatEvent,
    isAddOn: true,
  };
}

/** Escapes PostgREST `ilike` wildcards so an address can't turn into a pattern. */
function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (m) => `\\${m}`);
}

/**
 * Chat user → Zipdev user, by email.
 *
 * `email` is present for people inside the Workspace domain, which is exactly
 * who this app is published to. No email (or no matching Zipdev account) means
 * we refuse to act: running tools for an unidentified sender would attribute
 * someone else's data access to whoever we guessed.
 */
async function resolveUser(chatUser: ChatUser | undefined): Promise<LinkedUser | null> {
  const email = chatUser?.email?.trim();
  if (!email) return null;
  try {
    const db = getSupabaseServiceClient();
    const { data } = await db
      .from('users')
      .select('id, email, name')
      .ilike('email', escapeLike(email))
      .maybeSingle();
    if (!data?.id) return null;
    return {
      userId: data.id as string,
      email: (data.email as string | null) ?? email,
      name: (data.name as string | null) ?? null,
    };
  } catch (err) {
    logger.error('google-chat: user lookup failed', { error: (err as Error).message });
    return null;
  }
}

/**
 * Remember the mapping, and — for a 1:1 — the DM space. That space is the only
 * way to reach someone proactively later (approvals, digests, scheduled runs),
 * and Chat never tells us about it again, so it is captured on every event.
 */
async function upsertLink(opts: {
  chatUser: ChatUser;
  user: LinkedUser;
  space: ChatSpace | undefined;
}): Promise<void> {
  const chatUserName = opts.chatUser.name;
  if (!chatUserName) return;
  try {
    const db = getSupabaseServiceClient();
    const row: Record<string, unknown> = {
      chat_user_name: chatUserName,
      user_id: opts.user.userId,
      email: opts.user.email,
      display_name: opts.chatUser.displayName ?? opts.user.name ?? null,
      last_seen_at: new Date().toISOString(),
    };
    // Only a DM yields a usable dm_space. Omitting the column in the space case
    // leaves any previously-learned DM space untouched.
    if (audienceOf(opts.space) === 'dm' && opts.space?.name) row.dm_space = opts.space.name;
    await db.from('google_chat_links').upsert(row, { onConflict: 'chat_user_name' });
  } catch (err) {
    logger.error('google-chat: link upsert failed', { error: (err as Error).message });
  }
}

async function clearDmSpace(chatUserName: string | undefined, space: string | undefined) {
  if (!chatUserName || !space) return;
  try {
    const db = getSupabaseServiceClient();
    await db
      .from('google_chat_links')
      .update({ dm_space: null })
      .eq('chat_user_name', chatUserName)
      .eq('dm_space', space);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const DM_GREETING = toChatText(
  "Hi — I'm Zippy ⚡, Zipdev's agent. Ask me anything here and I'll work it the same way I do inside Zipdev OS: the Knowledge Base, HubSpot, the ATS and talent pool, rates, GitHub and Linear, your Google Workspace. Everything I do runs with **your own** permissions and integrations, and it all shows up in your conversation history and the audit log. Anything that writes to a real system waits for your explicit approval first.",
);

const SPACE_GREETING = toChatText(
  "Hi everyone — I'm Zippy ⚡, Zipdev's agent. **@mention me** in a thread and I'll answer there: pipeline and deal questions, candidates and requisitions, rates, tickets, whatever the Knowledge Base knows. I answer with the permissions of **whoever asks**, not the room's — so two people can get different answers, and that's on purpose. Anything involving compensation or personal data I send to you privately instead of posting here.",
);

const UNLINKED_REPLY = toChatText(
  "I can't help yet — I don't see a Zipdev OS account for your address, and I only ever act with a real person's own permissions. Ask an admin to set you up in Zipdev OS and then message me again.",
);

const NO_EMAIL_REPLY = toChatText(
  "I can't tell who you are from here — Google Chat isn't sharing your work address with me, so I have no way to run anything as you. This app is meant for Zipdev accounts inside the company.",
);

const EMPTY_MESSAGE_REPLY = toChatText("I'm here — what do you need? ⚡");

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Post the finished answer. `privateText` — an answer withheld from a space, or
 * an approval request only the requester may act on — goes to the sender's DM,
 * and falls back to email when they have never opened a DM with the app.
 */
async function deliver(opts: {
  space: string;
  threadName?: string;
  user: LinkedUser;
  publicText: string;
  privateText: string | null;
}): Promise<void> {
  if (opts.publicText) {
    const res = await sendChatMessage({
      space: opts.space,
      text: opts.publicText,
      ...(opts.threadName ? { threadName: opts.threadName } : {}),
    });
    if (!res.sent) {
      logger.error('google-chat: could not post the answer', {
        space: opts.space,
        reason: res.reason,
      });
    }
  }

  if (!opts.privateText) return;

  const dm = await sendChatDm({ userId: opts.user.userId, text: opts.privateText });
  if (dm.sent) return;

  // No DM space yet (they have never messaged the app 1:1). The Chat-flattened
  // text reads fine as plain text, so it goes out by email rather than being
  // dropped — or, worse, posted into the room it was withheld from.
  logger.warn('google-chat: private delivery fell back to email', { reason: dm.reason });
  await sendEmail({
    to: opts.user.email,
    subject: '[Zippy] Your answer from Google Chat',
    text: `${opts.privateText}\n\n(You asked me this in a Google Chat space. It was too sensitive to post there, and you have no direct message open with me yet — send me a DM in Chat and I'll use that next time.)`,
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleMessage(event: ChatEvent): Promise<NextResponse> {
  const sender = event.message?.sender;
  // Ignore the app's own messages, and anything else Chat labels non-human.
  if (sender?.type === 'BOT') return new NextResponse(null, { status: 200 });

  const spaceName = event.space?.name;
  if (!spaceName) return new NextResponse(null, { status: 200 });

  if (!sender?.email) return jsonText(NO_EMAIL_REPLY);

  const user = await resolveUser(sender);
  if (!user) return jsonText(UNLINKED_REPLY);

  await upsertLink({ chatUser: sender, user, space: event.space });

  const audience = audienceOf(event.space);
  const userText = extractUserText(event.message);
  if (!userText) return jsonText(EMPTY_MESSAGE_REPLY);

  const slash = detectSlashCommand(event.message);
  const directive = slash ? SLASH_DIRECTIVES[slash] : '';
  const threadName = event.message?.thread?.name;
  const key = conversationKey(spaceName, audience, threadName);

  // Ack now, answer later — see the 5-second note at the top of this file.
  after(async () => {
    try {
      const delivery = await runChatTurn({
        userId: user.userId,
        ...(sender.displayName ? { senderName: sender.displayName } : {}),
        space: spaceName,
        ...(event.space?.displayName ? { spaceDisplayName: event.space.displayName } : {}),
        audience,
        ...(threadName ? { threadName } : {}),
        conversationKey: key,
        userText,
        ...(directive ? { directive } : {}),
      });
      await deliver({
        space: spaceName,
        ...(threadName ? { threadName } : {}),
        user,
        publicText: delivery.publicText,
        privateText: delivery.privateText,
      });
    } catch (err) {
      logger.error('google-chat: async turn failed', { error: (err as Error).message });
      // Never leave a mention hanging.
      await sendChatMessage({
        space: spaceName,
        text: 'That one broke on my side before I could finish it — try me again in a moment. ⚡',
        ...(threadName ? { threadName } : {}),
      }).catch(() => undefined);
    }
  });

  return jsonText(ACK_TEXT);
}

async function handleAddedToSpace(event: ChatEvent): Promise<NextResponse> {
  const audience = audienceOf(event.space);
  const chatUser = event.user;
  if (chatUser?.email) {
    const user = await resolveUser(chatUser);
    // Capturing the DM space here is what lets Zippy message someone
    // proactively before they have ever written to it.
    if (user) await upsertLink({ chatUser, user, space: event.space });
  }
  return jsonText(audience === 'dm' ? DM_GREETING : SPACE_GREETING);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Read back the recent rejections.
 *
 * Google Chat only ever POSTs here, so GET is free for diagnostics — and this
 * path is in `middleware.ts`'s PUBLIC_PATHS (Chat has no session cookie), which
 * is precisely why it is gated on a shared secret instead of a session. Without
 * `CHAT_DIAGNOSTICS_KEY` set the route does not exist at all, so the default
 * deployment exposes nothing.
 *
 * An EMPTY list is itself the answer to the most common question: it means no
 * request from Google is arriving, i.e. the endpoint URL in the Chat console is
 * wrong — as opposed to arriving and failing verification.
 */
async function recentRejections(): Promise<NextResponse> {
  const { data, error } = await getSupabaseServiceClient()
    .from('security_events')
    .select('created_at, reason, signals')
    .eq('tool_id', 'chat.inbound')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    audienceConfigured: (process.env.GOOGLE_CHAT_AUDIENCE ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    rejections: data ?? [],
  });
}

/**
 * Persist why an inbound Chat request was turned away. Best-effort in the
 * strictest sense: it must never delay or fail the 401 it accompanies.
 */
async function recordRejection(
  reason: string,
  detail: ChatAuthFailureDetail | undefined,
): Promise<void> {
  try {
    await getSupabaseServiceClient()
      .from('security_events')
      .insert({
        tool_id: 'chat.inbound',
        surface: 'google-chat',
        risk_level: 'low',
        decision: 'block',
        reason,
        signals: detail ?? {},
      });
  } catch (err) {
    logger.error('google-chat: could not record the rejection', {
      error: (err as Error).message,
    });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await verifyGoogleChatRequest(req.headers.get('authorization'));
  if (!auth.ok) {
    // The reason goes in the MESSAGE, not in a context object: the platform log
    // drain only carries `msg`, so anything passed as structured context is
    // invisible exactly when it is needed.
    logger.warn(
      `google-chat: rejected an unverified request — ${auth.reason} ${JSON.stringify(auth.detail ?? {})}`,
    );
    // Also recorded, not just logged. Google shows the person nothing but
    // "Zippy isn't responding", and platform logs are awkward to reach from
    // where this gets debugged — a row in security_events makes a misconfigured
    // Chat app answerable with one query instead of a guessing game.
    void recordRejection(auth.reason, auth.detail);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let event: ChatEvent;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const unwrapped = unwrapChatEvent(body);
    event = unwrapped.event;
    respondAsAddOn = unwrapped.isAddOn;
    logger.info('google-chat: event received', {
      type: event.type,
      addOn: unwrapped.isAddOn,
      space: (event.space as { name?: string } | undefined)?.name,
    });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'MESSAGE':
        return await handleMessage(event);

      case 'ADDED_TO_SPACE':
        return await handleAddedToSpace(event);

      case 'REMOVED_FROM_SPACE':
        await clearDmSpace(event.user?.name, event.space?.name);
        return new NextResponse(null, { status: 200 });

      case 'CARD_CLICKED':
        // Zippy posts text, not cards. If a card ever arrives, say something
        // sensible rather than failing silently.
        return jsonText('That button is from an older message — just ask me again here. ⚡');

      default:
        return new NextResponse(null, { status: 200 });
    }
  } catch (err) {
    logger.error('google-chat: event handling failed', {
      type: event.type,
      error: (err as Error).message,
    });
    // A 200 with an apology beats a 500: Chat retries 5xx, and retrying an
    // agent turn is how you get the same answer posted three times.
    return jsonText('Something went wrong on my side — try me again in a moment.');
  }
}

/** Chat only ever POSTs. A GET is a human poking the URL — or asking why. */
export function GET(req: NextRequest): NextResponse | Promise<NextResponse> {
  const expected = process.env.CHAT_DIAGNOSTICS_KEY;
  if (expected && req.nextUrl.searchParams.get('key') === expected) {
    return recentRejections();
  }
  return NextResponse.json(
    { error: 'This endpoint only accepts Google Chat events (POST).' },
    { status: 405 },
  );
}
