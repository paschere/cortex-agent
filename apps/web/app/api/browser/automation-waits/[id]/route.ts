import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getCheckpoint, getWait, isCheckpointLive, resolveWait } from '@cortex/agent-tools';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * UNA AUTOMATIZACIÓN QUE ESPERA A UNA PERSONA (0214).
 *
 * GET dice qué se espera y, si es un trámite parado, entrega lo que la pantalla
 * necesita para atenderlo en la pestaña viva. POST `resolve` sólo vale para
 * «volver a iniciar sesión»: la persona avisa que ya entró al portal y la
 * corrida vuelve a la cola. Un trámite parado (código/captcha) se resuelve en
 * su propia pantalla y el barrido lo detecta; aquí no se da por resuelto a ciegas.
 *
 * Sólo la persona a quien se le avisó puede verla: la pestaña del navegador es
 * suya, y un enlace reenviado no debe servirle a otra.
 */
async function load(id: string) {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);
  const wait = await getWait(db, id);
  if (!wait || wait.notify_user_id !== session.id) return { session, db, wait: null };
  return { session, db, wait };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { db, wait } = await load(id);
  if (!wait) return NextResponse.json({ error: 'Esa espera no existe.' }, { status: 404 });

  let handoff: Record<string, unknown> | null = null;
  if (wait.state === 'waiting' && wait.kind === 'checkpoint' && wait.checkpoint_id) {
    const cp = await getCheckpoint(db, wait.checkpoint_id);
    if (cp && isCheckpointLive(cp))
      handoff = {
        sessionId: cp.sessionId,
        fromIndex: cp.fromIndex,
        expiresAt: cp.expiresAt,
        checkpointId: cp.id,
        reason: cp.reason,
        ask: cp.ask,
        fills: cp.fills,
      };
  }
  return NextResponse.json({
    id: wait.id,
    kind: wait.kind,
    state: wait.state,
    flow: wait.flow_name,
    ask: wait.ask,
    expiresAt: wait.expires_at,
    reason: wait.reason,
    handoff,
  });
}

const Body = z.object({ op: z.literal('resolve') });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { db, wait } = await load(id);
  if (!wait) return NextResponse.json({ error: 'Esa espera no existe.' }, { status: 404 });
  if (!Body.safeParse(await req.json().catch(() => null)).success)
    return NextResponse.json({ error: 'No entendí lo que llegó.' }, { status: 400 });
  if (wait.kind !== 'login')
    return NextResponse.json(
      { error: 'Esta espera se resuelve en la pantalla del trámite, no desde aquí.' },
      { status: 400 },
    );
  if (wait.state !== 'waiting')
    return NextResponse.json({ error: 'Esta espera ya no está abierta.' }, { status: 409 });
  const done = await resolveWait(
    db,
    wait,
    { ok: true, note: 'La persona volvió a iniciar sesión.' },
    new Date(),
  );
  return NextResponse.json({ ok: done });
}
