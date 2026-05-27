import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireSession } from '@/lib/session';
import { getEnv } from '@zipdev/core';
import { cookies } from 'next/headers';

const ALL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
] as const satisfies string[];

const SCOPE_PRESETS: Record<string, string[]> = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
  ],
  drive: ['https://www.googleapis.com/auth/drive.readonly'],
  calendar: [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
  ],
  sheets: [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
  all: ALL_SCOPES,
};

export async function GET(req: NextRequest) {
  await requireSession();
  const url = new URL(req.url);
  const preset = url.searchParams.get('preset') ?? 'all';
  const requested: string[] = SCOPE_PRESETS[preset] ?? ALL_SCOPES;
  const state = randomBytes(16).toString('hex');
  const cookieStore = await cookies();
  cookieStore.set('g_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600,
  });

  const env = getEnv();
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('include_granted_scopes', 'true');
  auth.searchParams.set('prompt', 'consent');
  auth.searchParams.set('state', state);
  auth.searchParams.set('scope', requested.join(' '));
  return NextResponse.redirect(auth);
}
