import { type NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = [
  // The landing page. Safe to list even though every path starts with '/',
  // because isPublic() only matches a prefix at a segment boundary: the root
  // matches itself via `pathname === '/'`, and the nested test becomes
  // `startsWith('//')`, which nothing satisfies. app/page.tsx decides what to
  // render — signed-in visitors are still sent to /chat (or /onboarding) from there.
  '/',
  '/login',
  // SaaS auth surface: signup, password recovery and the post-password 2FA
  // challenge all run without a full session cookie.
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/two-factor',
  '/api/auth',
  '/_next',
  '/favicon.ico',
  // OAuth 2.1 authorization server + discovery for the MCP connector. These
  // endpoints are bearer-only / public metadata; the authorize route enforces
  // its own session check and redirects to /login when needed.
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/api/oauth',
  // The MCP endpoint authenticates with an OAuth bearer token (no better-auth
  // session cookie), so it must bypass the session-cookie redirect. It enforces
  // its own bearer validation and returns 401 + WWW-Authenticate when missing.
  // '/mcp' is the canonical public URL (rewritten to /api/mcp in next.config).
  '/api/mcp',
  '/mcp',
  // Inngest Cloud calls this to sync/invoke functions; it authenticates with
  // the INNGEST_SIGNING_KEY, not a session cookie.
  '/api/inngest',
  // El worker de pg-boss (services/jobs en Railway) ejecuta los trabajos
  // llamando aquí con un bearer JOBS_SECRET comparado en tiempo constante —
  // es un servicio, no un navegador, así que no tiene cookie de sesión. Sin
  // JOBS_SECRET configurado, la ruta responde 404 a todo.
  '/api/jobs/run',
  // Los blobs de app_files se autorizan por su propio token HMAC de vida
  // corta (Deepgram baja el audio desde afuera, sin cookie) — el mismo
  // trato que /api/files/presentation y por la misma razón.
  '/api/files/blob',
  // Google Chat posts events here signed with a Bearer JWT from
  // chat@system.gserviceaccount.com — no session cookie exists. The route
  // verifies that signature itself and rejects anything unsigned.
  '/api/chat-app',
  // Linear POSTs issue events here signed with an HMAC-SHA256
  // `Linear-Signature` header — no session cookie exists. The route verifies
  // that signature against the raw body itself and rejects anything unsigned,
  // stale or unconfigured.
  '/api/webhooks',
  // The WhatsApp bridge (services/whatsapp on Railway) posts here with a
  // shared bearer token compared in constant time — it is a service, not a
  // browser, so it has no session cookie. ONLY the /bridge subtree is public;
  // the screens' own endpoints under /api/whatsapp stay behind the session.
  // Without WHATSAPP_BRIDGE_TOKEN set, every one of these routes refuses.
  '/api/whatsapp/bridge',
  // Brand assets fetched by external services that have no session: Google
  // Chat renders the app avatar from /icon.png, and link unfurls hit these
  // too. They are public images by nature.
  '/icon.png',
  '/apple-icon.png',
  // Los assets 3D de la landing (el humano de partículas del hero). La
  // landing es pública; sin esta línea el GLB rebotaba a /login y el hero
  // caía siempre al respaldo procedural.
  '/models',
  // Presentation PDFs are authorized by their own unguessable, expiring token
  // (the link is opened from Claude/email where no cookie exists — see the
  // route's header comment for the trade-off).
  '/api/files/presentation',
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
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  const cookie = req.headers.get('cookie') ?? '';

  // No session cookie at all → definitely signed out. Redirect early.
  if (!SESSION_COOKIE_RE.test(cookie)) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
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
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const session = (await res.json()) as SessionPayload | null;
      // Definitive answer: the cookie exists but is invalid/expired → sign out.
      if (!session?.user) {
        const url = req.nextUrl.clone();
        url.pathname = '/login';
        url.searchParams.set('next', pathname);
        return NextResponse.redirect(url);
      }
    }
    // Non-OK response → can't conclude; fail open.
  } catch {
    // Timeout / network error → fail open; requireSession() enforces auth.
  }

  return NextResponse.next();
}

/**
 * LO QUE EL NAVEGADOR PIDE ANTES DE QUE HAYA NADIE DENTRO.
 *
 * ===========================================================================
 * EL FALLO QUE ESTO ARREGLA, Y POR QUÉ NO SE VEÍA
 * ===========================================================================
 * Recién desplegada la aplicación instalable, en producción:
 *
 *     GET /manifest.webmanifest  →  307  →  /login?next=%2Fmanifest.webmanifest
 *     GET /icon-512.png          →  307
 *
 * El filtro excluía `_next/static`, `_next/image` y `favicon.ico`, y ninguno de
 * los archivos que hacen que una aplicación se pueda instalar. Consecuencias, y
 * las tres son silenciosas:
 *
 *   NO APARECE EL BOTÓN DE INSTALAR. Un navegador que no puede leer el
 *   manifiesto no ofrece instalar nada, y no dice por qué.
 *
 *   EL SERVICE WORKER NO SE REGISTRA. La especificación prohíbe registrar uno
 *   servido tras una redirección, así que `register('/sw.js')` falla — y falla
 *   dentro del `catch` que se traga el error a propósito, porque un fallo ahí
 *   no debía costarle nada a nadie.
 *
 *   EL ICONO DE APPLE TAMPOCO CARGA, así que en un iPhone quedaría una captura
 *   de la página como icono.
 *
 * El único síntoma de todo eso es un botón que no sale. Nadie reporta eso.
 *
 * ===========================================================================
 * SE ENUMERAN, NO SE COMODINEA
 * ===========================================================================
 * Sería más corto excluir `[^/]+\.png$`. No se hace: este filtro es lo único
 * que hay entre una petición y una pantalla con la cartera de una empresa
 * dentro, y un comodín aquí es un agujero que nadie va a releer. Se nombran los
 * archivos, uno a uno, y `lib/pwa.test.ts` comprueba que TODO lo que el
 * manifiesto declara esté en esta lista — que es lo que impide que el próximo
 * icono nuevo vuelva a caer detrás del login sin que nadie se entere.
 */
/**
 * Y VA TODO EN UNA CADENA LITERAL, AUNQUE SE LEA PEOR.
 *
 * La primera versión sacaba los nombres a una constante y la interpolaba, que
 * es bastante más legible y NO COMPILA: Next lee este `matcher` en tiempo de
 * build SIN EJECUTAR EL MÓDULO, así que un valor calculado le llega vacío y el
 * build muere con «Invalid segment configuration export detected». No hay una
 * forma bonita de escribir esto — hay una que funciona.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|manifest\\.webmanifest|sw\\.js|sin-conexion\\.html|icon\\.svg|icon-192\\.png|icon-512\\.png|icon-maskable-512\\.png|apple-touch-icon\\.png|favicon\\.ico).*)',
  ],
};
