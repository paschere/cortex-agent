import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { createHttpTransport, getFlow, runFlow } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Running a trámite from the screen.
 *
 * WHY THIS DOES NOT GO THROUGH THE APPROVAL CARD, and why that is not a hole.
 * The card exists because the MODEL can decide to call a tool and a person has
 * to be given the chance to say no first. Here the person IS the caller: they
 * are looking at what the flow does, they pressed the button, and an approval
 * dialog asking them to confirm the thing they just asked for is the kind of
 * ceremony that teaches people to click through dialogs.
 *
 * The gate that does apply is `canRunFlow` inside `runFlow`: a trámite carrying
 * a company credential is not runnable by somebody who has not been granted it,
 * from this screen or anywhere else.
 *
 * A `draft` flow IS runnable here, deliberately. That is how a propuesto
 * becomes probado: somebody with the context tries it. What a draft is not is
 * available to the agent -- see browser/tools.ts.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);
  const { id } = await params;

  const flow = await getFlow(db, id);
  if (!flow) return NextResponse.json({ error: 'Ese trámite no existe.' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { inputs?: Record<string, string> };

  const outcome = await runFlow({
    db,
    organizationId: session.organization.id,
    actor: { id: session.id, role: session.role },
    flow,
    inputs: body.inputs ?? {},
    transport: createHttpTransport(logger),
    logger,
    trigger: 'test',
  });

  return NextResponse.json({
    ok: outcome.ok,
    message: outcome.message,
    output: outcome.output,
    seconds: Math.round(outcome.durationMs / 100) / 10,
    costUsd: outcome.spend.costUsd,
    modelCalls: outcome.spend.calls,
    failureKind: outcome.failureKind ?? null,
    repaired: outcome.repaired ?? false,
    version: outcome.newVersion ?? flow.version,
  });
}
