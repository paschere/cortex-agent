import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { encryptToken, getEnv, IntegrationError } from '@cortex/core';

export async function GET(req: NextRequest) {
  const user = await requireSession();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieStore = await cookies();
  const expected = cookieStore.get('g_oauth_state')?.value;
  cookieStore.delete('g_oauth_state');
  if (!code || !state || state !== expected) {
    return NextResponse.redirect(new URL('/integrations?error=state', req.url));
  }

  const env = getEnv();
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    throw new IntegrationError(`Google token exchange failed: ${tokenRes.status}`, 'google');
  }
  const tok = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  const db = getOrgScopedClient(user.organization.id);
  // Merge scopes with existing if this is an incremental grant (Google returns
  // previously-granted scopes via include_granted_scopes=true).
  const { data: existing } = await db
    .from('integrations')
    .select('id, scopes, refresh_token_enc')
    .eq('user_id', user.id)
    .eq('provider', 'google')
    .maybeSingle();

  const mergedScopes = Array.from(
    new Set([
      ...((existing?.scopes as string[] | undefined) ?? []),
      ...tok.scope.split(' '),
    ]),
  );
  const refreshEnc = tok.refresh_token
    ? encryptToken(tok.refresh_token)
    : ((existing?.refresh_token_enc as string | undefined) ?? null);

  await db.from('integrations').upsert(
    {
      user_id: user.id,
      provider: 'google',
      access_token_enc: encryptToken(tok.access_token),
      refresh_token_enc: refreshEnc,
      scopes: mergedScopes,
      expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' },
  );

  return NextResponse.redirect(new URL('/integrations?connected=google', req.url));
}
