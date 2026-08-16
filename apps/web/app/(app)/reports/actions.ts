'use server';

import { buildToolContext } from '@/lib/agent';
import { type GeneratedReportKind, isGeneratedReportKind } from '@/lib/reports-shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  buildReport,
  getRecipe,
  getReport,
  revokeShare,
  runRecipeAndSave,
  saveReport,
  shareReport,
} from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';

/**
 * What the buttons on the reports screens do.
 *
 * All three go through the same functions the `reports.*` tools use — building
 * a report from the chat and building one from the button have to produce the
 * same document, or the two surfaces start disagreeing about what "the informe
 * de vencimientos" is.
 */

const PATH = '/reports';

export interface ReportActionResult {
  ok: boolean;
  error?: string;
  reportId?: string;
  url?: string;
  expiresAt?: string;
}

function describe(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 240 ? message : fallback;
}

export async function generateReportAction(input: {
  kind: string;
  horizonDays?: number;
  months?: number;
  client?: string;
}): Promise<ReportActionResult> {
  try {
    // The GENERATED kinds, not every kind a stored report may have. `chart`
    // exists as a stored kind but is not buildable — it is a chart kept out of
    // a conversation, and there are no parameters to re-run. Guarding on the
    // wider list would let this action be asked for one and fail deeper in.
    if (!isGeneratedReportKind(input.kind)) {
      return { ok: false, error: 'Ese tipo de informe no se puede generar.' };
    }
    const kind: GeneratedReportKind = input.kind;
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);

    const document = await buildReport(kind, {
      db,
      params: {
        horizonDays: input.horizonDays,
        months: input.months,
        client: input.client?.trim() || null,
      },
    });

    const ctx = buildToolContext({
      organizationId: user.organization.id,
      userId: user.id,
      agentId: user.id,
      surface: 'web',
    });

    const row = await saveReport(ctx, {
      kind,
      document,
      params: {
        horizonDays: input.horizonDays ?? null,
        months: input.months ?? null,
        client: input.client?.trim() || null,
      },
    });

    revalidatePath(PATH);
    return { ok: true, reportId: row.id };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo generar el informe.') };
  }
}

/**
 * Volver a correr un informe a la medida guardado.
 *
 * Pasa por `runRecipeAndSave`, que es la misma función que corre la herramienta
 * del chat y la que correrá una rutina programada, por la misma razón que
 * `generateReportAction` pasa por `buildReport`: si el botón y el chat armaran
 * el informe por caminos distintos, las dos superficies empezarían a discrepar
 * sobre qué es «el informe de cartera» y nadie se enteraría hasta que alguien
 * comparara dos papeles.
 *
 * Produce una FOTOGRAFÍA NUEVA. La anterior no se toca — por eso devuelve un id
 * distinto y la pantalla navega a él.
 */
export async function runRecipeAction(recipeId: string): Promise<ReportActionResult> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const recipe = await getRecipe(db, recipeId);
    if (!recipe || recipe.archived_at) {
      return { ok: false, error: 'Ese informe a la medida ya no existe.' };
    }

    const ctx = buildToolContext({
      organizationId: user.organization.id,
      userId: user.id,
      agentId: user.id,
      surface: 'web',
    });

    const made = await runRecipeAndSave(ctx, recipe);
    revalidatePath(PATH);
    return { ok: true, reportId: made.row.id };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo generar el informe.') };
  }
}

export async function shareReportAction(reportId: string, days = 30): Promise<ReportActionResult> {
  try {
    const user = await requireSession();
    const ctx = buildToolContext({
      organizationId: user.organization.id,
      userId: user.id,
      agentId: user.id,
      surface: 'web',
    });
    // Read first through the scoped handle: it turns another workspace's id
    // into "no row" rather than into an update that quietly matches nothing.
    const db = getOrgScopedClient(user.organization.id);
    const stored = await getReport(db, reportId);
    if (!stored) return { ok: false, error: 'Ese informe no existe.' };

    const result = await shareReport(ctx, reportId, { days });
    revalidatePath(PATH);
    revalidatePath(`${PATH}/${reportId}`);
    return { ok: true, reportId, url: result.url, expiresAt: result.expiresAt };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo crear el enlace.') };
  }
}

export async function revokeShareAction(reportId: string): Promise<ReportActionResult> {
  try {
    const user = await requireSession();
    const ctx = buildToolContext({
      organizationId: user.organization.id,
      userId: user.id,
      agentId: user.id,
      surface: 'web',
    });
    const revoked = await revokeShare(ctx, reportId);
    if (!revoked) return { ok: false, error: 'Ese informe no existe.' };
    revalidatePath(PATH);
    revalidatePath(`${PATH}/${reportId}`);
    return { ok: true, reportId };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo revocar el enlace.') };
  }
}
