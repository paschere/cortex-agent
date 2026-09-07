import 'server-only';
import { type SessionUser, UnauthorizedError } from '@cortex/core';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from './auth';
import { resolveActiveOrganization } from './organization';
import { resolveSessionDirectory } from './session-directory';
import { canonicalWorkspaceLocation, requestWorkspaceId } from './workspace-context';
import { WORKSPACE_NAME_COOKIE } from './workspace-cookie';

/**
 * Who is asking, and which workspace they are asking inside.
 *
 * ORDER MATTERS HERE, and it is the reverse of what it used to be. The
 * workspace is resolved FIRST, and only then the `public.users` row, because
 * since migration 0064 that row is per-workspace: one human who belongs to two
 * companies has two directory rows, with two ids, two roles and two sets of
 * conversations. Looking the row up by email alone — as this did — would return
 * whichever one Postgres felt like and file the request under the wrong tenant.
 *
 * The directory is resolved with one membership-gated SQL upsert. This avoids
 * a cached missing-row read during concurrent first visits. Downstream queries
 * use `getOrgScopedClient(user.organization.id)`.
 */
export async function requireSession(): Promise<SessionUser> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) throw new UnauthorizedError();

  // SaaS default: open signup, so an unset OR empty ALLOWED_EMAIL_DOMAIN must
  // let everyone through. `?? 'Cortex.com'` did the opposite twice over: unset
  // locked the product to one company, and the empty string that .env.example
  // ships (`ALLOWED_EMAIL_DOMAIN=`) is not nullish, so `allowed` became '' and
  // no address could ever match it — every user, including the owner, was
  // rejected. Trim + truthiness check, mirroring the guard in lib/auth.ts.
  const allowed = (process.env.ALLOWED_EMAIL_DOMAIN ?? '').trim().toLowerCase();
  if (allowed) {
    const emailDomain = session.user.email.split('@')[1]?.toLowerCase();
    if (emailDomain !== allowed) throw new UnauthorizedError();
  }

  // The workspace this request acts in. Provisioned on demand, so an account
  // that predates multi-tenancy (or one created straight in the DB) still gets
  // a tenant on its next request instead of rendering a workspace-less app.
  //
  // The cookie carries the company name typed on the signup screen, one
  // navigation earlier — see WORKSPACE_NAME_COOKIE. It is read here because this
  // is the request that provisions, it is used for nothing but the workspace's
  // TITLE, and it is ignored entirely on every request where a workspace already
  // exists. `cookies()` costs nothing extra: this function is already dynamic
  // through `headers()`.
  const preferredName = (await cookies()).get(WORKSPACE_NAME_COOKIE)?.value ?? null;
  const resolution = await resolveActiveOrganization(
    session.user.id,
    (session.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId,
    session.user.name ?? null,
    session.user.email,
    preferredName,
    requestWorkspaceId(requestHeaders),
  );

  /**
   * QUIEN LLEGA INVITADO NO TIENE ESPACIO TODAVÍA, Y ESO NO ES UN ERROR.
   *
   * Antes se le fabricaba uno vacío aquí mismo y aterrizaba dentro, con la
   * empresa que le invitó invisible. Ahora se le manda a aceptar, que es a donde
   * iba.
   *
   * Se usa `redirect()` y NO una excepción capturada: `redirect` lanza un error
   * que Next entiende y propaga solo, así que `app/(app)/layout.tsx` sigue sin
   * envolver esta llamada en un try/catch — que es exactamente lo que su
   * comentario pide, porque capturarla hizo que Next intentara prerenderizar
   * páginas que sólo existen en tiempo de ejecución.
   */
  if (resolution.kind === 'pending-invitation') {
    redirect(`/accept-invitation/${resolution.invitationId}`);
  }
  if (resolution.kind === 'forbidden-workspace') throw new UnauthorizedError();
  const organization = resolution.workspace;
  const canonical = canonicalWorkspaceLocation(requestHeaders, organization.id);
  if (canonical) redirect(canonical);

  const row = await resolveSessionDirectory(session.user.id, organization.id);
  if (!row) throw new UnauthorizedError();

  return {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string | null,
    role: row.role,
    organization,
  };
}

export async function getOptionalSession(): Promise<SessionUser | null> {
  try {
    return await requireSession();
  } catch {
    return null;
  }
}
