import { auth } from '@/lib/auth';
import { setActiveOrganization } from '@/lib/organization';
import { requireSession } from '@/lib/session';
import { headers } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

/**
 * Cambiar de espacio de trabajo.
 *
 * TODA LA SEGURIDAD DE ESTA RUTA ESTÁ EN UNA LÍNEA, y conviene decir cuál:
 * `setActiveOrganization` no escribe la sesión hasta haber encontrado una fila
 * de `ba_member` que ate esta cuenta con ese espacio. Sin esa comprobación, un
 * `POST` con el id de una empresa ajena movería la sesión ahí y todo lo de
 * después —`requireSession`, el manejador acotado, cada consulta del producto—
 * trabajaría obedientemente dentro del inquilino equivocado, porque todos ellos
 * confían en que esta pregunta ya se contestó. Es el punto exacto donde una
 * comprobación que falta se convierte en una fuga entre clientes.
 *
 * Devolver 403 y no 404 cuando no hay membresía es deliberado en el otro
 * sentido: el id de un espacio de trabajo no es un secreto —quien lo manda o lo
 * inventó o lo vio en su propia lista— así que no hay nada que ocultar
 * confundiendo «no existe» con «no eres de ahí», y la frase honesta es más útil.
 */
const Body = z.object({ organizationId: z.string().min(1) });

export async function POST(req: NextRequest) {
  await requireSession();
  const session = await auth.api.getSession({ headers: await headers() });
  const baUserId = session?.user?.id;
  if (!baUserId) return NextResponse.json({ error: 'Sin sesión.' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Falta el espacio de trabajo.' }, { status: 400 });
  }

  const moved = await setActiveOrganization(baUserId, parsed.data.organizationId);
  if (!moved) {
    return NextResponse.json({ error: 'No perteneces a ese espacio de trabajo.' }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}
