import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { requireSession } from '@/lib/session';
import { getEnv } from '@zipdev/core';

const SCOPES = [
  'crm.objects.companies.read',
  'crm.objects.deals.read',
  'crm.objects.contacts.read',
  'crm.schemas.companies.read',
  'crm.schemas.deals.read',
  'crm.objects.contacts.write',
  'crm.objects.deals.write',
  'crm.objects.notes.write',
  'oauth',
];

export async function GET(_req: NextRequest) {
  await requireSession();
  const env = getEnv();
  // Private-app mode: HubSpot access is workspace-wide via
  // HUBSPOT_PRIVATE_APP_TOKEN — there is nothing to connect per user.
  if (env.HUBSPOT_PRIVATE_APP_TOKEN || !env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_REDIRECT_URI) {
    return NextResponse.json(
      { error: 'HubSpot uses a workspace private app; per-user connect is disabled.' },
      { status: 409 },
    );
  }
  const state = randomBytes(16).toString('hex');
  const cookieStore = await cookies();
  cookieStore.set('h_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600,
  });
  const auth = new URL('https://app.hubspot.com/oauth/authorize');
  auth.searchParams.set('client_id', env.HUBSPOT_CLIENT_ID);
  auth.searchParams.set('redirect_uri', env.HUBSPOT_REDIRECT_URI);
  auth.searchParams.set('scope', SCOPES.join(' '));
  auth.searchParams.set('state', state);
  return NextResponse.redirect(auth);
}
