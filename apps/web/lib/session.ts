import { headers } from 'next/headers';
import { auth } from './auth';
import { getSupabaseServiceClient } from './supabase/service';
import { UnauthorizedError, type Role, type SessionUser } from '@zipdev/core';

export async function requireSession(): Promise<SessionUser> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new UnauthorizedError();

  const sb = getSupabaseServiceClient();
  const { data: row, error } = await sb
    .from('users')
    .select('id,email,name,role')
    .eq('email', session.user.email)
    .single();

  if (error || !row) throw new UnauthorizedError();

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
