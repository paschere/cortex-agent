import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  createFlow,
  createHttpTransport,
  getFlow,
  latestRunPerFlow,
  listFlows,
  proposalSchema,
  runFlow,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * The list of learned trámites, and the endpoint that turns a proposal into one.
 *
 * ---------------------------------------------------------------------------
 * A PROPOSAL IS NOT A TRÁMITE UNTIL IT HAS REPRODUCED
 * ---------------------------------------------------------------------------
 * POST does not just insert a row. It creates the flow as `draft`, then
 * immediately runs it against the real site with the same values the person
 * used while teaching, and only a clean end-to-end replay flips it to `ready`.
 * The response says which happened, and the screen says PROBADO or PROPUESTO
 * accordingly.
 *
 * That ordering is the whole point of a video-derived flow. A model reading
 * pictures produces something plausible every time; plausible and correct are
 * different, and the only thing that can tell them apart is the site itself.
 * Storing the proposal and letting somebody discover next month that it never
 * worked would be the same failure as a library that rots silently, just
 * arriving earlier.
 *
 * If the first replay fails on a step the model misread, the verification pass
 * shows it the live page and lets it correct that one step (`verifying: true`
 * in execute.ts) -- and then the corrected flow has to reproduce too. Two
 * attempts, then it stays propuesto with the failing step named.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: stripping combining marks is the intent
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'tramite'
  );
}

export async function GET(): Promise<NextResponse> {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);

  const [flows, latest] = await Promise.all([listFlows(db), latestRunPerFlow(db)]);

  return NextResponse.json({
    flows: flows.map((flow) => {
      const run = latest.get(flow.id);
      return {
        id: flow.id,
        slug: flow.slug,
        name: flow.name,
        description: flow.description,
        site: flow.host,
        startUrl: flow.startUrl,
        effect: flow.effect,
        status: flow.status,
        version: flow.version,
        verifiedAt: flow.verifiedAt,
        hasCredential: Boolean(flow.credentialId),
        variables: flow.variables,
        stepCount: flow.steps.length,
        lastRunAt: flow.lastRunAt,
        lastRunStatus: flow.lastRunStatus,
        lastError: flow.lastError,
        lastRunSeconds: run?.durationMs ? Math.round(run.durationMs / 100) / 10 : null,
        lastRunCostUsd: run ? run.modelCostUsd : null,
      };
    }),
  });
}

interface Body {
  proposal?: unknown;
  /** Values to verify with. Not stored; used once, for the proving run. */
  sample?: Record<string, string>;
  credentialId?: string | null;
  frames?: number;
  costUsd?: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);

  const body = (await req.json().catch(() => ({}))) as Body;
  const parsed = proposalSchema.safeParse(body.proposal);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Esa propuesta no tiene una forma válida. Revisa los pasos y vuelve a guardar.' },
      { status: 400 },
    );
  }
  const proposal = parsed.data;

  let flow = await createFlow(db, {
    slug: slugify(proposal.name),
    name: proposal.name,
    description: proposal.description,
    startUrl: proposal.startUrl,
    effect: proposal.effect,
    variables: proposal.variables,
    steps: proposal.steps,
    credentialId: body.credentialId ?? null,
    source: 'recording',
    recordingFrames: body.frames ?? 0,
    extractionCostUsd: body.costUsd ?? 0,
    createdBy: session.id,
  }).catch((err: unknown) => {
    logger.error({ err: (err as Error).message }, 'could not create a browser flow');
    return null;
  });

  if (!flow) {
    return NextResponse.json(
      { error: 'Ya existe un trámite con ese nombre. Ponle otro y vuelve a guardar.' },
      { status: 409 },
    );
  }

  // The proving run. Same machinery as any other execution, pointed at a flow
  // nobody has vouched for yet -- see `verifying` in execute.ts for the two
  // behaviours it changes.
  const outcome = await runFlow({
    db,
    organizationId: session.organization.id,
    actor: { id: session.id, role: session.role },
    flow,
    inputs: body.sample ?? {},
    transport: createHttpTransport(logger),
    logger,
    trigger: 'verify',
    verifying: true,
  });

  flow = (await getFlow(db, flow.id)) ?? flow;

  return NextResponse.json({
    id: flow.id,
    status: flow.status,
    version: flow.version,
    verified: outcome.ok,
    refined: outcome.repaired ?? false,
    message: outcome.ok
      ? outcome.repaired
        ? `${outcome.message} Queda probado.`
        : 'Lo corrí contra el sitio y funcionó completo. Queda probado.'
      : `Lo guardé, pero todavía no reproduce: ${outcome.message} Queda propuesto hasta que alguien lo ajuste y lo pruebe.`,
  });
}
