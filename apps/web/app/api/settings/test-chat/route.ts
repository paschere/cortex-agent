import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { flattenMarkdownForChat, parseChatWebhookUrl } from '@cortex/agent-tools';
import { ValidationError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

/**
 * "Send test message" from the settings page.
 *
 * The URL is re-validated here rather than trusted from the browser: this route
 * makes an outbound POST to a host the caller supplies, which is the classic
 * SSRF shape. `parseChatWebhookUrl` pins it to chat.googleapis.com and to the
 * `/v1/spaces/…/messages` path, so the only thing this endpoint can ever reach
 * is Google Chat.
 */

const Body = z.object({
  // Omit to test the webhook already saved on the account.
  webhookUrl: z.string().trim().max(1000).optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireSession();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  let candidate = parsed.data.webhookUrl?.trim() ?? '';
  if (!candidate) {
    const db = getOrgScopedClient(user.organization.id);
    const { data } = await db
      .from('user_preferences')
      .select('chat_webhook_url')
      .eq('user_id', user.id)
      .maybeSingle();
    candidate = ((data?.chat_webhook_url as string | null) ?? '').trim();
  }
  if (!candidate) {
    return NextResponse.json(
      { error: 'Paste the webhook URL from your Google Chat space first.' },
      { status: 422 },
    );
  }

  let target: { url: string; space: string };
  try {
    target = parseChatWebhookUrl(candidate);
  } catch (err) {
    const message =
      err instanceof ValidationError ? err.message : 'That is not a valid Google Chat webhook.';
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const text = flattenMarkdownForChat(
    [
      '*Cortex test message*',
      '',
      `This space is now connected to ${user.name ?? user.email}. Your daily inbox digest will arrive here.`,
      'If you did not expect this, remove the webhook from the space.',
    ].join('\n'),
  );

  try {
    const r = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      // Google echoes the request URL (with its key and token) in errors —
      // strip it before it reaches the browser or the logs.
      const detail = (await r.text().catch(() => ''))
        .replace(/https:\/\/chat\.googleapis\.com\/\S+/g, '[webhook url]')
        .slice(0, 200);
      return NextResponse.json(
        {
          error:
            r.status === 404
              ? 'That webhook no longer exists in the space. Create a new one and paste it here.'
              : `Google Chat refused the message (${r.status}). ${detail}`,
        },
        { status: 502 },
      );
    }
  } catch {
    return NextResponse.json({ error: 'Could not reach Google Chat. Try again.' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, space: target.space });
}
