import type { SupabaseClient } from '@supabase/supabase-js';
import { originOf } from './credentials';
import type { FailureKind, Flow, ModelSpend, Step, StepOutcome, Variable } from './types';

/**
 * Reading and writing flows, versions and runs.
 *
 * Nothing here decides anything -- the decisions are in `classify.ts` and
 * `execute.ts`. What this file owns is the one invariant the schema cannot
 * express on its own: A FLOW'S STEPS AND ITS VERSION HISTORY MOVE TOGETHER.
 * Every path that changes `steps` goes through `writeVersion` below, which
 * bumps the number, appends the history row and clears `verified_at` in one
 * place. A repair that edited the column directly would leave a flow claiming
 * to be proven while running something nobody ever proved.
 */

const FLOW_COLUMNS = `
  id, organization_id, slug, name, description, start_url, host, effect, status, source,
  credential_id, variables, steps, version, verified_at, verified_run_id,
  repairs_in_window, repair_window_started_at, last_run_at, last_run_status, last_error,
  recording_frames, extraction_cost_usd, created_by, created_at, updated_at
`;

export function rowToFlow(row: Record<string, unknown>): Flow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: (row.description as string) ?? '',
    startUrl: row.start_url as string,
    host: row.host as string,
    effect: row.effect as Flow['effect'],
    status: row.status as Flow['status'],
    source: (row.source as Flow['source']) ?? 'recording',
    credentialId: (row.credential_id as string | null) ?? null,
    variables: (row.variables as Variable[]) ?? [],
    steps: (row.steps as Step[]) ?? [],
    version: (row.version as number) ?? 1,
    verifiedAt: (row.verified_at as string | null) ?? null,
    repairsInWindow: (row.repairs_in_window as number) ?? 0,
    repairWindowStartedAt: (row.repair_window_started_at as string | null) ?? null,
    lastRunAt: (row.last_run_at as string | null) ?? null,
    lastRunStatus: (row.last_run_status as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    recordingFrames: (row.recording_frames as number) ?? 0,
    extractionCostUsd: Number(row.extraction_cost_usd ?? 0),
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function listFlows(db: SupabaseClient): Promise<Flow[]> {
  const { data } = await db
    .from('browser_flows')
    .select(FLOW_COLUMNS)
    .order('updated_at', { ascending: false })
    .limit(200);
  return ((data as Record<string, unknown>[]) ?? []).map(rowToFlow);
}

export async function getFlow(db: SupabaseClient, id: string): Promise<Flow | null> {
  const { data } = await db.from('browser_flows').select(FLOW_COLUMNS).eq('id', id).maybeSingle();
  return data ? rowToFlow(data as Record<string, unknown>) : null;
}

export async function getFlowBySlug(db: SupabaseClient, slug: string): Promise<Flow | null> {
  const { data } = await db
    .from('browser_flows')
    .select(FLOW_COLUMNS)
    .eq('slug', slug)
    .maybeSingle();
  return data ? rowToFlow(data as Record<string, unknown>) : null;
}

export interface NewFlow {
  slug: string;
  name: string;
  description: string;
  startUrl: string;
  effect: Flow['effect'];
  variables: Variable[];
  steps: Step[];
  credentialId?: string | null;
  source?: Flow['source'];
  recordingFrames?: number;
  extractionCostUsd?: number;
  createdBy: string;
}

export async function createFlow(db: SupabaseClient, input: NewFlow): Promise<Flow> {
  const { data, error } = await db
    .from('browser_flows')
    .insert({
      slug: input.slug,
      name: input.name,
      description: input.description,
      start_url: input.startUrl,
      host: originOf(input.startUrl),
      effect: input.effect,
      // Always draft. A flow is propuesto until a replay has proven otherwise,
      // and there is no path in this file that lets a caller assert otherwise.
      status: 'draft',
      source: input.source ?? 'recording',
      credential_id: input.credentialId ?? null,
      variables: input.variables,
      steps: input.steps,
      version: 1,
      recording_frames: input.recordingFrames ?? 0,
      extraction_cost_usd: input.extractionCostUsd ?? 0,
      created_by: input.createdBy,
    })
    .select(FLOW_COLUMNS)
    .single();
  if (error) throw new Error(error.message);

  const flow = rowToFlow(data as Record<string, unknown>);
  await db.from('browser_flow_versions').insert({
    flow_id: flow.id,
    version: 1,
    steps: input.steps,
    variables: input.variables,
    reason: input.source === 'manual' ? 'edited' : 'recorded',
    note:
      input.source === 'manual'
        ? 'Escrito a mano.'
        : `Leído de una grabación de ${input.recordingFrames ?? 0} cuadros.`,
    created_by: input.createdBy,
  });
  return flow;
}

/**
 * The only way `steps` ever changes.
 *
 * Bumps the version, appends the history row and clears the proof -- because a
 * verification belongs to one particular step list and stops meaning anything
 * the moment the list is different. A repair therefore drops a flow back to
 * "probado hasta la versión anterior", and the run that follows re-earns it.
 */
export async function writeVersion(
  db: SupabaseClient,
  flow: Flow,
  input: {
    steps: Step[];
    variables?: Variable[];
    reason: 'refined' | 'repaired' | 'drifted' | 'edited';
    changedStep?: number;
    note: string;
    by: string | null;
  },
): Promise<number> {
  const version = flow.version + 1;
  const variables = input.variables ?? flow.variables;

  await db
    .from('browser_flows')
    .update({
      steps: input.steps,
      variables,
      version,
      // Drift is the one reason that does NOT invalidate the proof: the step
      // list is materially the same procedure with one selector reordered, and
      // the run that discovered the drift is the run that just completed it.
      ...(input.reason === 'drifted' ? {} : { verified_at: null, verified_run_id: null }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', flow.id);

  await db.from('browser_flow_versions').insert({
    flow_id: flow.id,
    version,
    steps: input.steps,
    variables,
    reason: input.reason,
    changed_step: input.changedStep ?? null,
    note: input.note,
    created_by: input.by,
  });
  return version;
}

export async function markVerified(
  db: SupabaseClient,
  flowId: string,
  runId: string,
): Promise<void> {
  await db
    .from('browser_flows')
    .update({
      status: 'ready',
      verified_at: new Date().toISOString(),
      verified_run_id: runId,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', flowId);
}

export async function markBroken(db: SupabaseClient, flowId: string, why: string): Promise<void> {
  await db
    .from('browser_flows')
    .update({ status: 'broken', last_error: why, updated_at: new Date().toISOString() })
    .eq('id', flowId);
}

export async function noteRun(
  db: SupabaseClient,
  flowId: string,
  status: string,
  error: string | null,
): Promise<void> {
  await db
    .from('browser_flows')
    .update({
      last_run_at: new Date().toISOString(),
      last_run_status: status,
      last_error: error,
      updated_at: new Date().toISOString(),
    })
    .eq('id', flowId);
}

/**
 * Repair thrash control.
 *
 * A flow repaired three times in a day is not drifting, it is being rewritten
 * by a model against a page nobody has looked at -- and each rewrite is
 * measured only by "the run finished", which a page can satisfy while doing the
 * wrong thing. The fourth attempt stops and asks for a person instead.
 */
const REPAIR_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_REPAIRS_PER_WINDOW = 3;

export function repairsExhausted(flow: Flow, now = Date.now()): boolean {
  if (!flow.repairWindowStartedAt) return false;
  const started = new Date(flow.repairWindowStartedAt).getTime();
  if (now - started > REPAIR_WINDOW_MS) return false;
  return flow.repairsInWindow >= MAX_REPAIRS_PER_WINDOW;
}

export async function countRepair(db: SupabaseClient, flow: Flow, now = Date.now()): Promise<void> {
  const started = flow.repairWindowStartedAt ? new Date(flow.repairWindowStartedAt).getTime() : 0;
  const fresh = !flow.repairWindowStartedAt || now - started > REPAIR_WINDOW_MS;
  await db
    .from('browser_flows')
    .update({
      repairs_in_window: fresh ? 1 : flow.repairsInWindow + 1,
      repair_window_started_at: fresh ? new Date(now).toISOString() : flow.repairWindowStartedAt,
    })
    .eq('id', flow.id);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunRow {
  id: string;
  flowId: string;
  flowVersion: number;
  mode: string;
  status: string;
  trigger: string;
  inputs: Record<string, string>;
  result: Record<string, unknown> | null;
  failureKind: FailureKind | null;
  error: string | null;
  updatedFlow: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  modelCalls: number;
  modelCostUsd: number;
  startedBy: string | null;
}

export function rowToRun(row: Record<string, unknown>): RunRow {
  return {
    id: row.id as string,
    flowId: row.flow_id as string,
    flowVersion: row.flow_version as number,
    mode: row.mode as string,
    status: row.status as string,
    trigger: row.trigger as string,
    inputs: (row.inputs as Record<string, string>) ?? {},
    result: (row.result as Record<string, unknown> | null) ?? null,
    failureKind: (row.failure_kind as FailureKind | null) ?? null,
    error: (row.error as string | null) ?? null,
    updatedFlow: Boolean(row.updated_flow),
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
    modelCalls: (row.model_calls as number) ?? 0,
    modelCostUsd: Number(row.model_cost_usd ?? 0),
    startedBy: (row.started_by as string | null) ?? null,
  };
}

const RUN_COLUMNS = `
  id, flow_id, flow_version, mode, status, trigger, inputs, result, failure_kind, error,
  updated_flow, started_at, finished_at, duration_ms, model_calls, model_cost_usd, started_by
`;

export async function startRun(
  db: SupabaseClient,
  input: {
    organizationId: string;
    flowId: string;
    flowVersion: number;
    mode: string;
    trigger: string;
    inputs: Record<string, string>;
    startedBy: string;
  },
): Promise<string> {
  const { data, error } = await db
    .from('browser_flow_runs')
    .insert({
      organization_id: input.organizationId,
      flow_id: input.flowId,
      flow_version: input.flowVersion,
      mode: input.mode,
      status: 'running',
      trigger: input.trigger,
      inputs: input.inputs,
      started_by: input.startedBy,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

export async function finishRun(
  db: SupabaseClient,
  runId: string,
  input: {
    status: 'succeeded' | 'failed';
    result?: Record<string, unknown> | null;
    failureKind?: FailureKind | null;
    error?: string | null;
    durationMs: number;
    spend: ModelSpend;
    updatedFlow?: boolean;
  },
): Promise<void> {
  await db
    .from('browser_flow_runs')
    .update({
      status: input.status,
      result: input.result ?? null,
      failure_kind: input.failureKind ?? null,
      error: input.error ?? null,
      finished_at: new Date().toISOString(),
      duration_ms: input.durationMs,
      model_calls: input.spend.calls,
      model_input_tokens: input.spend.inputTokens,
      model_output_tokens: input.spend.outputTokens,
      model_cost_usd: input.spend.costUsd,
      updated_flow: input.updatedFlow ?? false,
    })
    .eq('id', runId);
}

/**
 * The step-by-step trace.
 *
 * `valuePreview` arrives already redacted -- the browser service produced it
 * from `resolveValue`, which emits '***' for a secret and never the characters.
 * Nothing in this function can un-redact it, and nothing in this function reads
 * a secret to compare against, which is the point.
 */
export async function recordSteps(
  db: SupabaseClient,
  runId: string,
  steps: StepOutcome[],
): Promise<void> {
  if (steps.length === 0) return;
  await db.from('browser_flow_run_steps').insert(
    steps.map((s) => ({
      run_id: runId,
      step_index: s.index,
      action: s.action,
      label: s.label,
      url: s.url,
      matched_target: s.matchedTarget,
      matched_rank: s.matchedRank,
      value_preview: s.valuePreview,
      ok: s.ok,
      duration_ms: s.durationMs,
      error: s.error ?? null,
    })),
  );
}

export async function listRuns(db: SupabaseClient, flowId: string, limit = 20): Promise<RunRow[]> {
  const { data } = await db
    .from('browser_flow_runs')
    .select(RUN_COLUMNS)
    .eq('flow_id', flowId)
    .order('started_at', { ascending: false })
    .limit(limit);
  return ((data as Record<string, unknown>[]) ?? []).map(rowToRun);
}

export async function latestRunPerFlow(db: SupabaseClient): Promise<Map<string, RunRow>> {
  const { data } = await db
    .from('browser_flow_runs')
    .select(RUN_COLUMNS)
    .order('started_at', { ascending: false })
    .limit(400);
  const out = new Map<string, RunRow>();
  for (const row of (data as Record<string, unknown>[]) ?? []) {
    const run = rowToRun(row);
    if (!out.has(run.flowId)) out.set(run.flowId, run);
  }
  return out;
}

export async function listRunSteps(
  db: SupabaseClient,
  runId: string,
): Promise<Record<string, unknown>[]> {
  const { data } = await db
    .from('browser_flow_run_steps')
    .select(
      'step_index, action, label, url, matched_target, matched_rank, value_preview, ok, duration_ms, error',
    )
    .eq('run_id', runId)
    .order('step_index', { ascending: true });
  return (data as Record<string, unknown>[]) ?? [];
}
