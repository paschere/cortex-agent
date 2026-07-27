import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { PREFERENCE_COLUMNS, rowToPreferences } from '@zipdev/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { PreferencesBody, type PreferencesView } from './schema';

export const runtime = 'nodejs';

/**
 * The person's own preferences — never an admin surface. Every read and write
 * is scoped to `requireSession().id`; there is no user id in the URL or body,
 * so one account can only ever change its own row.
 *
 * This is the only way the daily inbox digest gets switched on, which is the
 * point: Zippy reading someone's mailbox has to be granted by that person,
 * here, and revocable in the same click.
 */

function toView(
  userId: string,
  row: Record<string, unknown> | null,
  email: string,
): PreferencesView {
  const p = rowToPreferences(userId, row);
  return {
    inboxDigestEnabled: p.enabled,
    inboxDigestTime: p.time,
    timezone: p.timezone,
    deliverEmail: p.deliverEmail,
    deliverChat: p.deliverChat,
    chatWebhookUrl: p.chatWebhookUrl ?? '',
    digestFocus: p.digestFocus ?? '',
    email,
  };
}

export async function GET() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  const { data, error } = await db
    .from('user_preferences')
    .select(PREFERENCE_COLUMNS)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'Could not load your settings.' }, { status: 500 });
  }
  return NextResponse.json({
    preferences: toView(user.id, (data as Record<string, unknown> | null) ?? null, user.email),
  });
}

async function upsert(req: NextRequest) {
  const user = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = PreferencesBody.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? 'Those settings are not valid.', issues: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const p = parsed.data;

  // Only the keys actually sent are written, so a partial save never silently
  // resets something the form did not show.
  const patch: Record<string, unknown> = { user_id: user.id, updated_at: new Date().toISOString() };
  if (p.inboxDigestEnabled !== undefined) patch.inbox_digest_enabled = p.inboxDigestEnabled;
  if (p.inboxDigestTime !== undefined) patch.inbox_digest_time = p.inboxDigestTime;
  if (p.timezone !== undefined) patch.timezone = p.timezone;
  if (p.deliverEmail !== undefined) patch.deliver_email = p.deliverEmail;
  if (p.deliverChat !== undefined) patch.deliver_chat = p.deliverChat;
  if (p.chatWebhookUrl !== undefined) patch.chat_webhook_url = p.chatWebhookUrl || null;
  if (p.digestFocus !== undefined) patch.digest_focus = p.digestFocus || null;

  const db = getSupabaseServiceClient();
  const { data, error } = await db
    .from('user_preferences')
    .upsert(patch, { onConflict: 'user_id' })
    .select(PREFERENCE_COLUMNS)
    .single();

  if (error) {
    return NextResponse.json({ error: 'Could not save your settings.' }, { status: 500 });
  }

  return NextResponse.json({
    preferences: toView(user.id, data as Record<string, unknown>, user.email),
  });
}

export async function PATCH(req: NextRequest) {
  return upsert(req);
}

export async function POST(req: NextRequest) {
  return upsert(req);
}
