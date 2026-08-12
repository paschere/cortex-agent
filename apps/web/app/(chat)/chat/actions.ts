'use server';

import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { listVisibleSpaces, saveChartAsReport } from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';

/**
 * What the buttons inside the transcript do.
 *
 * Kept as server actions rather than routes because each one is a single
 * mutation with no payload worth streaming, and because the alternative — a
 * route per button — is how a surface accumulates six endpoints that all
 * `requireSession` slightly differently.
 */

export interface ChartSaveResult {
  ok: boolean;
  error?: string;
  reportId?: string;
  url?: string;
  alreadySaved?: boolean;
}

/**
 * Keep a chart drawn in the chat as an informe.
 *
 * THE WHOLE POINT IS WHAT IS ABSENT: there is no query here. The chart was
 * resolved into a `ReportDocument` when it was drawn — figures computed,
 * sources stamped with the instant they were read — and this hands those same
 * bytes to `saveReport`. So the saved informe carries the moment of the CHART,
 * not the moment of the click, and reopening it in November shows what the
 * conversation showed in August.
 *
 * That is the difference between saving and bookmarking, and `store.ts` argues
 * it at length: a report that re-runs its query is a report about today wearing
 * an older title, and nobody can tell because both look correct.
 */
export async function saveChartAsReportAction(chartId: string): Promise<ChartSaveResult> {
  try {
    const user = await requireSession();
    const ctx = buildToolContext({
      organizationId: user.organization.id,
      userId: user.id,
      agentId: user.id,
      surface: 'web',
    });

    const result = await saveChartAsReport(ctx, chartId);
    revalidatePath('/reports');
    return {
      ok: true,
      reportId: result.reportId,
      url: `/reports/${result.reportId}`,
      alreadySaved: result.alreadySaved,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    return {
      ok: false,
      error: message && message.length < 240 ? message : 'No se pudo guardar el informe.',
    };
  }
}

export interface SpaceChoice {
  id: string;
  name: string;
  kind: 'global' | 'personal';
  /** False when this person may read the space but not write to it. */
  writable: boolean;
}

/**
 * The spaces offered when somebody chooses to remember a file.
 *
 * Company-wide spaces are LISTED for everyone and only WRITABLE by org admins,
 * rather than hidden from everybody else. Hiding them would make the product
 * look like it has no shared memory; showing them disabled says the true thing
 * — this exists, and putting something in it is not your call — which is the
 * answer somebody needs in order to go and ask.
 *
 * `assertCanWriteToSpace` on the upload route is what actually enforces it.
 * This list is a convenience and is never the check.
 */
export async function listWritableSpacesAction(): Promise<SpaceChoice[]> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const [spaces, { data: me }] = await Promise.all([
      listVisibleSpaces(db, user.id),
      db.from('users').select('role').eq('id', user.id).maybeSingle(),
    ]);
    const isAdmin = (me?.role as string | undefined) === 'org_admin';

    return spaces.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      writable: s.kind === 'personal' ? s.ownerId === user.id : isAdmin,
    }));
  } catch {
    return [];
  }
}
