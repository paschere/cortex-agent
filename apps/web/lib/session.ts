import 'server-only';
import { type Role, type SessionUser, UnauthorizedError } from '@cortex/core';
import { cookies, headers } from 'next/headers';
import { auth } from './auth';
import { resolveActiveOrganization } from './organization';
import { getSupabaseServiceClient } from './supabase/service';
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
 * This function is one of the few places allowed to hold a raw service-role
 * client: it runs before a workspace is known and is what determines it.
 * Everything downstream gets `getOrgScopedClient(user.organization.id)`.
 */
export async function requireSession(): Promise<SessionUser> {
  const session = await auth.api.getSession({ headers: await headers() });
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
  const organization = await resolveActiveOrganization(
    session.user.id,
    (session.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId,
    session.user.name ?? null,
    session.user.email,
    preferredName,
  );

  const sb = getSupabaseServiceClient();
  const findRow = async () =>
    (
      await sb
        .from('users')
        .select('id,email,name,role')
        .eq('organization_id', organization.id)
        .eq('email', session.user.email)
        .maybeSingle()
    ).data;

  let row = await findRow();

  if (!row) {
    // No directory row in this workspace yet. Two ways to get here: an account
    // that has just been provisioned, and an existing account opening a
    // workspace it was invited to. Both need a row, and neither is an error.
    //
    // The role comes from the workspace membership rather than from "is this
    // the first user in the table". That old rule made the first person to sign
    // up an admin of a product that had one company; with open signup it made
    // them an admin and everybody after them a permanent member, in workspaces
    // they own.
    const { data: inserted } = await sb
      .from('users')
      .insert({
        organization_id: organization.id,
        email: session.user.email,
        name: session.user.name ?? null,
        role:
          organization.role === 'owner' || organization.role === 'admin' ? 'org_admin' : 'member',
      })
      .select('id,email,name,role')
      .single();

    // A fresh account fires several requests at once and every one of them
    // finds no row; the unique index on (organization_id, lower(email)) lets
    // exactly one INSERT through and the losers read what the winner wrote,
    // rather than failing the page with "unauthorized".
    row = inserted ?? (await findRow());
    if (!row) throw new UnauthorizedError();
  }

  return {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string | null,
    role: row.role as Role,
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
