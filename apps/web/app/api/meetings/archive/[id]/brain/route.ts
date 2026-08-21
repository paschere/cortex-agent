import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { dropLiveCallFromBrain, keepLiveCallInBrain } from '@cortex/agent-tools';
import { type UUID, logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 120;

const Body = z.object({ action: z.enum(['keep', 'drop']) });

/**
 * La persona le da la vuelta al veredicto de Cortex sobre una llamada:
 * «guárdala en Brain Knowledge» o «sácala». La llamada y su transcript
 * siguen en Llamadas en ambos casos; lo que cambia es si la memoria de la
 * empresa la encuentra.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'action debe ser keep o drop' }, { status: 400 });
  }
  const toolCtx = {
    organizationId: user.organization.id,
    userId: user.id as UUID,
    db: getOrgScopedClient(user.organization.id),
    logger,
    // El archivo no toca integraciones; el tipo las pide por herencia del import de Meet.
    integrations: {
      getAccessToken: async () => {
        throw new Error('unused');
      },
      hasScopes: async () => false,
    },
  };
  try {
    if (parsed.data.action === 'keep') {
      const { documentId } = await keepLiveCallInBrain(toolCtx, id);
      return NextResponse.json({ ok: true, brainStatus: 'kept', documentId });
    }
    await dropLiveCallFromBrain(toolCtx, id);
    return NextResponse.json({ ok: true, brainStatus: 'skipped', documentId: null });
  } catch (err) {
    logger.warn({ err: (err as Error).message, callId: id }, 'live call brain override failed');
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
