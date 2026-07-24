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
  // 303: the consent screen submits via POST; the client's callback only
  // accepts GET. Default redirect (307) preserves POST → 405 at claude.ai.
  return NextResponse.redirect(url, 303);
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
  const fields: [string, string][] = [
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
<title>Connect ${esc(clientName)} · Zippy</title>
<link rel="icon" href="/icon.png" />
<style>
  :root {
    --plum: #9658A3;
    --accent: #7E4390;
    --ink: #241A2E;
    --ink-soft: #5C4E68;
    --line: #E6DDEE;
    --chip: #F3EBF8;
  }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    background: linear-gradient(180deg, #FAF8FC 0%, #F3EBF8 100%);
    color: var(--ink);
    display: flex; min-height: 100vh; align-items: center; justify-content: center;
    margin: 0; padding: 24px;
  }
  .card {
    max-width: 26rem; width: 100%;
    background: #ffffff;
    border: 1px solid var(--line);
    border-radius: 20px;
    padding: 2.25rem 2rem 2rem;
    box-shadow: 0 20px 60px -30px rgba(60, 20, 80, .28);
    text-align: center;
  }
  .logos {
    display: flex; align-items: center; justify-content: center; gap: 18px;
    margin-bottom: 1.5rem;
  }
  .logos .zippy {
    width: 64px; height: 64px; border-radius: 18px;
    box-shadow: 0 8px 22px -8px rgba(120, 60, 160, .45);
  }
  .logos .link {
    color: var(--plum); font-size: 22px; letter-spacing: 2px; user-select: none;
  }
  .logos .client {
    width: 64px; height: 64px; border-radius: 18px;
    display: grid; place-items: center;
    background: var(--chip); border: 1px solid var(--line);
    font-weight: 800; font-size: 24px; color: var(--accent);
  }
  h1 { font-size: 1.2rem; margin: 0 0 .35rem; letter-spacing: -.01em; }
  .sub { color: var(--ink-soft); font-size: .88rem; line-height: 1.5; margin: 0; }
  .sub strong { color: var(--ink); }
  .grants {
    text-align: left; margin: 1.4rem 0; padding: .9rem 1rem;
    background: var(--chip); border-radius: 14px;
    font-size: .84rem; color: var(--ink-soft); line-height: 1.65;
  }
  .grants li { margin-left: 1.1rem; }
  .grants b { color: var(--ink); }
  .actions { display: flex; gap: .75rem; margin-top: 1.4rem; }
  button {
    flex: 1; padding: .72rem; border-radius: 12px;
    font-weight: 700; font-size: .95rem; cursor: pointer;
    border: 1px solid var(--line); transition: filter .15s ease;
  }
  button:hover { filter: brightness(.96); }
  .approve { background: var(--accent); color: #fff; border-color: var(--accent); }
  .deny { background: #fff; color: var(--ink-soft); }
  .foot {
    margin-top: 1.5rem; padding-top: 1.1rem; border-top: 1px solid var(--line);
    display: flex; align-items: center; justify-content: center; gap: 8px;
    font-size: .72rem; color: var(--ink-soft);
  }
  .foot img { height: 16px; width: auto; display: block; }
</style>
</head>
<body>
  <div class="card">
    <div class="logos">
      <img class="zippy" src="/icon.png" alt="Zippy" />
      <span class="link">⇄</span>
      <span class="client" aria-hidden="true">${esc((clientName[0] ?? 'C').toUpperCase())}</span>
    </div>
    <h1>Connect ${esc(clientName)} to Zippy</h1>
    <p class="sub">Signed in as <strong>${esc(userEmail)}</strong></p>
    <div class="grants">
      Approving lets <b>${esc(clientName)}</b> use Zippy on your behalf:
      <li>Your access, your permissions — nothing more</li>
      <li>Writes always ask you before executing</li>
      <li>Every action is logged in Zipdev</li>
    </div>
    <form method="POST" action="/api/oauth/authorize">
      ${hidden}
      <div class="actions">
        <button class="deny" type="submit" name="decision" value="deny">Deny</button>
        <button class="approve" type="submit" name="decision" value="approve">Approve</button>
      </div>
    </form>
    <div class="foot">
      <img src="/zipdev-logo.png" alt="Zipdev" />
      <span>· Zippy — Zipdev's super-agent</span>
    </div>
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
    return NextResponse.redirect(login, 303);
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
  // 303 (not the 307 default): browsers must follow with GET — claude.ai's
  // auth_callback rejects POST with 405.
  return NextResponse.redirect(redirect, 303);
}
