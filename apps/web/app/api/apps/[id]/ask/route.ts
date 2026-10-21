import { isSameOrigin } from '@/lib/activations/request';
import { requireAppAdmin } from '@/lib/apps/access';
import { runViewDesign } from '@/lib/views/design-run';
import {
  checkMeter,
  compareScreenSpecs,
  consumeToken,
  getView,
  isRefused,
} from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * «Pídele a Cortex un cambio» en el editor de la app: propone, no guarda.
 *
 * Reusa el diseñador de vistas sobre la pantalla elegida (mismo catálogo, mismas
 * validaciones y la misma segunda oportunidad), con el contexto de la app en la
 * frase. Devuelve el borrador y la comparación en español contra lo guardado;
 * aplicar es un guardado aparte (con versión esperada y deshacer) en el cliente.
 * Sólo quien administra la empresa.
 */

export const runtime = 'nodejs';
export const maxDuration = 90;

const Body = z.object({
  instruction: z.string().trim().min(4).max(2000),
  screen: z.string().trim().min(1).max(80),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Cuéntale el cambio en una frase (mínimo 4 letras).' },
      { status: 400 },
    );
  const { id } = await params;
  let opened: Awaited<ReturnType<typeof requireAppAdmin>>;
  try {
    opened = await requireAppAdmin(decodeURIComponent(id));
  } catch {
    return NextResponse.json(
      { error: 'Sólo quien administra puede cambiar la app.' },
      { status: 403 },
    );
  }
  const { db, access, user } = opened;
  const screen = access.screens.find((s) => s.slug === parsed.data.screen);
  if (!screen) return NextResponse.json({ error: 'Esa pantalla no existe.' }, { status: 404 });
  try {
    await consumeToken(db, user.id, 'apps.ask', 6);
    if (isRefused(await checkMeter(db, 'answers')))
      return NextResponse.json(
        { error: 'No quedan respuestas disponibles en el plan.' },
        { status: 429 },
      );
    const current = await getView(db, screen.view_id, { appScreens: true });
    if (!current) return NextResponse.json({ error: 'La pantalla ya no existe.' }, { status: 404 });
    const context = `Contexto: es la pantalla «${screen.title}» de la aplicación «${access.app.name}» (roles que la ven: ${screen.roles.length ? screen.roles.join(', ') : 'todos'}). Cambia SOLO esta pantalla. Pedido: ${parsed.data.instruction}`;
    const outcome = await runViewDesign(
      db,
      { id: user.id, organizationName: user.organization.name },
      { prompt: context.slice(0, 4000), viewId: screen.view_id, draft: undefined },
      req.signal,
    );
    if (outcome.status === 'not_found')
      return NextResponse.json({ error: 'La pantalla ya no existe.' }, { status: 404 });
    if (outcome.status === 'needs_input') return NextResponse.json(outcome);
    const lines = compareScreenSpecs(
      { title: screen.title, roles: screen.roles, spec: current.spec },
      { title: screen.title, roles: screen.roles, spec: outcome.draft.spec },
    );
    return NextResponse.json({
      status: 'ready',
      viewId: screen.view_id,
      baseVersion: current.version,
      explanation: outcome.draft.explanation,
      lines,
      newTrackers: outcome.draft.newTrackers.map((t) => ({ slug: t.slug, name: t.name })),
      draft: {
        name: outcome.draft.name,
        description: outcome.draft.description,
        spec: outcome.draft.spec,
        newTrackers: outcome.draft.newTrackers,
      },
      previous: { name: current.name, description: current.description, spec: current.spec },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'RateLimitError')
      return NextResponse.json({ error: 'Vas muy rápido. Espera un momento.' }, { status: 429 });
    return NextResponse.json(
      { error: 'No pude armar el cambio ahora. Vuelve a intentarlo en un momento.' },
      { status: 503 },
    );
  }
}
