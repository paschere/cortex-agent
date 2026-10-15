'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { draftStatus, listRoles, resolveAppAccess, viewerFromSession } from '@cortex/agent-tools';

/**
 * Lo que el panel de la app al lado del chat necesita saber de ella: nombre,
 * estado, versión, qué cambió sin publicar y —sólo para quien administra— los
 * roles para «Ver como». `canEdit` usa la misma regla que /apps/<id>/edit
 * (`viewer.companyAdmin`); quien no la cumple recibe sólo lo de «Vista».
 */

export interface AppPanelInfo {
  id: string;
  slug: string;
  name: string;
  icon: string;
  status: 'draft' | 'published';
  publishedNumber: number | null;
  canEdit: boolean;
  hasChanges: boolean;
  /** Los cambios del borrador sin publicar, en texto (para contarle a Cortex). */
  changes: string[];
  summary: string;
  roles: Array<{ key: string; name: string }>;
}

export async function appPanelInfoAction(
  ref: string,
): Promise<{ ok: true; info: AppPanelInfo } | { ok: false; error: string }> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const viewer = viewerFromSession(user);
    const access = await resolveAppAccess(db, ref, viewer, {});
    if (!access) return { ok: false, error: 'No encuentro esa app o no tienes acceso.' };
    const app = access.app;
    const canEdit = viewer.companyAdmin;
    const [draft, roles] = canEdit
      ? await Promise.all([
          draftStatus(db, app).catch(() => null),
          listRoles(db, app.id).catch(() => []),
        ])
      : [null, []];
    return {
      ok: true,
      info: {
        id: app.id,
        slug: app.slug,
        name: app.name,
        icon: app.icon,
        status: app.status === 'published' ? 'published' : 'draft',
        publishedNumber: draft?.publishedNumber ?? null,
        canEdit,
        hasChanges: draft?.hasChanges ?? false,
        changes: (draft?.changes ?? []).map((c) => c.text),
        summary: draft?.summary ?? '',
        roles: roles.map((r) => ({ key: r.key, name: r.name })),
      },
    };
  } catch {
    return { ok: false, error: 'No pude leer la app.' };
  }
}
