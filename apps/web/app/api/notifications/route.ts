import { listNotifications } from '@/lib/notifications/repository';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * La bandeja de quien pregunta.
 *
 * No hay parámetro de persona ni de espacio de trabajo, y no puede haberlo: los
 * dos salen de la sesión. La pantalla se pinta en el servidor, así que esta ruta
 * existe sólo para el refresco desde el cliente después de marcar algo.
 *
 * Si la base falla, esto revienta con un 500 y la pantalla lo dice. Es
 * contenido, y una bandeja vacía y una bandeja rota se ven idénticas.
 */
export async function GET(): Promise<NextResponse> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const notifications = await listNotifications(db, user.id);
  return NextResponse.json({
    notifications,
    unread: notifications.filter((n) => n.readAt === null).length,
  });
}
