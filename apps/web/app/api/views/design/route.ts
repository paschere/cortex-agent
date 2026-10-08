import { isSameOrigin } from '@/lib/activations/request';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { designInput } from '@/lib/views/design';
import { runViewDesign } from '@/lib/views/design-run';
import { checkMeter, consumeToken, isRefused } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Diseñar o cambiar una vista a partir de una frase. Devuelve un BORRADOR con
 * su vista previa ya calculada; no guarda nada (ver lib/views/design.ts).
 *
 * Cuenta como una respuesta del plan, igual que diseñar una activación: es una
 * llamada al modelo que la persona pidió.
 */

export const runtime = 'nodejs';
export const maxDuration = 90;

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req))
    return NextResponse.json({ error: 'Origen de solicitud inválido.' }, { status: 403 });
  const user = await requireSession();
  const parsed = designInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Describe la vista en entre 4 y 4.000 caracteres.' },
      { status: 400 },
    );
  const db = getOrgScopedClient(user.organization.id);

  try {
    await consumeToken(db, user.id, 'views.design', 4);
    if (isRefused(await checkMeter(db, 'answers')))
      return NextResponse.json(
        { error: 'No quedan respuestas disponibles en el plan.' },
        { status: 429 },
      );

    const outcome = await runViewDesign(
      db,
      { id: user.id, organizationName: user.organization.name },
      parsed.data,
      req.signal,
    );
    if (outcome.status === 'not_found')
      return NextResponse.json({ error: 'Esa vista ya no existe.' }, { status: 404 });
    return NextResponse.json(outcome);
  } catch (error) {
    if (error instanceof Error && error.name === 'RateLimitError')
      return NextResponse.json({ error: 'Vas muy rápido. Espera un momento.' }, { status: 429 });
    return NextResponse.json(
      { error: 'No se pudo diseñar la vista. Vuelve a intentarlo en un momento.' },
      { status: 503 },
    );
  }
}
