import { NextResponse, type NextRequest } from 'next/server';
import { getOptionalSession } from '@/lib/session';
import {
  getClient,
  isAllowedRedirectUri,
  createAuthCode,
  issuer,
  mcpResource,
  MCP_SCOPE,
} from '@/lib/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * OAuth 2.1 authorization endpoint (authorization_code + PKCE + RFC 8707).
 *
 * GET  — validate the request, require a logged-in @zipdev.com user, render a
 *        minimal consent screen.
 * POST — handle Approve/Deny from that screen: mint a code and 302 back, or
 *        return an access_denied error redirect.
 */

interface AuthParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
  resource: string;
}

function readParams(sp: URLSearchParams): AuthParams {
  return {
    responseType: sp.get('response_type') ?? '',
    clientId: sp.get('client_id') ?? '',
    redirectUri: sp.get('redirect_uri') ?? '',
    codeChallenge: sp.get('code_challenge') ?? '',
    codeChallengeMethod: sp.get('code_challenge_method') ?? '',
    state: sp.get('state') ?? '',
    scope: sp.get('scope') ?? MCP_SCOPE,
    resource: sp.get('resource') ?? '',
  };
}

function badRequest(message: string): NextResponse {
  return new NextResponse(`Invalid authorization request: ${message}`, {
    status: 400,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** Redirect back to the client with an OAuth error (RFC 6749 §4.1.2.1). */
function errorRedirect(
  redirectUri: string,
  error: string,
  state: string,
  description?: string,
): NextResponse {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer());
  return NextResponse.redirect(url);
}

/**
 * Validate everything except the session. Returns either the validated params,
 * or a NextResponse to short-circuit (400 for client/redirect issues, an error
 * redirect for spec violations once redirect_uri is trusted).
 */
async function validate(
  p: AuthParams,
): Promise<{ ok: true; clientName: string } | { ok: false; res: NextResponse }> {
  if (!p.clientId) return { ok: false, res: badRequest('missing client_id') };
  if (!p.redirectUri)
    return { ok: false, res: badRequest('missing redirect_uri') };

  const client = await getClient(p.clientId);
  if (!client) return { ok: false, res: badRequest('unknown client_id') };
  if (!isAllowedRedirectUri(client, p.redirectUri)) {
    return { ok: false, res: badRequest('redirect_uri not registered') };
  }

  // redirect_uri is now trusted: spec violations go back as error redirects.
  if (p.responseType !== 'code') {
    return {
      ok: false,
      res: errorRedirect(
        p.redirectUri,
        'unsupported_response_type',
        p.state,
        'only response_type=code is supported',
      ),
    };
  }
  if (!p.codeChallenge || p.codeChallengeMethod !== 'S256') {
    return {
      ok: false,
      res: errorRedirect(
        p.redirectUri,
        'invalid_request',
        p.state,
        'PKCE with code_challenge_method=S256 is required',
      ),
    };
  }

  return { ok: true, clientName: client.client_name };
}

function consentHtml(p: AuthParams, clientName: string, userEmail: string): string {
  // The original query string is preserved as hidden inputs and re-submitted.
  const fields = [
    ['response_type', p.responseType],
    ['client_id', p.clientId],
    ['redirect_uri', p.redirectUri],
    ['code_challenge', p.codeChallenge],
    ['code_challenge_method', p.codeChallengeMethod],
    ['state', p.state],
    ['scope', p.scope],
    ['resource', p.resource],
  ];
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const hidden = fields
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}" />`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize ${esc(clientName)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #fafafa; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  .card { max-width: 24rem; width: 100%; background: #171717; border: 1px solid #262626; border-radius: 1rem; padding: 2rem; box-sizing: border-box; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: #a3a3a3; font-size: .9rem; line-height: 1.4; }
  .scope { background: #262626; border-radius: .5rem; padding: .5rem .75rem; font-size: .85rem; margin: 1rem 0; }
  .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { flex: 1; padding: .65rem; border-radius: .65rem; font-weight: 600; font-size: .95rem; cursor: pointer; border: 1px solid #262626; }
  .approve { background: #fafafa; color: #0a0a0a; border-color: #fafafa; }
  .deny { background: transparent; color: #fafafa; }
</style>
</head>
<body>
  <div class="card">
    <h1>Authorize ${esc(clientName)}</h1>
    <p><strong>${esc(clientName)}</strong> wants to connect to Zipdev Agent as <strong>${esc(userEmail)}</strong>.</p>
    <div class="scope">Requested access: <code>${esc(p.scope)}</code></div>
    <p>Approving grants ${esc(clientName)} access to the Zipdev Agent MCP tools on your behalf.</p>
    <form method="POST" action="/api/oauth/authorize">
      ${hidden}
      <div class="actions">
        <button class="deny" type="submit" name="decision" value="deny">Deny</button>
        <button class="approve" type="submit" name="decision" value="approve">Approve</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const p = readParams(url.searchParams);

  const v = await validate(p);
  if (!v.ok) return v.res;

  const session = await getOptionalSession();
  if (!session) {
    // Send the user through login, returning to this exact authorize URL.
    const next = url.pathname + url.search;
    const login = new URL('/login', issuer());
    login.searchParams.set('next', next);
    return NextResponse.redirect(login);
  }

  return new NextResponse(consentHtml(p, v.clientName, session.email), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const sp = new URLSearchParams();
  for (const [k, val] of form.entries()) {
    if (typeof val === 'string') sp.set(k, val);
  }
  const p = readParams(sp);
  const decision = sp.get('decision');

  const v = await validate(p);
  if (!v.ok) return v.res;

  const session = await getOptionalSession();
  if (!session) {
    // Session expired between render and submit — bounce through login.
    const next = `/api/oauth/authorize?${sp.toString()}`;
    const login = new URL('/login', issuer());
    login.searchParams.set('next', next);
    return NextResponse.redirect(login);
  }

  if (decision !== 'approve') {
    return errorRedirect(
      p.redirectUri,
      'access_denied',
      p.state,
      'The user denied the authorization request',
    );
  }

  const code = await createAuthCode({
    clientId: p.clientId,
    userId: session.id,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    codeChallengeMethod: p.codeChallengeMethod,
    scope: p.scope || MCP_SCOPE,
    resource: p.resource || mcpResource(),
  });

  const redirect = new URL(p.redirectUri);
  redirect.searchParams.set('code', code);
  if (p.state) redirect.searchParams.set('state', p.state);
  redirect.searchParams.set('iss', issuer());
  return NextResponse.redirect(redirect);
}
