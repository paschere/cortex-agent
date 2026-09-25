import 'server-only';
import { notify } from '@/lib/notifications/notify';
import { type CustomViewRow, bellAlertFor, orgAdmins } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * La campana de una vista (migración 0160): quien la creó y quienes
 * administran el espacio. Se usa para el botón de «avisar» de una fila y para
 * las filas que entran por un formulario con alerta de campana.
 *
 * Un aviso que no se pudo escribir no tumba lo que la persona hizo: la fila ya
 * se guardó, y perderla por la campana sería el peor de los dos resultados.
 */
export async function notifyViewActivity(
  db: SupabaseClient,
  view: Pick<CustomViewRow, 'id' | 'slug' | 'name' | 'created_by'>,
  input: { title: string; body?: string; dedupeKey?: string },
): Promise<void> {
  try {
    const admins = await orgAdmins(db).catch(() => [] as string[]);
    const recipients = [...new Set([view.created_by, ...admins].filter(Boolean))] as string[];
    await Promise.all(
      recipients.map((userId) =>
        notify(db, {
          userId,
          kind: 'view_activity',
          title: input.title,
          body: input.body,
          href: `/views/${view.slug}`,
          groupKey: `view:${view.id}`,
          ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
        }),
      ),
    );
  } catch (err) {
    logger.warn({ err, viewId: view.id }, 'view activity notice failed');
  }
}

/**
 * Si el formulario apunta a una tabla con alerta de campana, suena para quien
 * creó la vista. Aquí y no en el archivo de acciones: un helper exportado desde
 * un archivo `'use server'` se vuelve un endpoint que cualquiera puede llamar.
 */
export async function bellForSubmission(
  db: SupabaseClient,
  view: CustomViewRow,
  blockId: string,
  who: string,
): Promise<void> {
  const block = view.spec.blocks.find((b) => b.id === blockId);
  if (!block || block.type !== 'form') return;
  const alert = bellAlertFor(view, block.tracker);
  if (!alert) return;
  await notifyViewActivity(db, view, {
    title: alert.message ?? `Entró algo nuevo por «${block.title}»`,
    body: `${who} lo envió desde la vista «${view.name}».`,
  });
}
