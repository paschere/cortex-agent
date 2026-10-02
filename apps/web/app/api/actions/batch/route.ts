import {
  BATCH_LIMIT,
  approveActionsBatch,
  batchSummary,
  dismissActionsBatch,
} from '@/lib/follow-through/batch';
import { requireSession } from '@/lib/session';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Lotes en /actions: «Aprobar los 6» cobros parecidos, o «Descartar los 3» que
 * llevan días esperando.
 *
 * Aprobar exige, por cada borrador, la huella del texto que la persona tenía
 * en pantalla — la misma condición que el botón de su tarjeta. Sin ella no se
 * aprueba nada: un lote no es una manera de aprobar sin haber visto.
 */

const Hash = z.string().regex(/^[0-9a-f]{64}$/);

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    items: z
      .array(z.object({ id: z.string().uuid(), contentHash: Hash }))
      .min(1)
      .max(BATCH_LIMIT),
  }),
  z.object({
    action: z.literal('dismiss'),
    ids: z.array(z.string().uuid()).min(1).max(BATCH_LIMIT),
    reason: z.string().trim().min(1).max(400).optional(),
  }),
]);

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Lote inválido' }, { status: 400 });

  if (parsed.data.action === 'approve') {
    const results = await approveActionsBatch({
      organizationId: user.organization.id,
      userId: user.id,
      items: parsed.data.items,
    });
    return NextResponse.json({
      ok: results.every((r) => r.ok),
      results,
      summary: batchSummary(results),
    });
  }
  const results = await dismissActionsBatch({
    organizationId: user.organization.id,
    userId: user.id,
    ids: parsed.data.ids,
    reason: parsed.data.reason ?? 'Descartada: llevaba días esperando.',
  });
  return NextResponse.json({
    ok: results.every((r) => r.ok),
    results,
    summary: batchSummary(results, 'Descarté'),
  });
}
