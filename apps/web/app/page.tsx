import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Landing } from './_landing/Landing';
import './_landing/landing.css';
import { getOptionalSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { readOnboarding } from '@cortex/agent-tools';

/**
 * `/` is two things depending on who is knocking.
 *
 * It used to be an unconditional `redirect('/dashboard')`, which worked because
 * the middleware never let a signed-out visitor reach it: no session cookie
 * meant a bounce to `/login?next=/`. That is exactly the behaviour a public page
 * cannot have, so `/` is now listed in the middleware's PUBLIC_PATHS — one line,
 * and safe there because `isPublic` matches a prefix only at a segment boundary
 * (`pathname === '/'` or `startsWith('//')`), so adding the root does not turn
 * the rest of the app public.
 *
 * That moves the decision here, where it belongs:
 *
 *   signed in  → /chat, unless the workspace still has the first-run guide
 *                open (`readOnboarding().show`), in which case /onboarding.
 *                The login screen's `next` parameter defaults to '/', so this
 *                is the hop that lands somebody on the product after signing
 *                in, and it must keep working.
 *   signed out → the landing.
 *
 * WHY THE COOKIE IS CHECKED FIRST. `getOptionalSession()` is the honest answer
 * to "is there a session", but for an anonymous visitor — which is every visitor
 * this page was written for — it is work with a foregone conclusion: it calls
 * better-auth, and on the way through `requireSession` it can provision a
 * workspace and read the directory row. Nobody arriving from a search result has
 * any of that. The presence of better-auth's cookie is the cheap precondition:
 * without it there is definitively no session, and the landing renders having
 * touched nothing. With it, the real check runs and decides — a stale or expired
 * cookie still falls through to the landing rather than bouncing the visitor
 * into a redirect loop.
 *
 * The page is dynamic either way, because reading cookies makes it so. That is
 * the cost of one page serving two audiences, and it is small: the landing is
 * static markup with no data fetching, no remote asset and one small client
 * component.
 */

export const metadata: Metadata = {
  title: 'Cortex — pregúntale a tu empresa',
  description:
    'Cortex ya leyó los correos, los contratos, las reuniones y los grupos de WhatsApp de tu empresa. Preguntas en español y contesta citando de dónde salió: el documento, el día y el minuto.',
};

// better-auth names the session cookie `better-auth.session_token`, prefixed
// with `__Secure-` when served over https. Same shape the middleware matches.
const SESSION_COOKIE = /^(?:__Secure-)?better-auth\.session_token$/;

export default async function RootPage() {
  const jar = await cookies();
  const maybeSignedIn = jar.getAll().some((c) => SESSION_COOKIE.test(c.name));

  if (maybeSignedIn) {
    const session = await getOptionalSession();
    if (session) {
      const onboarding = await readOnboarding(getOrgScopedClient(session.organization.id));
      redirect(onboarding.show ? '/onboarding' : '/chat');
    }
  }

  return <Landing />;
}
