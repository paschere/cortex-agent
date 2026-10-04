import 'server-only';
import type { SessionUser } from '@cortex/core';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '../auth';
import { requireSession } from '../session';

/**
 * La puerta común de las rutas que administran invitaciones.
 *
 * Son las mismas tres comprobaciones que ya hacía `POST /api/team/invite`, y las
 * rutas nuevas (listar pendientes, reenviar) las necesitan idénticas: una
 * comprobación copiada tres veces es una que se arregla en dos. Devuelve la
 * persona o la respuesta de rechazo ya armada.
 *
 *   - espacio personal: es privado, no se invita a nadie;
 *   - `role !== 'org_admin'`: sólo quien administra invita (el rol del
 *     directorio, derivado de `ba_member`; mismo criterio que el selector de espacio);
 *   - sin cuenta de better-auth en la sesión: no hay quién firme la invitación.
 */
export async function requireInviter(): Promise<
  { ok: true; user: SessionUser; accountId: string } | { ok: false; response: NextResponse }
> {
  const user = await requireSession();
  if (user.organization.kind === 'personal') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Tu espacio personal es privado. Crea una empresa para invitar a tu equipo.' },
        { status: 403 },
      ),
    };
  }
  if (user.role !== 'org_admin') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Solo quien administra el espacio puede invitar.' },
        { status: 403 },
      ),
    };
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Tu sesión venció. Vuelve a entrar.' }, { status: 401 }),
    };
  }
  return { ok: true, user, accountId: session.user.id };
}
