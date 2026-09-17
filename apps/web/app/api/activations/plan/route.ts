import {
  ACTIVATION_PLANNER_SYSTEM,
  PLAN_LIMITATIONS,
  activationPlanInput,
  modelPlanSchema,
  planningCatalog,
  validateActivationPlan,
} from '@/lib/activations/planning';
import { isSameOrigin } from '@/lib/activations/request';
import { activationSource, readOwnedTableSources, sourceSnapshot } from '@/lib/activations/service';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NO_THINKING, chatModel, checkMeter, consumeToken, isRefused } from '@cortex/agent-tools';
import { generateObject } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 90;

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req))
    return NextResponse.json({ error: 'Origen de solicitud inválido.' }, { status: 403 });
  const user = await requireSession();
  const parsed = activationPlanInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Describe el proceso en entre 8 y 4.000 caracteres.' },
      { status: 400 },
    );
  const db = getOrgScopedClient(user.organization.id);
  try {
    await consumeToken(db, user.id, 'activations.plan', 3);
    const sources = await readOwnedTableSources(db, user.id);
    if (parsed.data.sourceId && !sources.some((source) => source.id === parsed.data.sourceId))
      return NextResponse.json(
        { error: 'La fuente no está disponible en este espacio.' },
        { status: 404 },
      );
    const catalog = planningCatalog(sources.map(activationSource), parsed.data.sourceId);
    if (!catalog.length)
      return NextResponse.json({
        status: 'needs_input',
        explanation:
          'Primero necesitamos una fuente para traducir tu intención en una regla verificable.',
        questions: [
          'Añade al Feed una tabla con los datos del proceso y vuelve a diseñar la activación.',
        ],
        draft: null,
        limitations: PLAN_LIMITATIONS,
      });
    if (isRefused(await checkMeter(db, 'answers')))
      return NextResponse.json(
        { error: 'No quedan respuestas disponibles en el plan.' },
        { status: 429 },
      );
    const { object } = await generateObject({
      model: chatModel(),
      experimental_providerMetadata: NO_THINKING,
      schema: modelPlanSchema,
      maxTokens: 5000,
      abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(60000)]),
      system: ACTIVATION_PLANNER_SYSTEM,
      prompt: JSON.stringify({
        company: user.organization.name,
        intent: parsed.data.prompt,
        catalog,
        catalogScope:
          'Hasta 20 fuentes, 8 pestañas y 60 encabezados por pestaña. Selecciona una fuente concreta si no aparece.',
      }),
    });
    const currentUser = await requireSession();
    if (currentUser.id !== user.id || currentUser.organization.id !== user.organization.id)
      return NextResponse.json(
        { error: 'El espacio cambió. Diseña nuevamente la activación.' },
        { status: 409 },
      );
    const plan = validateActivationPlan(object, catalog);
    if (plan.draft) {
      const currentSources = await readOwnedTableSources(db, user.id);
      const before = sources.find((source) => source.id === plan.draft?.sourceId);
      const after = currentSources.find((source) => source.id === plan.draft?.sourceId);
      if (!before || !after || sourceSnapshot(before) !== sourceSnapshot(after))
        return NextResponse.json(
          { error: 'La fuente cambió o venció durante el diseño. Inténtalo otra vez.' },
          { status: 409 },
        );
    }
    return NextResponse.json(plan);
  } catch {
    return NextResponse.json(
      {
        error:
          'No se pudo diseñar la activación. Revisa acceso y cuota, o vuelve a intentarlo en un momento. También puedes configurar la regla manualmente.',
      },
      { status: 503 },
    );
  }
}
