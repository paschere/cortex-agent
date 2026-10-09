import { pool } from '@/lib/auth';
import { decideAutopilotItem } from '@/lib/autopilot/server';
import { requireNotificationAccount } from '@/lib/notifications/account';
import { runNotificationAction } from '@/lib/notifications/action';
import { findNotificationActions, markGlobalRead } from '@/lib/notifications/global-repository';
import { logger } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * El botón de un aviso («Hacerlo», «Descartar»).
 *
 * El cuerpo dice QUÉ aviso y QUÉ botón (su posición), nunca qué herramienta ni
 * qué persona: los botones salen de la fila del aviso, y la persona de la
 * sesión + la membresía de la empresa. Ver `lib/notifications/action.ts`.
 */
const Body = z.object({
  notificationId: z.string().uuid(),
  organizationId: z.string().min(1).max(200),
  index: z.number().int().min(0).max(2),
  decision: z.enum(['approve', 'dismiss']),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const account = await requireNotificationAccount();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ ok: false, note: 'Petición no válida.' }, { status: 400 });
  try {
    const out = await runNotificationAction(
      {
        find: (baUserId, target) => findNotificationActions(pool, baUserId, target),
        decide: decideAutopilotItem,
        markRead: async (baUserId, target) => {
          await markGlobalRead(pool, baUserId, [target]);
        },
      },
      { baUserId: account.id, ...parsed.data },
    );
    if (out.ok) revalidatePath('/piloto');
    return NextResponse.json({ ok: out.ok, note: out.note }, { status: out.httpStatus });
  } catch (err) {
    logger.error('notifications: el botón de un aviso falló', { err });
    return NextResponse.json(
      { ok: false, note: 'No pude hacerlo. Intenta de nuevo.' },
      { status: 500 },
    );
  }
}
