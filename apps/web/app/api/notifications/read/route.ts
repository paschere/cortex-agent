import { pool } from '@/lib/auth';
import { requireNotificationAccount } from '@/lib/notifications/account';
import { markAllGlobalRead, markGlobalRead } from '@/lib/notifications/global-repository';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Marcar leído: unos cuantos, o toda la bandeja.
 *
 * `nullish()` Y NUNCA `optional()`. `JSON.stringify` serializa el `null` y omite
 * el `undefined`, así que un cliente que arma el cuerpo con
 * `{ ids: seleccionados ?? null }` manda `"ids": null` — que `optional()`
 * rechaza con un 400 mientras el mismo código en TypeScript compila
 * perfectamente. En este repositorio esa diferencia exacta ya rompió una
 * pantalla entera.
 *
 * NO HAY `userId` EN EL CUERPO, a propósito. La persona sale de la sesión y se
 * pone en el `where` de la actualización, así que un id de otra persona no
 * marca nada: no es que se rechace, es que no encaja con ninguna fila.
 */
const Body = z.object({
  targets: z
    .array(
      z.object({
        id: z.string().uuid(),
        organizationId: z.string().min(1).max(200),
      }),
    )
    .max(200)
    .nullish(),
  all: z.boolean().nullish(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const account = await requireNotificationAccount();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Dime qué avisos marcar: una lista de identificadores, o `all: true`.' },
      { status: 400 },
    );
  }

  if (parsed.data.all) {
    const marked = await markAllGlobalRead(pool, account.id);
    return NextResponse.json({ marked });
  }

  const targets = parsed.data.targets ?? [];
  if (targets.length === 0) {
    return NextResponse.json(
      { error: 'No nombraste ningún aviso. Manda `ids` o `all: true`.' },
      { status: 400 },
    );
  }

  const marked = await markGlobalRead(pool, account.id, targets);
  return NextResponse.json({ marked });
}
