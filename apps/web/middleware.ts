import { type NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/api/auth', '/_next', '/favicon.ico'];

interface SessionPayload {
  user?: { id: string; email: string };
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Native fetch against our own /api/auth/get-session endpoint. We avoid
  // calling better-auth APIs directly here because middleware runs in the
  // Edge runtime where the `pg` Pool used by lib/auth.ts is not available.
  let session: SessionPayload | null = null;
  try {
    const res = await fetch(`${req.nextUrl.origin}/api/auth/get-session`, {
      headers: { cookie: req.headers.get('cookie') ?? '' },
      cache: 'no-store',
    });
    if (res.ok) {
      session = (await res.json()) as SessionPayload;
    }
  } catch {
    session = null;
  }

  if (!session?.user) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
