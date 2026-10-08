import 'server-only';

import {
  NO_THINKING,
  type ViewSource,
  chatModel,
  computeView,
  getView,
  loadViewSources,
  queryRows,
  readPlatformSource,
  trackersOf,
  viewCatalog,
  viewSpecSchema,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateObject } from 'ai';
import type { z } from 'zod';
import {
  type DesignCatalogEntry,
  VIEW_DESIGNER_SYSTEM,
  checkDesign,
  type designInput,
  modelDesignSchema,
  salvageDesign,
  sampleOf,
} from './design';

/**
 * EL DISEÑADOR DE VISTAS, SIN LA PUERTA HTTP.
 *
 * Lo que antes vivía dentro de `/api/views/design`: armar el catálogo de tablas,
 * pedirle el diseño al modelo, comprobarlo contra el catálogo, darle UNA
 * oportunidad de corregirse y rescatar lo rescatable. Vive aquí para que quien
 * necesite diseñar una vista por otro camino (la entrevista guiada) use el
 * MISMO diseñador y no una copia que se desvíe. La ruta conserva lo suyo: el
 * origen, la sesión, el límite de uso y el medidor del plan.
 *
 * No guarda nada: devuelve un borrador con su vista previa.
 */

export interface DesignerUser {
  id: string;
  organizationName: string;
}

export type ViewDesignOutcome =
  | { status: 'not_found' }
  | { status: 'needs_input'; explanation: string; questions: string[] }
  | {
      status: 'ready';
      draft: {
        name: string;
        description: string;
        explanation: string;
        spec: ReturnType<typeof viewSpecSchema.parse>;
        newTrackers: Extract<ReturnType<typeof checkDesign>, { ok: true }>['result']['newTrackers'];
      };
      preview: ReturnType<typeof computeView>;
      baseVersion: number | null;
    };

export async function runViewDesign(
  db: SupabaseClient,
  user: DesignerUser,
  input: z.infer<typeof designInput>,
  signal?: AbortSignal,
): Promise<ViewDesignOutcome> {
  const current = input.viewId ? await getView(db, input.viewId, { appScreens: true }) : null;
  if (input.viewId && !current) return { status: 'not_found' };

  // Lo que la vista ya usa: el borrador que se está afinando o la versión
  // guardada. Una tabla del Feed de esa lista que esta persona no puede leer
  // entra como `unavailable` (se conserva sin abrirla).
  const draftSpec = viewSpecSchema.safeParse(input.draft?.spec);
  const keep = draftSpec.success
    ? trackersOf(draftSpec.data)
    : current
      ? trackersOf(current.spec)
      : [];
  const full = await viewCatalog(db, { viewerId: user.id, keep });
  // Hasta 20 tablas del espacio, todas las fuentes de la plataforma y las
  // tablas del Feed de ESTA persona. Las muestras de una fuente de la
  // plataforma son tres filas leídas por su propio lector (las personales,
  // con las filas de quien diseña); si una no contesta, va sin muestra y el
  // diseño sigue. Las del Feed ya traen su muestra del listado.
  // Una fuente de un módulo apagado no se ofrece, salvo que la vista ya la
  // use: entonces entra marcada `unavailable` y se conserva tal cual.
  const entries = [
    ...full.filter((t) => t.kind === 'tracker').slice(0, 20),
    ...full.filter((t) => t.kind === 'platform' && (!t.moduleOff || keep.includes(t.slug))),
    ...full.filter((t) => t.kind === 'feed'),
  ];
  const catalog: DesignCatalogEntry[] = await Promise.all(
    entries.map(async (t) => {
      const rows =
        t.kind === 'feed'
          ? (t.sample ?? [])
          : t.kind === 'platform'
            ? ((
                await readPlatformSource(db, t.slug, 3, undefined, { viewerId: user.id }).catch(
                  () => null,
                )
              )?.rows ?? [])
            : t.rowCount
              ? await queryRows(db, { trackerId: t.id, limit: 3 })
              : [];
      return {
        slug: t.slug,
        name: t.name,
        description: t.description,
        kind: t.kind,
        sensitivity: t.sensitivity,
        rowCount: t.rowCount,
        fields: t.fields,
        sample: sampleOf(rows.map((r) => ({ label: r.label, ...r.values }))),
        ...(t.opaque || t.moduleOff ? { unavailable: true } : {}),
      };
    }),
  );

  const ask = (extra?: Record<string, unknown>) =>
    generateObject({
      model: chatModel(),
      experimental_providerMetadata: NO_THINKING,
      schema: modelDesignSchema,
      maxTokens: 12000,
      abortSignal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(75000)])
        : AbortSignal.timeout(75000),
      system: VIEW_DESIGNER_SYSTEM,
      prompt: JSON.stringify({
        company: user.organizationName,
        today: new Date().toISOString().slice(0, 10),
        request: input.prompt,
        currentView: input.draft
          ? {
              name: input.draft.name,
              description: input.draft.description,
              spec: input.draft.spec,
              proposedNewTrackers: input.draft.newTrackers,
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
    return { status: 'needs_input', explanation: object.explanation, questions: object.questions };
  let checked = checkDesign(object, catalog);
  if (!checked.ok) {
    ({ object } = await ask({
      previousAttempt: object.specJson.slice(0, 20000),
      problems: checked.problems,
      instruction: 'Corrige exactamente estos problemas y devuelve la vista completa otra vez.',
    }));
    checked = checkDesign(object, catalog);
  }
  if (!checked.ok) {
    logger.warn(
      { problems: checked.problems.slice(0, 8) },
      'view designer: second attempt still invalid',
    );
    const salvaged = salvageDesign(object, catalog);
    if (salvaged) {
      checked = {
        ok: true,
        result: {
          ...salvaged.result,
          explanation:
            `${salvaged.result.explanation} Dejé por fuera ${salvaged.dropped.length === 1 ? 'un bloque que no cuadraba' : `${salvaged.dropped.length} bloques que no cuadraban`} con tus tablas; pídemelo de otra forma o agrégalo en el lienzo.`.trim(),
        },
      };
    }
  }
  if (!checked.ok)
    return {
      status: 'needs_input',
      explanation: 'No logré armar una vista que cuadre con tus tablas.',
      questions: object.questions.length
        ? object.questions
        : ['¿Qué tabla y qué cifras quieres ver? Nombrarlas me ayuda a acertar.'],
    };

  const draft = checked.result;
  const sources = await loadViewSources(db, draft.spec, { viewerId: user.id });
  for (const t of draft.newTrackers)
    if (!sources.has(t.slug))
      sources.set(t.slug, { tracker: t, rows: [], truncated: false } satisfies ViewSource);

  return {
    status: 'ready',
    draft: {
      name:
        (input.draft ?? current) && !/nombre|llam|renombr|título/i.test(input.prompt)
          ? (input.draft?.name ?? current?.name ?? draft.name)
          : draft.name,
      description: draft.description || current?.description || '',
      explanation: draft.explanation,
      spec: draft.spec,
      newTrackers: draft.newTrackers,
    },
    preview: computeView(draft.spec, sources),
    baseVersion: current?.version ?? null,
  };
}
