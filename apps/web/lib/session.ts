import 'server-only';
import { type Role, type SessionUser, UnauthorizedError } from '@cortex/core';
import { headers } from 'next/headers';
import { auth } from './auth';
import { resolveActiveOrganization } from './organization';
import { getSupabaseServiceClient } from './supabase/service';

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

  const sb = getSupabaseServiceClient();
  let { data: row, error } = await sb
    .from('users')
    .select('id,email,name,role')
    .eq('email', session.user.email)
    .single();

  if (error || !row) {
    // Back-fill missing public.users row (recovery path for after-hook failures).
    const isFirstUser = await sb
      .from('users')
      .select('id', { count: 'exact', head: true })
      .then((r) => (r.count ?? 0) === 0);

    const { data: inserted, error: insErr } = await sb
      .from('users')
      .insert({
        email: session.user.email,
        name: session.user.name ?? null,
        role: isFirstUser ? 'org_admin' : 'member',
      })
      .select('id,email,name,role')
      .single();

    if (insErr || !inserted) throw new UnauthorizedError();
    row = inserted;
  }

  // The workspace this request acts in. Provisioned on demand, so an account
  // that predates multi-tenancy (or one created straight in the DB) still gets
  // a tenant on its next request instead of rendering a workspace-less app.
  const organization = await resolveActiveOrganization(
    session.user.id,
    (session.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId,
    session.user.name ?? null,
    session.user.email,
  );

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
