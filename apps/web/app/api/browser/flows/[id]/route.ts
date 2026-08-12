import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getFlow, listGrants, listRunSteps, listRuns } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * One trámite in full: its steps, who may run it, and what the last few
 * executions actually did.
 *
 * The step trace is the audit surface. A robot acting with the company's
 * identity on a government portal has to be answerable for afterwards, and the
 * answer is here: which page it was on, which selector matched (and whether it
 * was the preferred one), what it typed, and how long each step took. The
 * `value_preview` column is already redacted at the point it was written --
 * there is no un-redaction anywhere and nothing here reads a credential.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);
  const { id } = await params;

  const flow = await getFlow(db, id);
  if (!flow) return NextResponse.json({ error: 'Ese trámite no existe.' }, { status: 404 });

  const runs = await listRuns(db, flow.id, 15);
  const lastRun = runs[0];
  const trace = lastRun ? await listRunSteps(db, lastRun.id) : [];
  const grants = await listGrants(db, flow.id);

  return NextResponse.json({
    flow: {
      id: flow.id,
      slug: flow.slug,
      name: flow.name,
      description: flow.description,
      startUrl: flow.startUrl,
      site: flow.host,
      effect: flow.effect,
      status: flow.status,
      version: flow.version,
      verifiedAt: flow.verifiedAt,
      source: flow.source,
      hasCredential: Boolean(flow.credentialId),
      credentialId: flow.credentialId,
      variables: flow.variables,
      steps: flow.steps,
      lastError: flow.lastError,
      recordingFrames: flow.recordingFrames,
      extractionCostUsd: flow.extractionCostUsd,
    },
    grants,
    runs: runs.map((run) => ({
      id: run.id,
      mode: run.mode,
      status: run.status,
      trigger: run.trigger,
      startedAt: run.startedAt,
      seconds: run.durationMs ? Math.round(run.durationMs / 100) / 10 : null,
      costUsd: run.modelCostUsd,
      modelCalls: run.modelCalls,
      failureKind: run.failureKind,
      error: run.error,
      updatedFlow: run.updatedFlow,
      inputs: run.inputs,
    })),
    trace,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await requireSession();
  if (session.role !== 'org_admin') {
    return NextResponse.json(
      { error: 'Sólo un administrador puede borrar un trámite aprendido.' },
      { status: 403 },
    );
  }
  const db = getOrgScopedClient(session.organization.id);
  const { id } = await params;
  await db.from('browser_flows').delete().eq('id', id);
  return NextResponse.json({ ok: true });
}
