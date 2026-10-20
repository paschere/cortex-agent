'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type CompareLine,
  type InspectReport,
  compareVersions,
  inspectAppRole,
  viewerFromSession,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';

/**
 * Las revisiones de una app desde el editor: «qué ve de verdad este rol»
 * (la misma `inspectAppRole` que usa Cortex con `apps.inspect`) y «qué cambió
 * entre dos versiones» (`compareVersions`, la de `apps.versions`). Sólo leen.
 * Son de quien administra la empresa.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function admin() {
  const user = await requireSession();
  if (!viewerFromSession(user).companyAdmin)
    throw new ValidationError('Sólo quien administra la empresa puede revisar una aplicación.');
  return { user, db: getOrgScopedClient(user.organization.id) };
}

function describe(err: unknown, fallback: string): string {
  return err instanceof ValidationError || err instanceof NotFoundError ? err.message : fallback;
}

export async function inspectRoleAction(
  appId: string,
  roleKey: string,
  version: 'draft' | 'published' = 'draft',
): Promise<Result<{ report: InspectReport; publishedNumber: number | null }>> {
  try {
    const { user, db } = await admin();
    const { loaded, report } = await inspectAppRole(db, appId, roleKey, version, user.id);
    if ('error' in report) return { ok: false, error: report.error };
    return { ok: true, report, publishedNumber: loaded.publishedNumber };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo revisar la aplicación.') };
  }
}

export async function compareVersionsAction(
  appId: string,
  from: number | 'draft',
  to: number | 'draft',
): Promise<Result<{ from: string; to: string; lines: CompareLine[] }>> {
  try {
    const { db } = await admin();
    const res = await compareVersions(db, appId, from, to);
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron comparar las versiones.') };
  }
}
