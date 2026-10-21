import { enqueueJob } from '@/lib/jobs';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { verifySiigoWebhook, webhookShouldRunNow } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

/**
 * Aviso de Siigo (productos y existencias): despierta la sincronización de esa
 * conexión sin esperar al barrido de 15 minutos. La dirección lleva una firma
 * que sólo conoce el servidor (accounting/webhook.ts); el cuerpo del aviso no se
 * lee ni se guarda. Una corrida por minuto como mucho.
 */
export async function POST(
  _req: NextRequest,
  {
    params,
  }: { params: Promise<{ organizationId: string; connectionId: string; signature: string }> },
) {
  const p = z
    .object({
      organizationId: z.string().min(1).max(160),
      connectionId: z.string().uuid(),
      signature: z.string().min(16).max(80),
    })
    .safeParse(await params);
  if (!p.success || !verifySiigoWebhook(p.data.organizationId, p.data.connectionId, p.data.signature))
    return NextResponse.json({ error: 'Aviso no autorizado.' }, { status: 401 });

  const db = getOrgScopedClient(p.data.organizationId);
  const { data, error } = await db
    .from('accounting_connections')
    .select('id, provider, enabled, last_run_at')
    .eq('id', p.data.connectionId)
    .eq('provider', 'siigo')
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'No se pudo registrar el aviso.' }, { status: 503 });
  const conn = data as { id: string; enabled: boolean; last_run_at: string | null } | null;
  if (!conn?.enabled) return NextResponse.json({ error: 'Aviso no autorizado.' }, { status: 401 });

  // Vence ya: la toma de la corrida exige `next_run_at` vencido.
  const { error: updateError } = await db
    .from('accounting_connections')
    .update({ next_run_at: new Date().toISOString() })
    .eq('id', conn.id);
  if (updateError)
    return NextResponse.json({ error: 'No se pudo registrar el aviso.' }, { status: 503 });
  const runNow = webhookShouldRunNow(conn.last_run_at, new Date());
  if (runNow)
    await enqueueJob('accounting/run', {
      organizationId: p.data.organizationId,
      connectionId: conn.id,
    });
  return NextResponse.json(
    { accepted: true, immediate: runNow },
    { status: 202, headers: { 'Cache-Control': 'no-store' } },
  );
}
