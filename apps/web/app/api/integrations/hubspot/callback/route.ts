import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { encryptToken, getEnv, IntegrationError } from '@cortex/core';

export async function GET(req: NextRequest) {
  const user = await requireSession();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieStore = await cookies();
  const expected = cookieStore.get('h_oauth_state')?.value;
  cookieStore.delete('h_oauth_state');
  if (!code || !state || state !== expected) {
    return NextResponse.redirect(new URL('/integrations?error=state', req.url));
  }

  const env = getEnv();
  if (env.HUBSPOT_PRIVATE_APP_TOKEN || !env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_CLIENT_SECRET || !env.HUBSPOT_REDIRECT_URI) {
    return NextResponse.redirect(new URL('/integrations?error=private_app_mode', req.url));
  }
  const tokenRes = await fetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.HUBSPOT_CLIENT_ID,
      client_secret: env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: env.HUBSPOT_REDIRECT_URI,
      code,
    }),
  });
  if (!tokenRes.ok) {
    throw new IntegrationError(`HubSpot token exchange failed: ${tokenRes.status}`, 'hubspot');
  }
  const tok = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };

  const db = getSupabaseServiceClient();
  await db.from('integrations').upsert(
    {
      user_id: user.id,
      provider: 'hubspot',
      access_token_enc: encryptToken(tok.access_token),
      refresh_token_enc: encryptToken(tok.refresh_token),
      scopes: tok.scope ? tok.scope.split(' ') : [
        'crm.objects.companies.read',
        'crm.objects.deals.read',
        'crm.objects.contacts.read',
        'crm.schemas.companies.read',
        'crm.schemas.deals.read',
        'oauth',
      ],
      expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' },
  );

  return NextResponse.redirect(new URL('/integrations?connected=hubspot', req.url));
}
