import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  deleteCredential,
  getFlow,
  listGrants,
  listRunSteps,
  listRuns,
  writeAuditEvent,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
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
 *
 * ---------------------------------------------------------------------------
 * DELETING ONE
 * ---------------------------------------------------------------------------
 * A learned errand is not an ordinary row. It can carry a company login, other
 * things can be pointing at it, and its run history is the record of a robot
 * acting with the company's identity on somebody else's system. So the GET also
 * answers "what would deleting this destroy" -- computed from the actual rows,
 * not guessed on the screen -- and the DELETE refuses rather than leave
 * something aiming at nothing.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The tools whose saved payload names a flow by slug. See browser/tools.ts. */
const FLOW_TOOLS = ['browser.run_flow', 'browser.submit_flow'];

/**
 * What is still pointing at this trámite.
 *
 * A scheduled job of `kind = 'tool'` stores the slug inside `tool_input`, so
 * this is exact. A job of `kind = 'agent'` carries only free text -- "sácame el
 * certificado de tradición" -- and cannot be resolved to a flow without
 * guessing; a fuzzy name match would block deletions for a coincidence of
 * words, which is worse than the gap. The gap is stated here rather than
 * papered over: an agent routine that named this errand in prose will start
 * failing softly, the way it already does when a portal changes.
 */
async function findDependents(db: SupabaseClient, slug: string): Promise<string[]> {
  const { data } = await db
    .from('scheduled_jobs')
    .select('name, status')
    .eq('kind', 'tool')
    .in('tool_id', FLOW_TOOLS)
    .eq('tool_input->>flow', slug)
    .in('status', ['active', 'paused']);

  return ((data as { name: string; status: string }[]) ?? []).map(
    (job) => `La rutina «${job.name}»${job.status === 'paused' ? ' (en pausa)' : ''}`,
  );
}

/** The other trámites that would be left without a login if it were deleted. */
async function otherFlowsUsingCredential(
  db: SupabaseClient,
  credentialId: string,
  exceptFlowId: string,
): Promise<string[]> {
  const { data } = await db
    .from('browser_flows')
    .select('id, name')
    .eq('credential_id', credentialId)
    .neq('id', exceptFlowId);
  return ((data as { name: string }[]) ?? []).map((row) => `«${row.name}»`);
}

async function countRows(db: SupabaseClient, table: string, column: string, value: string) {
  const { count } = await db
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(column, value);
  return count ?? 0;
}

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

  // ---- What deleting it would cost, in rows that actually exist -----------
  const isAdmin = session.role === 'org_admin';
  const [runCount, versionCount, dependents] = await Promise.all([
    countRows(db, 'browser_flow_runs', 'flow_id', flow.id),
    countRows(db, 'browser_flow_versions', 'flow_id', flow.id),
    findDependents(db, flow.slug),
  ]);

  let credential: { label: string; alsoUsedBy: string[] } | null = null;
  if (flow.credentialId) {
    const { data } = await db
      .from('browser_credentials')
      .select('label')
      .eq('id', flow.credentialId)
      .maybeSingle();
    credential = {
      label: (data as { label?: string } | null)?.label ?? 'sin nombre',
      alsoUsedBy: await otherFlowsUsingCredential(db, flow.credentialId, flow.id),
    };
  }

  const losing = [
    `Los pasos aprendidos y sus ${versionCount} ${versionCount === 1 ? 'versión' : 'versiones'}`,
    runCount === 0
      ? 'El detalle paso a paso de sus ejecuciones (todavía no tiene ninguna)'
      : `El detalle paso a paso de ${runCount} ${runCount === 1 ? 'ejecución' : 'ejecuciones'}: qué tocó, qué escribió y cuánto tardó`,
  ];
  if (grants.length > 0) {
    losing.push(
      `El permiso de ${grants.length} ${grants.length === 1 ? 'persona o rol' : 'personas o roles'} para correrlo`,
    );
  }
  losing.push('Hay que volver a grabar la pestaña para recuperarlo');

  // The audit trail of what the robot DID survives on purpose. Every run the
  // agent fired went through runTool, which writes to `audit_events` -- a table
  // with no foreign key to this one, so it is not swept along. That is the
  // right split: the procedure is ours to retire, the record of a machine
  // having acted as the company on a government portal is not.
  const keeping = [
    'El registro de auditoría: cada vez que el agente lo corrió, con quién lo pidió y qué devolvió',
    'Lo que el trámite ya haya producido: certificados descargados, radicados, informes',
  ];

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
    removal: {
      allowed: isAdmin,
      reason: isAdmin
        ? null
        : 'Sólo un administrador puede eliminarlo: puede llevar una clave de la empresa, y quien no puede ver esa clave tampoco decide su destino.',
      losing,
      keeping,
      credential,
      dependents,
    },
  });
}

/**
 * Eliminar un trámite.
 *
 * ---------------------------------------------------------------------------
 * WHO
 * ---------------------------------------------------------------------------
 * Org admins, and only them -- deliberately stricter than running one. The rule
 * for running (browser/access.ts) is that a flow with a credential is admins
 * only unless somebody was named; deciding the fate of that credential must be
 * at least as protected as spending it, and there is no reading of "may delete"
 * that should be looser than "may run".
 *
 * ---------------------------------------------------------------------------
 * WHAT GOES, AND WHAT DOES NOT
 * ---------------------------------------------------------------------------
 * The flow row cascades to its versions, its grants, its runs and their step
 * traces (migration 0087). The credential does NOT cascade -- the foreign key
 * is `on delete set null`, which is right when a login is shared and wrong when
 * it is not: a password nobody can reach any more, still encrypted in the
 * table, is exactly the leftover the caller has to be able to clean up. So the
 * credential is deleted on request, and only when no other flow still binds it.
 *
 * What survives is the record of what the robot actually did: `audit_events`
 * has no foreign key here, so every agent-triggered run stays readable in
 * /admin/audit after the procedure itself is gone. The deletion itself is
 * written there too -- retiring a machine's ability to act as the company is an
 * administrative act, and it should be answerable for later.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const started = performance.now();
  const session = await requireSession();
  if (session.role !== 'org_admin') {
    return NextResponse.json(
      { error: 'Sólo un administrador puede eliminar un trámite aprendido.' },
      { status: 403 },
    );
  }
  const db = getOrgScopedClient(session.organization.id);
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { deleteCredential?: boolean };

  const flow = await getFlow(db, id);
  if (!flow) return NextResponse.json({ error: 'Ese trámite ya no existe.' }, { status: 404 });

  const dependents = await findDependents(db, flow.slug);
  if (dependents.length > 0) {
    return NextResponse.json(
      {
        error: `Todavía hay algo apuntando a este trámite: ${dependents.join(', ')}. Quítalo de ahí y vuelve a intentarlo.`,
        dependents,
      },
      { status: 409 },
    );
  }

  const credentialId = flow.credentialId;
  const { error } = await db.from('browser_flows').delete().eq('id', id);
  if (error) {
    return NextResponse.json(
      { error: 'No pude eliminarlo. Vuelve a intentarlo en un momento.' },
      { status: 500 },
    );
  }

  // Order matters: the flow is gone first, so "does anything still use this
  // login" is asked of the world that remains rather than of the one that
  // included the row being deleted.
  let credentialRemoved = false;
  if (credentialId && body.deleteCredential) {
    const stillUsed = await otherFlowsUsingCredential(db, credentialId, id);
    if (stillUsed.length === 0) {
      await deleteCredential(db, credentialId);
      credentialRemoved = true;
    }
  }

  await writeAuditEvent({
    db,
    userId: session.id,
    toolId: 'browser.delete_flow',
    input: { flow: flow.slug },
    status: 'ok',
    latencyMs: Math.round(performance.now() - started),
    surface: 'web',
    riskLevel: 'high',
    decision: 'allowed',
    riskReason: `Eliminó el trámite «${flow.name}»${credentialRemoved ? ', y con él la clave de la empresa que usaba' : ''}.`,
    metadata: {
      flowId: id,
      slug: flow.slug,
      name: flow.name,
      host: flow.host,
      effect: flow.effect,
      hadCredential: Boolean(credentialId),
      credentialRemoved,
    },
  });

  return NextResponse.json({ ok: true, credentialRemoved });
}
