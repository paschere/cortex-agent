import { isSameOrigin } from '@/lib/activations/request';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type DesignCatalogEntry,
  VIEW_DESIGNER_SYSTEM,
  checkDesign,
  designInput,
  modelDesignSchema,
  sampleOf,
} from '@/lib/views/design';
import {
  NO_THINKING,
  type ViewSource,
  chatModel,
  checkMeter,
  computeView,
  consumeToken,
  getView,
  isRefused,
  loadViewSources,
  queryRows,
  viewCatalog,
} from '@cortex/agent-tools';
import { generateObject } from 'ai';
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

    const current = parsed.data.viewId ? await getView(db, parsed.data.viewId) : null;
    if (parsed.data.viewId && !current)
      return NextResponse.json({ error: 'Esa vista ya no existe.' }, { status: 404 });

    const trackers = (await viewCatalog(db)).slice(0, 20);
    const catalog: DesignCatalogEntry[] = await Promise.all(
      trackers.map(async (t) => {
        const rows = t.rowCount ? await queryRows(db, { trackerId: t.id, limit: 3 }) : [];
        return {
          slug: t.slug,
          name: t.name,
          description: t.description,
          rowCount: t.rowCount,
          fields: t.fields,
          sample: sampleOf(rows.map((r) => ({ label: r.label, ...r.values }))),
        };
      }),
    );

    const ask = (extra?: Record<string, unknown>) =>
      generateObject({
        model: chatModel(),
        experimental_providerMetadata: NO_THINKING,
        schema: modelDesignSchema,
        maxTokens: 8000,
        abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(75000)]),
        system: VIEW_DESIGNER_SYSTEM,
        prompt: JSON.stringify({
          company: user.organization.name,
          today: new Date().toISOString().slice(0, 10),
          request: parsed.data.prompt,
          currentView: parsed.data.draft
            ? {
                name: parsed.data.draft.name,
                description: parsed.data.draft.description,
                spec: parsed.data.draft.spec,
                proposedNewTrackers: parsed.data.draft.newTrackers,
              }
            : current
              ? { name: current.name, description: current.description, spec: current.spec }
              : null,
          catalog,
          ...extra,
        }),
      });

    let { object } = await ask();
    if (object.questions.length && !object.specJson.trim())
      return NextResponse.json({
        status: 'needs_input',
        explanation: object.explanation,
        questions: object.questions,
      });
    let checked = checkDesign(object, catalog);
    if (!checked.ok) {
      ({ object } = await ask({
        previousAttempt: object.specJson.slice(0, 20000),
        problems: checked.problems,
        instruction: 'Corrige exactamente estos problemas y devuelve la vista completa otra vez.',
      }));
      checked = checkDesign(object, catalog);
    }
    if (!checked.ok)
      return NextResponse.json({
        status: 'needs_input',
        explanation: 'No logré armar una vista que cuadre con tus tablas.',
        questions: object.questions.length
          ? object.questions
          : ['¿Qué tabla y qué cifras quieres ver? Nombrarlas me ayuda a acertar.'],
      });

    const draft = checked.result;
    const sources = await loadViewSources(db, draft.spec);
    for (const t of draft.newTrackers)
      if (!sources.has(t.slug))
        sources.set(t.slug, { tracker: t, rows: [], truncated: false } satisfies ViewSource);

    return NextResponse.json({
      status: 'ready',
      draft: {
        name:
          (parsed.data.draft ?? current) && !/nombre|llam|renombr|título/i.test(parsed.data.prompt)
            ? (parsed.data.draft?.name ?? current?.name ?? draft.name)
            : draft.name,
        description: draft.description || current?.description || '',
        explanation: draft.explanation,
        spec: draft.spec,
        newTrackers: draft.newTrackers,
      },
      preview: computeView(draft.spec, sources),
      baseVersion: current?.version ?? null,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'RateLimitError')
      return NextResponse.json({ error: 'Vas muy rápido. Espera un momento.' }, { status: 429 });
    return NextResponse.json(
      { error: 'No se pudo diseñar la vista. Vuelve a intentarlo en un momento.' },
      { status: 503 },
    );
  }
}
