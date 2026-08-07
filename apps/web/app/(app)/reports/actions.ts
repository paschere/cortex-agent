'use server';

import { buildToolContext } from '@/lib/agent';
import { type ReportKind, isReportKind } from '@/lib/reports-shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  buildReport,
  getReport,
  revokeShare,
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
    if (!isReportKind(input.kind)) {
      return { ok: false, error: 'Ese tipo de informe no existe.' };
    }
    const kind: ReportKind = input.kind;
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

export async function shareReportAction(
  reportId: string,
  days = 30,
): Promise<ReportActionResult> {
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
