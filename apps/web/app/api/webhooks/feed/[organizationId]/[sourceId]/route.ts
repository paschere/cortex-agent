import { validateFeedSignal } from '@/lib/feed/webhook';
import { enqueueJob } from '@/lib/jobs';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
export const runtime = 'nodejs';
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ organizationId: string; sourceId: string }> },
) {
  const ids = z
    .object({ organizationId: z.string().min(1).max(160), sourceId: z.string().uuid() })
    .safeParse(await params);
  const signal = validateFeedSignal(req.headers);
  if (!ids.success || !signal)
    return NextResponse.json({ error: 'Aviso no autorizado o vencido.' }, { status: 401 });
  // Authenticate in the same transaction that schedules work; do not read or
  // save provider payloads, and do not follow URLs supplied by the sender.
  const db = getOrgScopedClient(ids.data.organizationId);
  const result = await db.rpc('feed_source_signal', {
    p_source_id: ids.data.sourceId,
    p_token_hash: signal.tokenHash,
    p_event_id: signal.eventId,
  });
  if (result.error)
    return NextResponse.json({ error: 'No se pudo registrar el aviso.' }, { status: 503 });
  if (!result.data) return NextResponse.json({ error: 'Aviso no autorizado.' }, { status: 401 });
  if (!result.data.duplicate && !result.data.coalesced) {
    const due = await db
      .from('activation_automations')
      .select('id')
      .eq('source_connection_id', ids.data.sourceId)
      .eq('status', 'active')
      .limit(100);
    if (!due.error)
      await Promise.all(
        (due.data ?? []).map((row) =>
          enqueueJob('activations/run', {
            automationId: row.id,
            organizationId: ids.data.organizationId,
          }),
        ),
      );
  }
  return NextResponse.json(
    { accepted: true, duplicate: result.data.duplicate, nextScheduledScanWithinMinutes: 5 },
    { status: 202, headers: { 'Cache-Control': 'no-store' } },
  );
}
