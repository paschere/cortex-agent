import 'server-only';
import { auth } from '@/lib/auth';
import { UnauthorizedError } from '@cortex/core';
import { headers } from 'next/headers';

/** La identidad global; no resuelve ni crea un espacio activo. */
export async function requireNotificationAccount(): Promise<{ id: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new UnauthorizedError();
  return { id: session.user.id };
}
