import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { listPlans } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

/**
 * Somebody asked for a bigger plan.
 *
 * There is no gateway to send them to, so this records the request rather than
 * pretending to charge for it — in `audit_events`, which is already the
 * workspace's own log of things done inside it, scoped like everything else. No
 * new table for a row that is a note.
 *
 * The plan code is validated against the catalogue rather than trusted, so a
 * hand-made request cannot write an arbitrary string into somebody's audit log.
 */
const Body = z.object({ planCode: z.string().min(1).max(40) });

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Falta el plan.' }, { status: 400 });
  }

  const plans = await listPlans(db);
  const wanted = plans.find((p) => p.code === parsed.data.planCode && p.selfServe);
  if (!wanted) {
    return NextResponse.json({ error: 'Ese plan no existe.' }, { status: 404 });
  }

  const { error } = await db.from('audit_events').insert({
    user_id: user.id,
    tool_id: '__plan_interest',
    input_hash: wanted.code,
    status: 'ok',
    latency_ms: 0,
    surface: 'web',
    metadata: {
      planCode: wanted.code,
      planName: wanted.name,
      priceCop: wanted.priceCop,
      askedBy: user.email,
    },
  });
  if (error) {
    return NextResponse.json({ error: 'No se pudo anotar.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
