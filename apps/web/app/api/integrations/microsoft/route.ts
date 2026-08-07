import { randomBytes } from 'node:crypto';
import { requireSession } from '@/lib/session';
import { GRAPH_PROTOCOL_SCOPES, GRAPH_SCOPES, microsoftAuthorizeUrl } from '@cortex/agent-tools';
import { getEnv } from '@cortex/core';
import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Start the Microsoft 365 connect flow.
 *
 * ONE PERSON, ONE MAILBOX. Every scope below is a DELEGATED permission: the
 * token that comes back acts as whoever completed this flow and reaches only
 * what they can already reach in Outlook. The alternative Microsoft offers —
 * application permissions plus one admin consent — would let Cortex read every
 * mailbox in the tenant with nobody in the loop, and that is precisely the
 * arrangement that gets a project stopped in a security review. It is not
 * available through this route and there is no other route.
 *
 * WHAT AN ADMINISTRATOR STILL HAS TO DO. Delegated does not mean unsupervised.
 * Most Microsoft 365 tenants disable user consent, so the FIRST person to run
 * this flow will be told to ask an administrator. That approval is granted once
 * for the tenant and then each person still authorises their own mailbox here.
 * docs/operations/microsoft.md is written to be handed to that administrator:
 * it lists every scope below and what it is for.
 */

/** Everything Cortex can ask for. Nothing here is optional-but-nice. */
const ALL_SCOPES = [
  GRAPH_SCOPES.MAIL_READ,
  GRAPH_SCOPES.MAIL_READ_WRITE,
  GRAPH_SCOPES.MAIL_SEND,
  GRAPH_SCOPES.CALENDARS_READ,
  GRAPH_SCOPES.CALENDARS_READ_WRITE,
] as const satisfies readonly string[];

/**
 * Presets, so a workspace can grant the half it wants.
 *
 * `mail_readonly` exists because it is the grant most customers should start
 * with: Cortex reads and searches correspondence and can draft nothing. It is
 * the honest answer to "can we try this without letting it write?".
 */
const SCOPE_PRESETS: Record<string, readonly string[]> = {
  mail_readonly: [GRAPH_SCOPES.MAIL_READ],
  mail: [GRAPH_SCOPES.MAIL_READ, GRAPH_SCOPES.MAIL_READ_WRITE, GRAPH_SCOPES.MAIL_SEND],
  calendar: [GRAPH_SCOPES.CALENDARS_READ, GRAPH_SCOPES.CALENDARS_READ_WRITE],
  calendar_readonly: [GRAPH_SCOPES.CALENDARS_READ],
  all: ALL_SCOPES,
};

export async function GET(req: NextRequest) {
  await requireSession();
  const env = getEnv();

  // A deployment with no Microsoft app registered answers a sentence naming
  // what is missing, rather than throwing a validation error at whoever clicked
  // "Conectar".
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REDIRECT_URI) {
    return NextResponse.json(
      {
        error:
          'Microsoft 365 is not configured on this deployment. Whoever runs it has to register the application in Azure and set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_REDIRECT_URI — see docs/operations/microsoft.md.',
      },
      { status: 409 },
    );
  }

  const url = new URL(req.url);
  const preset = url.searchParams.get('preset') ?? 'all';
  const requested = SCOPE_PRESETS[preset] ?? ALL_SCOPES;

  const state = randomBytes(16).toString('hex');
  const cookieStore = await cookies();
  cookieStore.set('ms_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600,
  });

  const auth = new URL(microsoftAuthorizeUrl());
  auth.searchParams.set('client_id', env.MICROSOFT_CLIENT_ID);
  auth.searchParams.set('redirect_uri', env.MICROSOFT_REDIRECT_URI);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('response_mode', 'query');
  auth.searchParams.set('state', state);
  // `offline_access` is what makes a refresh token come back at all — without
  // it the connection dies in an hour and every tool starts failing at lunch.
  auth.searchParams.set('scope', [...requested, ...GRAPH_PROTOCOL_SCOPES].join(' '));
  // Microsoft otherwise silently re-issues the previous, narrower grant when
  // somebody reconnects to add the calendar half. Asking again is one extra
  // click and removes a whole class of "it says I connected it but it cannot
  // see my calendar".
  auth.searchParams.set('prompt', 'consent');
  return NextResponse.redirect(auth);
}
