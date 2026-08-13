import { countUnread } from '@/lib/notifications/repository';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * El número de la campana, y nada más.
 *
 * Aparte de `GET /api/notifications` porque lo pide la barra superior de TODAS
 * las pantallas del producto y no debe traerse sesenta filas para pintar un
 * punto. `countUnread` se traga su propio error y devuelve 0 — la excepción
 * argumentada en `lib/nav-signals.ts`: un badge caído no puede tumbar la
 * navegación. El CONTENIDO de la bandeja no hace eso y falla a gritos.
 */
export async function GET(): Promise<NextResponse> {
  const user = await requireSession();
  const unread = await countUnread(getOrgScopedClient(user.organization.id), user.id);
  return NextResponse.json({ unread });
}
