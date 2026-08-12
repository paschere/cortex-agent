import { readDeliveries, writeDelivery } from '@/lib/browser-delivery';
import { DEFAULT_DELIVERY, type FlowDelivery } from '@/lib/browser-shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  alignFirstGoto,
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

  const [flows, latest, deliveries] = await Promise.all([
    listFlows(db),
    latestRunPerFlow(db),
    // The four columns of migration 0093 are not part of the errand, so the
    // engine's store does not carry them. One lookup for the whole listing.
    readDeliveries(db),
  ]);

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
        // The site wants a session this flow cannot create and no credential is
        // bound: it will ask rather than run. Exposed so the list can say so
        // before somebody presses the button.
        needsCredential: flow.loginRequired && !flow.credentialId,
        variables: flow.variables,
        stepCount: flow.steps.length,
        delivery: deliveries.get(flow.id) ?? DEFAULT_DELIVERY,
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
  /** Qué produce y dónde llega. Declarado en la revisión. See migration 0093. */
  delivery?: Partial<FlowDelivery>;
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
  // A tab capture has no address bar in it, so the URL the model wrote down is
  // the one thing on the review screen it could not have read -- and the person
  // corrects it there. That correction has to reach the first step as well,
  // which is what this does: otherwise the flow opens the address they typed
  // and then immediately navigates to the one the model imagined.
  const proposal = alignFirstGoto(parsed.data);

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

  // Before the proving run on purpose: `trigger: 'verify'` must never notify
  // anybody. Nobody wants an email announcing that the trámite they are
  // standing in front of, watching, has just been tested.
  if (body.delivery) await writeDelivery(db, flow.id, body.delivery);

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

  // The verification found a door, and this is the moment to say so: the person
  // who taught the errand is still on this screen and still remembers which
  // account they were signed in with. Asked ten minutes later, in a run that
  // failed at 3am, it is a support ticket.
  const needsCredential = outcome.failureKind === 'needs-login';

  return NextResponse.json({
    id: flow.id,
    status: flow.status,
    version: flow.version,
    verified: outcome.ok,
    refined: outcome.repaired ?? false,
    needsCredential,
    message: outcome.ok
      ? outcome.repaired
        ? `${outcome.message} Queda probado.`
        : 'Lo corrí contra el sitio y funcionó completo. Queda probado.'
      : needsCredential
        ? `${outcome.message} Lo guardé como propuesto: no está roto, le falta la cuenta.`
        : `Lo guardé, pero todavía no reproduce: ${outcome.message} Queda propuesto hasta que alguien lo ajuste y lo pruebe.`,
  });
}
