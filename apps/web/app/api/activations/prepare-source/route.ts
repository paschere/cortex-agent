import { prepareSourceView } from '@/lib/activations/prepare';
import { isSameOrigin } from '@/lib/activations/request';
import {
  ActivationError,
  readOwnedTableSources,
  textSourceSnapshot,
} from '@/lib/activations/service';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { checkMeter, consumeToken, isRefused } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 90;

const Body = z.object({
  sourceId: z.string().uuid(),
  prompt: z.string().trim().min(8).max(1000),
});

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req))
    return NextResponse.json({ error: 'Origen de solicitud inválido.' }, { status: 403 });
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'Describe qué datos necesitas extraer.' }, { status: 400 });
  const db = getOrgScopedClient(user.organization.id);
  try {
    await consumeToken(db, user.id, 'activations.prepare_source', 3);
    if (isRefused(await checkMeter(db, 'answers')))
      return NextResponse.json(
        { error: 'No quedan respuestas disponibles en el plan.' },
        { status: 429 },
      );
    const sources = await readOwnedTableSources(db, user.id);
    const source = sources.find((item) => item.id === parsed.data.sourceId);
    if (!source)
      return NextResponse.json(
        { error: 'La fuente no existe, venció o pertenece a otra persona.' },
        { status: 404 },
      );
    const before = textSourceSnapshot(source);
    const response = await prepareSourceView(db, user.id, source, parsed.data.prompt, req.signal, {
      beforeSave: async () => {
        const currentUser = await requireSession();
        if (currentUser.id !== user.id || currentUser.organization.id !== user.organization.id)
          throw new ActivationError('El espacio cambió. Prepara nuevamente la fuente.', 409);
        const latest = (await readOwnedTableSources(db, user.id)).find(
          (item) => item.id === source.id,
        );
        if (!latest || textSourceSnapshot(latest) !== before)
          throw new ActivationError(
            'La fuente cambió durante la preparación. Inténtalo otra vez.',
            409,
          );
      },
    });
    return NextResponse.json(response, { status: response.status === 'ready' ? 201 : 200 });
  } catch (error) {
    if (error instanceof ActivationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json(
      { error: 'No se pudo preparar una vista verificable de la fuente.' },
      { status: 503 },
    );
  }
}
