import {
  ACTIVATION_PLANNER_SYSTEM,
  PLAN_LIMITATIONS,
  activationPlanInput,
  modelPlanSchema,
  planningCatalog,
  validateActivationPlan,
} from '@/lib/activations/planning';
import { prepareSourceView } from '@/lib/activations/prepare';
import { isSameOrigin } from '@/lib/activations/request';
import {
  ActivationError,
  activationSource,
  readOwnedPreparedViews,
  readOwnedTableSources,
  sourceSnapshot,
  textSourceSnapshot,
} from '@/lib/activations/service';
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
    let sources = await readOwnedTableSources(db, user.id);
    if (parsed.data.sourceId && !sources.some((source) => source.id === parsed.data.sourceId))
      return NextResponse.json(
        { error: 'La fuente no está disponible en este espacio.' },
        { status: 404 },
      );
    let views = await readOwnedPreparedViews(db, user.id);
    let catalog = planningCatalog(
      sources.map((source) => activationSource(source, views)),
      parsed.data.sourceId,
    );
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
    const planWithModel = (extra?: Record<string, unknown>) =>
      generateObject({
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
            'Hasta 20 fuentes, 8 pestañas o vistas y 60 encabezados. Selecciona una fuente concreta si no aparece.',
          ...extra,
        }),
      });
    const assertSameSession = async () => {
      const currentUser = await requireSession();
      if (currentUser.id !== user.id || currentUser.organization.id !== user.organization.id)
        throw new Error('WORKSPACE_CHANGED');
    };
    let { object } = await planWithModel();
    await assertSameSession();
    if (object.preparationPrompt) {
      if (object.questions.length || object.unsupportedRequirements.length)
        return NextResponse.json(validateActivationPlan(object, catalog));
      if (!object.sourceId)
        return NextResponse.json({
          status: 'needs_input',
          explanation: object.explanation,
          questions: ['Elige qué fuente debemos preparar.'],
          draft: null,
          limitations: PLAN_LIMITATIONS,
        });
      const source = sources.find((item) => item.id === object.sourceId);
      if (!source || !source.extracted_text?.trim())
        return NextResponse.json({
          status: 'needs_input',
          explanation: object.explanation,
          questions: ['La fuente elegida no tiene texto legible para preparar.'],
          draft: null,
          limitations: PLAN_LIMITATIONS,
        });
      const before = textSourceSnapshot(source);
      const prepared = await prepareSourceView(
        db,
        user.id,
        source,
        object.preparationPrompt,
        req.signal,
        {
          beforeSave: async () => {
            await assertSameSession();
            const latest = (await readOwnedTableSources(db, user.id)).find(
              (item) => item.id === source.id,
            );
            if (!latest || textSourceSnapshot(latest) !== before) throw new Error('SOURCE_CHANGED');
          },
        },
      );
      if (prepared.status === 'needs_input')
        return NextResponse.json({
          status: 'needs_input',
          explanation: object.explanation,
          questions: prepared.questions,
          draft: null,
          limitations: PLAN_LIMITATIONS,
        });
      sources = await readOwnedTableSources(db, user.id);
      views = await readOwnedPreparedViews(db, user.id);
      catalog = planningCatalog(
        sources.map((item) => activationSource(item, views)),
        source.id,
      );
      ({ object } = await planWithModel({
        preparedViewId: prepared.viewId,
        instruction:
          'Completa ahora la regla usando exclusivamente esta vista preparada. Devuelve su viewId y preparationPrompt null.',
      }));
      await assertSameSession();
      if (object.sourceId !== source.id || object.viewId !== prepared.viewId)
        throw new Error('PREPARED_VIEW_NOT_USED');
    }
    const plan = validateActivationPlan(object, catalog);
    if (plan.draft) {
      const currentSources = await readOwnedTableSources(db, user.id);
      const before = sources.find((source) => source.id === plan.draft?.sourceId);
      const after = currentSources.find((source) => source.id === plan.draft?.sourceId);
      const stable = plan.draft.viewId
        ? before && after && textSourceSnapshot(before) === textSourceSnapshot(after)
        : before && after && sourceSnapshot(before) === sourceSnapshot(after);
      if (!stable)
        return NextResponse.json(
          { error: 'La fuente cambió o venció durante el diseño. Inténtalo otra vez.' },
          { status: 409 },
        );
    }
    return NextResponse.json(plan);
  } catch (error) {
    if (error instanceof ActivationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && error.message === 'WORKSPACE_CHANGED')
      return NextResponse.json(
        { error: 'El espacio cambió. Diseña nuevamente la activación.' },
        { status: 409 },
      );
    if (error instanceof Error && error.message === 'SOURCE_CHANGED')
      return NextResponse.json(
        { error: 'La fuente cambió durante la preparación. Inténtalo otra vez.' },
        { status: 409 },
      );
    return NextResponse.json(
      {
        error:
          'No se pudo diseñar la activación. Revisa acceso y cuota, o vuelve a intentarlo en un momento. También puedes configurar la regla manualmente.',
      },
      { status: 503 },
    );
  }
}
