import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { microsoftTokenUrl, normalizeGraphScopes } from '@cortex/agent-tools';
import { encryptToken, getEnv } from '@cortex/core';
import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Finish the Microsoft 365 connect flow.
 *
 * THE TOKENS NEVER LEAVE THIS FUNCTION IN THE CLEAR. Both are encrypted with
 * `encryptToken` (AES-256-GCM under TOKEN_ENCRYPTION_KEY) before they touch
 * the database, exactly as Google's are, and neither is logged, returned, or
 * put in a redirect. The only thing that comes back to the browser is the word
 * "microsoft" in a query string.
 */
export async function GET(req: NextRequest) {
  const user = await requireSession();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const cookieStore = await cookies();
  const expected = cookieStore.get('ms_oauth_state')?.value;
  cookieStore.delete('ms_oauth_state');
  if (!code || !state || state !== expected) {
    return NextResponse.redirect(new URL('/integrations?error=state', req.url));
  }

  const env = getEnv();
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REDIRECT_URI) {
    return NextResponse.redirect(new URL('/integrations?error=microsoft_not_configured', req.url));
  }

  const tokenRes = await fetch(microsoftTokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.MICROSOFT_CLIENT_ID,
      client_secret: env.MICROSOFT_CLIENT_SECRET,
      redirect_uri: env.MICROSOFT_REDIRECT_URI,
      code,
    }),
  });
  if (!tokenRes.ok) {
    // The status, never the body: Entra ID's error payload echoes parts of the
    // request, and a token exchange is the last place to be relaxed about that.
    return NextResponse.redirect(
      new URL(`/integrations?error=microsoft_token_${tokenRes.status}`, req.url),
    );
  }

  const tok = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };

  const db = getOrgScopedClient(user.organization.id);
  const { data: existing } = await db
    .from('integrations')
    .select('id, scopes, refresh_token_enc')
    .eq('user_id', user.id)
    .eq('provider', 'microsoft')
    .maybeSingle();

  // Stored short ("Mail.Read"), never resource-qualified — see
  // normalizeGraphScopes for why the two spellings cannot be allowed to mix.
  // Merged with what was already granted so reconnecting to add the calendar
  // half does not appear to revoke the mail half.
  const mergedScopes = Array.from(
    new Set([
      ...((existing?.scopes as string[] | undefined) ?? []),
      ...normalizeGraphScopes(tok.scope),
    ]),
  );

  // Entra ID rotates refresh tokens; a response without one means "keep using
  // the one you have", which only happens when offline_access was not granted.
  const refreshEnc = tok.refresh_token
    ? encryptToken(tok.refresh_token)
    : ((existing?.refresh_token_enc as string | undefined) ?? null);

  await db.from('integrations').upsert(
    {
      user_id: user.id,
      provider: 'microsoft',
      access_token_enc: encryptToken(tok.access_token),
      refresh_token_enc: refreshEnc,
      scopes: mergedScopes,
      expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' },
  );

  return NextResponse.redirect(new URL('/integrations?connected=microsoft', req.url));
}
