import { BATCH_LIMIT, approveApprovalsBatch, batchSummary } from '@/lib/follow-through/batch';
import { requireSession } from '@/lib/session';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * «Aprobar las N» en /approvals: varias llamadas paradas parecidas, aprobadas
 * de una vez. Es un bucle sobre la misma puerta de cada tarjeta — reclamo,
 * auditoría y ejecución, uno por uno (lib/follow-through/batch.ts). Nunca
 * repite a sabiendas: lo que repite algo ya hecho se aprueba en su tarjeta.
 */

const Body = z.object({
  ids: z.array(z.string().uuid()).min(1).max(BATCH_LIMIT),
});

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Lote inválido' }, { status: 400 });

  const results = await approveApprovalsBatch({
    organizationId: user.organization.id,
    userId: user.id,
    ids: parsed.data.ids,
  });
  return NextResponse.json({
    ok: results.every((r) => r.ok),
    results,
    summary: batchSummary(results),
  });
}
