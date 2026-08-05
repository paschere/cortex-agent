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
 * GET  — validate the request, require a logged-in workspace user, render a
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
  // Plain text a person may land on: the detail stays in protocol terms, the
  // frame tells them what to do about it.
  const body = `La solicitud de autorización no es válida: ${message}. Vuelve a iniciar la conexión desde tu cliente; si sigue igual, avísale al equipo de Cortex.`;
  return new NextResponse(body, {
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
  if (!p.redirectUri) return { ok: false, res: badRequest('missing redirect_uri') };

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
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Conectar ${esc(clientName)} · Cortex</title>
<link rel="icon" href="/icon.png" />
<style>
  /*
   * Hand-written twin of the product's tokens: this route returns loose HTML,
   * so Tailwind never reaches it. Values mirror apps/web/app/globals.css —
   * keep them in step if the palette moves.
   */
  :root {
    --primary: 88 80 236;
    --primary-strong: 71 62 214;
    --primary-soft: 240 239 254;
    --primary-ink: 62 53 199;
    --ink: 24 26 39;
    --ink-muted: 99 104 128;
    --ink-faint: 142 147 170;
    --canvas: 249 250 253;
    --surface: 255 255 255;
    --border: 231 233 241;
    --border-strong: 213 216 229;
    --radius: 14px;
    --radius-sm: 10px;
    --shadow-card: 0 1px 2px rgb(24 26 39 / 0.04), 0 4px 12px -4px rgb(24 26 39 / 0.06);
    --shadow-pop: 0 4px 12px -2px rgb(24 26 39 / 0.08), 0 16px 32px -12px rgb(62 53 199 / 0.22);
  }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    background: rgb(var(--canvas));
    color: rgb(var(--ink));
    display: flex; min-height: 100vh; align-items: center; justify-content: center;
    margin: 0; padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    max-width: 26rem; width: 100%;
    background: rgb(var(--surface));
    border: 1px solid rgb(var(--border));
    border-radius: var(--radius);
    padding: 2.25rem 2rem 2rem;
    box-shadow: var(--shadow-pop);
    text-align: center;
  }
  .logos {
    display: flex; align-items: center; justify-content: center; gap: 18px;
    margin-bottom: 1.5rem;
  }
  .logos .cortex {
    width: 64px; height: 64px; border-radius: var(--radius);
    box-shadow: var(--shadow-pop);
  }
  .logos .link {
    color: rgb(var(--primary)); font-size: 22px; letter-spacing: 2px; user-select: none;
  }
  .logos .client {
    width: 64px; height: 64px; border-radius: var(--radius);
    display: grid; place-items: center;
    background: rgb(var(--primary-soft)); border: 1px solid rgb(var(--primary) / 0.14);
    font-weight: 800; font-size: 24px; color: rgb(var(--primary-ink));
  }
  h1 { font-size: 1.2rem; margin: 0 0 .35rem; letter-spacing: -.01em; }
  .sub { color: rgb(var(--ink-muted)); font-size: .88rem; line-height: 1.5; margin: 0; }
  .sub strong { color: rgb(var(--ink)); }
  .grants {
    text-align: left; margin: 1.4rem 0; padding: .9rem 1rem;
    background: rgb(var(--canvas)); border: 1px solid rgb(var(--border));
    border-radius: var(--radius);
    font-size: .84rem; color: rgb(var(--ink-muted)); line-height: 1.65;
  }
  .grants ul { margin: .5rem 0 0; padding-left: 1.1rem; }
  .grants b { color: rgb(var(--ink)); }
  .actions { display: flex; gap: .75rem; margin-top: 1.4rem; }
  button {
    flex: 1; padding: .72rem; border-radius: 999px;
    font: inherit; font-weight: 700; font-size: .95rem; cursor: pointer;
    border: 1px solid rgb(var(--border-strong));
    transition: transform .15s ease, background-color .15s ease, box-shadow .15s ease;
  }
  button:hover { transform: translateY(-1px); }
  button:focus-visible { outline: 2px solid rgb(var(--primary)); outline-offset: 2px; }
  .approve {
    background: rgb(var(--primary)); color: #fff;
    border-color: rgb(var(--primary)); box-shadow: var(--shadow-pop);
  }
  .approve:hover { background: rgb(var(--primary-strong)); }
  .deny {
    background: rgb(var(--surface)); color: rgb(var(--ink-muted));
    box-shadow: var(--shadow-card);
  }
  .deny:hover { background: rgb(var(--canvas)); color: rgb(var(--ink)); }
  .foot {
    margin-top: 1.5rem; padding-top: 1.1rem; border-top: 1px solid rgb(var(--border));
    display: flex; align-items: center; justify-content: center; gap: 8px;
    font-size: .72rem; color: rgb(var(--ink-faint));
  }
  .foot img { height: 16px; width: auto; display: block; }
  @media (prefers-reduced-motion: reduce) {
    button { transition: none; }
    button:hover { transform: none; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="logos">
      <img class="cortex" src="/icon.png" alt="Cortex" />
      <span class="link">⇄</span>
      <span class="client" aria-hidden="true">${esc((clientName[0] ?? 'C').toUpperCase())}</span>
    </div>
    <h1>Conectar ${esc(clientName)} con Cortex</h1>
    <p class="sub">Entraste como <strong>${esc(userEmail)}</strong></p>
    <div class="grants">
      Si apruebas, <b>${esc(clientName)}</b> va a poder usar Cortex en tu nombre:
      <ul>
        <li>Con tu acceso y tus permisos, nada más</li>
        <li>Todo lo que escriba te lo pregunta antes</li>
        <li>Cada acción queda registrada en Cortex</li>
      </ul>
    </div>
    <form method="POST" action="/api/oauth/authorize">
      ${hidden}
      <div class="actions">
        <button class="deny" type="submit" name="decision" value="deny">Rechazar</button>
        <button class="approve" type="submit" name="decision" value="approve">Aprobar</button>
      </div>
    </form>
    <div class="foot">
      <img src="/icon.png" alt="Cortex" />
      <span>· Cortex — el cerebro de tu operación</span>
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
