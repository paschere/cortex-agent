import { confirmationResults, pendingConfirmationIndex } from '@/lib/confirmation-claim';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Los valores de ANTES de lo que una tarjeta propone cambiar, para dibujar
 * «campo: antes → después». SOLO LEE: ninguna rama de este archivo escribe.
 *
 * Sólo contesta por una propuesta que de verdad está pendiente en la
 * conversación de la persona (la misma comprobación de la ruta de confirmar):
 * el id de fila sale de lo que Cortex propuso, no de lo que el navegador quiera
 * preguntar.
 */
const Body = z.object({
  conversationId: z.string().uuid(),
  toolId: z.string(),
  input: z.unknown(),
  toolCallId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 });
  const { conversationId, toolId, input, toolCallId } = parsed.data;
  const empty = NextResponse.json({ before: null });
  if (toolId !== 'trackers.upsert') return empty;
  const i = input as { tracker?: unknown; rowId?: unknown } | null;
  if (!i || typeof i.tracker !== 'string' || typeof i.rowId !== 'string') return empty;

  const db = getOrgScopedClient(user.organization.id);
  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .single();
  if (!conv) return NextResponse.json({ error: 'Conversación no disponible.' }, { status: 404 });
  const { data: rows } = await db
    .from('messages')
    .select('tool_results,parts')
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(20);
  const pending = (rows ?? []).some(
    (row) =>
      pendingConfirmationIndex(
        confirmationResults(row.tool_results, row.parts),
        toolId,
        input,
        toolCallId,
      ) >= 0,
  );
  if (!pending) return empty;

  const { data: tracker } = await db
    .from('trackers')
    .select('id,name,fields')
    .eq('slug', i.tracker)
    .maybeSingle();
  if (!tracker) return empty;
  const { data: row } = await db
    .from('tracker_rows')
    .select('label,values')
    .eq('id', i.rowId)
    .eq('tracker_id', tracker.id)
    .maybeSingle();
  if (!row) return empty;
  const fieldLabels: Record<string, string> = {};
  for (const f of Array.isArray(tracker.fields) ? tracker.fields : []) {
    const field = f as { key?: unknown; label?: unknown };
    if (typeof field.key === 'string' && typeof field.label === 'string')
      fieldLabels[field.key] = field.label;
  }
  return NextResponse.json({
    before: (row.values ?? {}) as Record<string, unknown>,
    rowLabel: row.label,
    trackerName: tracker.name,
    fieldLabels,
  });
}
