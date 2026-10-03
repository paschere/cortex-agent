'use server';

import { canManageAccounting } from '@/lib/accounting/card';
import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

/**
 * «SINCRONIZAR AHORA» PARA UNA CARPETA DE DRIVE O UNA HOJA SINCRONIZADA.
 *
 * Lo mismo que hace la herramienta `trackers.retry_sync` cuando se le pide en
 * el chat —adelantar `next_run_at` y encolar la corrida—, sin pasar por el
 * chat. No cambia la configuración. La puede pedir quien la creó o quien
 * administra la empresa; una pausada no se despierta desde aquí.
 *
 * El programa contable tiene la suya (`syncAccountingProgramNow`) y una fuente
 * de la bandeja se actualiza por /api/feed/sources.
 */

export type SourceSyncResult = { ok: true; note: string } | { ok: false; error: string };

const input = z.object({
  kind: z.enum(['drive_folder', 'table_sync']),
  id: z.string().uuid(),
});

export async function syncSourceNow(raw: {
  kind: 'drive_folder' | 'table_sync';
  id: string;
}): Promise<SourceSyncResult> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'No se reconoce esa sincronización.' };
  const { kind, id } = parsed.data;
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const table = kind === 'drive_folder' ? 'drive_folder_syncs' : 'tracker_syncs';
    const { data: row, error: readError } = await db
      .from(table)
      .select('id, enabled, created_by')
      .eq('id', id)
      .maybeSingle();
    if (readError)
      return { ok: false, error: 'No se pudo leer la sincronización. Intenta otra vez.' };
    if (!row) return { ok: false, error: 'Esa sincronización ya no existe en esta empresa.' };
    if (row.created_by !== user.id && !canManageAccounting(user.organization.role))
      return {
        ok: false,
        error: 'Sólo quien la creó o quien administra la empresa puede correrla ya.',
      };
    if (!row.enabled)
      return { ok: false, error: 'Está en pausa. Reactívala desde el chat antes de correrla.' };
    const { error: updateError } = await db
      .from(table)
      .update({ next_run_at: new Date().toISOString() })
      .eq('id', id)
      .eq('enabled', true);
    if (updateError) return { ok: false, error: 'No se pudo pedir la sincronización.' };
    const queued = await enqueueJob(
      kind === 'drive_folder' ? 'drive-table/run' : 'table-sync/run',
      {
        organizationId: user.organization.id,
        syncId: id,
      },
    );
    revalidatePath('/integrations');
    return {
      ok: true,
      note: queued
        ? 'Sincronizando. En unos minutos ves lo nuevo en la tabla.'
        : 'Quedó para la próxima vuelta (en unos minutos).',
    };
  } catch {
    return { ok: false, error: 'No se pudo pedir la sincronización.' };
  }
}
