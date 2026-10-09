import {
  CONNECT_FROM_COOKIE,
  cameFromOnboarding,
  connectedPath,
  failedPath,
  googleKickoffJobs,
} from '@/lib/first-run/oauth-return';
import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getSyncState } from '@cortex/agent-tools';
import { IntegrationError, encryptToken, getEnv } from '@cortex/core';
import { logger } from '@cortex/core';
import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const user = await requireSession();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieStore = await cookies();
  const expected = cookieStore.get('g_oauth_state')?.value;
  cookieStore.delete('g_oauth_state');
  // El recorrido de los primeros 15 minutos deja esta marca antes de mandar a Google.
  const fromOnboarding = cameFromOnboarding(cookieStore.get(CONNECT_FROM_COOKIE)?.value);
  cookieStore.delete(CONNECT_FROM_COOKIE);
  if (!code || !state || state !== expected) {
    return NextResponse.redirect(new URL(failedPath('google', 'state', fromOnboarding), req.url));
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
    new Set([...((existing?.scopes as string[] | undefined) ?? []), ...tok.scope.split(' ')]),
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

  // Arranque al conectar: conectar Google no es consentir a leer el correo ni
  // todo el Drive (eso lo pide el recorrido con su interruptor y su selector).
  // Sólo se retoma una carga de correo que la persona ya había encendido.
  try {
    const mail = await getSyncState(db, user.id);
    const jobs = googleKickoffJobs({
      userId: user.id,
      organizationId: user.organization.id,
      gmail: mail ? { paused: mail.paused, backfillDoneAt: mail.backfillDoneAt } : null,
    });
    for (const job of jobs) await enqueueJob(job.name, job.data);
  } catch (err) {
    logger.warn({ err }, 'google callback: no se pudo retomar la carga de correo');
  }

  return NextResponse.redirect(new URL(connectedPath('google', fromOnboarding), req.url));
}
