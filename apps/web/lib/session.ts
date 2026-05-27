import 'server-only';
import { headers } from 'next/headers';
import { auth } from './auth';
import { getSupabaseServiceClient } from './supabase/service';
import { UnauthorizedError, type Role, type SessionUser } from '@zipdev/core';

export async function requireSession(): Promise<SessionUser> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new UnauthorizedError();

  const allowed = (process.env.ALLOWED_EMAIL_DOMAIN ?? 'zipdev.com').toLowerCase();
  const emailDomain = session.user.email.split('@')[1]?.toLowerCase();
  if (emailDomain !== allowed) throw new UnauthorizedError();

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

  return {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string | null,
    role: row.role as Role,
  };
}

export async function getOptionalSession(): Promise<SessionUser | null> {
  try {
    return await requireSession();
  } catch {
    return null;
  }
}
