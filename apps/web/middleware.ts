import { type NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = [
  "/login",
  // SaaS auth surface: signup, password recovery and the post-password 2FA
  // challenge all run without a full session cookie.
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/two-factor",
  "/api/auth",
  "/_next",
  "/favicon.ico",
  // OAuth 2.1 authorization server + discovery for the MCP connector. These
  // endpoints are bearer-only / public metadata; the authorize route enforces
  // its own session check and redirects to /login when needed.
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/api/oauth",
  // The MCP endpoint authenticates with an OAuth bearer token (no better-auth
  // session cookie), so it must bypass the session-cookie redirect. It enforces
  // its own bearer validation and returns 401 + WWW-Authenticate when missing.
  // '/mcp' is the canonical public URL (rewritten to /api/mcp in next.config).
  "/api/mcp",
  "/mcp",
  // Inngest Cloud calls this to sync/invoke functions; it authenticates with
  // the INNGEST_SIGNING_KEY, not a session cookie.
  "/api/inngest",
  // Google Chat posts events here signed with a Bearer JWT from
  // chat@system.gserviceaccount.com — no session cookie exists. The route
  // verifies that signature itself and rejects anything unsigned.
  "/api/chat-app",
  // Linear POSTs issue events here signed with an HMAC-SHA256
  // `Linear-Signature` header — no session cookie exists. The route verifies
  // that signature against the raw body itself and rejects anything unsigned,
  // stale or unconfigured.
  "/api/webhooks",
  // Brand assets fetched by external services that have no session: Google
  // Chat renders the app avatar from /icon.png, and link unfurls hit these
  // too. They are public images by nature.
  "/icon.png",
  "/apple-icon.png",
  // Presentation PDFs are authorized by their own unguessable, expiring token
  // (the link is opened from Claude/email where no cookie exists — see the
  // route's header comment for the trade-off).
  "/api/files/presentation",
];

interface SessionPayload {
  user?: { id: string; email: string };
}

// better-auth names the session cookie `better-auth.session_token`
// (prefixed with `__Secure-` when served over https).
const SESSION_COOKIE_RE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

/**
 * A public path matches itself and anything nested under it — but only at a
 * SEGMENT boundary. Plain `startsWith` made `/mcp` swallow `/mcp-tokens`, which
 * then skipped the session check entirely and rendered the authenticated layout
 * with no user: a 500 for signed-out visitors instead of a redirect to /login.
 * Any future `/mcp…` or `/login…` route would have inherited the same hole.
 */
function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  const cookie = req.headers.get("cookie") ?? "";

  // No session cookie at all → definitely signed out. Redirect early.
  if (!SESSION_COOKIE_RE.test(cookie)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // A cookie is present. Validate it, but FAIL OPEN: if the check is slow,
  // errors, or times out (common during dev cold-compiles), let the request
  // through. Every protected page/route also calls requireSession() server-side,
  // which is the real gate — so failing open here can't leak data, it only
  // avoids bouncing a validly-signed-in user to /login on a transient hiccup.
  try {
    const res = await fetch(`${req.nextUrl.origin}/api/auth/get-session`, {
      headers: { cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const session = (await res.json()) as SessionPayload | null;
      // Definitive answer: the cookie exists but is invalid/expired → sign out.
      if (!session?.user) {
        const url = req.nextUrl.clone();
        url.pathname = "/login";
        url.searchParams.set("next", pathname);
        return NextResponse.redirect(url);
      }
    }
    // Non-OK response → can't conclude; fail open.
  } catch {
    // Timeout / network error → fail open; requireSession() enforces auth.
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
