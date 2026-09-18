import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { buildToolContext } from '@/lib/agent';
import { claimApproval, supabaseApprovalStore } from '@/lib/approvals/claim';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import {
  type CustomToolResult,
  type CustomToolRow,
  EXECUTION_COLUMNS,
  SAFE_COLUMNS,
  customToolDef,
  runTool,
  toolIdAllowed,
} from '@cortex/agent-tools';
import { getManagementCase } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * The activation bridge deliberately has one effect path:
 *
 *   activation case + immutable Feed evidence
 *     -> exact company tool proposal
 *     -> existing mcp_pending_actions approval
 *     -> customToolDef + runTool (security, mandates, audit, rate limits)
 *     -> one read-only GET verifier
 *
 * It does not close a management case. A successful provider response is only
 * an attempt until the verifier returns the expected value. A timeout after a
 * possible provider effect becomes `outcome_unknown` and can only be
 * reconciled by another verifier read; it can never be retried blindly.
 */

const TOOL_ID = /^custom\.[a-z0-9][a-z0-9_-]{1,119}$/;
const PATH = /^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:\.(?:[A-Za-z_$][A-Za-z0-9_$]*|\d+))*$/;
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export const activationOperationStatusSchema = z.enum([
  'awaiting_approval',
  'executing',
  'verifying',
  'succeeded',
  'blocked',
  'failed',
  'cancelled',
  'outcome_unknown',
  'verification_failed',
]);
export type ActivationOperationStatus = z.infer<typeof activationOperationStatusSchema>;

const toolCallSchema = z.object({
  toolId: z.string().regex(TOOL_ID, 'La herramienta debe ser una herramienta de empresa válida.'),
  input: z.record(z.unknown()),
});

export const activationVerifierSchema = z
  .object({
    toolId: z.string().regex(TOOL_ID, 'El verificador debe ser una herramienta de empresa válida.'),
    input: z.record(z.unknown()),
    path: z
      .string()
      .trim()
      .max(240)
      .regex(PATH, 'Indica una ruta de lectura como data.estado o data.items.')
      .default('data'),
    match: z.enum(['equals', 'contains']).default('equals'),
    expected: z
      .any()
      .refine((value) => value !== undefined, 'El criterio esperado es obligatorio.'),
  })
  .superRefine((value, context) => {
    const parts = value.path.split('.');
    if (parts.some((part) => UNSAFE_PATH_SEGMENTS.has(part))) {
      context.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'La ruta de lectura no es segura.',
      });
    }
    if (value.match !== 'contains') return;
    if (typeof value.expected === 'string' && value.expected.trim().length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['expected'],
        message: 'contains necesita un texto no vacío.',
      });
    }
    if (Array.isArray(value.expected) && value.expected.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['expected'],
        message: 'contains necesita elementos.',
      });
    }
    if (
      value.expected &&
      typeof value.expected === 'object' &&
      !Array.isArray(value.expected) &&
      Object.keys(value.expected as Record<string, unknown>).length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expected'],
        message: 'contains necesita propiedades.',
      });
    }
  });

export const activationOperationPrepareSchema = z.object({
  action: z.literal('prepare'),
  caseId: z.string().uuid(),
  runId: z.string().uuid(),
  operation: toolCallSchema,
  verifier: activationVerifierSchema,
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

export const activationOperationDecisionSchema = z.object({
  action: z.enum(['approve', 'decline']),
  operationId: z.string().uuid(),
});

export const activationOperationReconcileSchema = z.object({
  action: z.literal('reconcile'),
  operationId: z.string().uuid(),
});

export type ActivationOperationPrepareInput = z.infer<typeof activationOperationPrepareSchema>;
export type ActivationVerifier = z.infer<typeof activationVerifierSchema>;

export type ActivationOperation = {
  id: string;
  organization_id: string;
  actor_id: string;
  agent_id: string;
  case_id: string;
  activation_run_id: string;
  action_tool_id: string;
  action_input: Record<string, unknown>;
  action_tool_snapshot: string;
  verifier_tool_id: string;
  verifier_input: Record<string, unknown>;
  verifier_path: string;
  verifier_match: 'equals' | 'contains';
  verifier_expected: unknown;
  verifier_tool_snapshot: string;
  source_evidence: Record<string, unknown>;
  intent_hash: string;
  idempotency_key: string;
  approval_id: string | null;
  approval_expires_at: string | null;
  status: ActivationOperationStatus;
  attempt: number;
  before_observation: unknown;
  action_result: unknown;
  verification_result: unknown;
  evidence: unknown;
  provider_ref: string | null;
  error: string | null;
  revision: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ActivationOperationView = ActivationOperation & {
  proposal: {
    action: { toolId: string; input: Record<string, unknown> };
    verifier: ActivationVerifier;
  };
};

export type ActivationToolOption = {
  toolId: string;
  name: string;
  description: string;
  httpMethod: CustomToolRow['http_method'];
  inputSchema: CustomToolRow['input_schema'];
  requiresConfirmation: boolean;
};

export type ActivationCaseOption = {
  id: string;
  title: string;
  state: string;
  evidenceRunId: string | null;
};

const OPERATION_COLUMNS =
  'id,organization_id,actor_id,agent_id,case_id,activation_run_id,action_tool_id,action_input,action_tool_snapshot,verifier_tool_id,verifier_input,verifier_path,verifier_match,verifier_expected,verifier_tool_snapshot,source_evidence,intent_hash,idempotency_key,approval_id,approval_expires_at,status,attempt,before_observation,action_result,verification_result,evidence,provider_ref,error,revision,started_at,completed_at,created_at,updated_at';
const APPROVAL_TTL_MS = 15 * 60_000;
const MAX_STORED_JSON = 40_000;
// Keep one operation comfortably below the route's 90-second ceiling. The
// provider's own timeout is still honoured, but this bridge never spends three
// full provider timeouts in one request.
const ACTION_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 10_000;
const RECOVERY_GRACE_MS = ACTION_TIMEOUT_MS + READ_TIMEOUT_MS + 15_000;

export class ActivationExecutionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ActivationExecutionError';
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** A safe fingerprint of a custom tool definition; secrets are excluded. */
export function customToolSnapshot(row: CustomToolRow): string {
  return digest({
    id: row.id,
    organization_id: row.organization_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    input_schema: row.input_schema,
    http_method: row.http_method,
    url_template: row.url_template,
    headers: row.headers,
    body_encoding: row.body_encoding,
    body_template: row.body_template,
    auth_type: row.auth_type,
    auth_header_name: row.auth_header_name,
    auth_username: row.auth_username,
    // A rotated credential can point to a different account even when every
    // visible request setting is unchanged. Store only its SHA-256 fingerprint
    // so the old approval is invalidated without persisting or returning the
    // encrypted secret itself.
    auth_secret_fingerprint: row.auth_secret_encrypted
      ? createHash('sha256').update(row.auth_secret_encrypted, 'utf8').digest('hex')
      : null,
    response_path: row.response_path,
    response_max_chars: row.response_max_chars,
    timeout_ms: row.timeout_ms,
    allow_insecure_http: row.allow_insecure_http,
    follow_redirects: row.follow_redirects,
    requires_confirmation: row.requires_confirmation,
    rate_limit_per_minute: row.rate_limit_per_minute,
    enabled: row.enabled,
  });
}

function limitJson(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length <= MAX_STORED_JSON) return value;
    return { truncated: true, excerpt: encoded.slice(0, MAX_STORED_JSON) };
  } catch {
    return { unavailable: true };
  }
}

function valueAtPath(value: unknown, path: string): unknown {
  if (!path || path === '$' || path === 'data') return value;
  const parts = path.split('.');
  let current: unknown = value;
  // The custom tool envelope is what the verifier receives. A path beginning
  // with data is convenient in the UI, while an empty/$ path checks all data.
  const keys = parts[0] === 'data' ? parts.slice(1) : parts;
  for (const key of keys) {
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
    else if (
      current &&
      typeof current === 'object' &&
      Object.prototype.hasOwnProperty.call(current, key)
    )
      current = (current as Record<string, unknown>)[key];
    else return undefined;
  }
  return current;
}

function deepContains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected);
  if (Array.isArray(actual)) return actual.some((entry) => deepEqual(entry, expected));
  if (actual && typeof actual === 'object' && expected && typeof expected === 'object') {
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      deepEqual((actual as Record<string, unknown>)[key], value),
    );
  }
  return false;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function verificationMatches(
  result: CustomToolResult | unknown,
  verifier: Pick<ActivationVerifier, 'path' | 'match' | 'expected'>,
): boolean {
  if (!result || typeof result !== 'object') return false;
  const envelope = result as CustomToolResult;
  if (envelope.ok !== true || envelope.truncated === true || verifier.expected === undefined)
    return false;
  const actual = valueAtPath(envelope.data, verifier.path);
  if (actual === undefined) return false;
  if (
    verifier.match === 'contains' &&
    ((typeof verifier.expected === 'string' && verifier.expected.trim().length === 0) ||
      (Array.isArray(verifier.expected) && verifier.expected.length === 0) ||
      (verifier.expected &&
        typeof verifier.expected === 'object' &&
        !Array.isArray(verifier.expected) &&
        Object.keys(verifier.expected as Record<string, unknown>).length === 0))
  )
    return false;
  return verifier.match === 'contains'
    ? deepContains(actual, verifier.expected)
    : deepEqual(actual, verifier.expected);
}

/**
 * A failed write with no trustworthy provider response cannot be classified as
 * "not applied". The caller must reconcile with the GET verifier before doing
 * anything else. 5xx and gateway timeout responses are included because an
 * upstream may have committed before its response was lost.
 */
export function isUnknownProviderResult(
  result: CustomToolResult | null | undefined,
  method: string,
): boolean {
  if (!result || result.ok || method.toUpperCase() === 'GET') return false;
  if (result.status === null || result.status === 408 || result.status === 504) return true;
  if (result.status >= 500) return true;
  return /timeout|timed out|no respondió|could not be reached|network|dns|tls|aborted/i.test(
    result.message ?? '',
  );
}

export function isVerificationUnavailable(result: CustomToolResult): boolean {
  if (result.ok) return false;
  if (
    result.status === null ||
    result.status === 408 ||
    result.status === 429 ||
    result.status >= 500
  )
    return true;
  return /timeout|timed out|no respondió|could not be reached|network|dns|tls|aborted/i.test(
    result.message ?? '',
  );
}

export function isStaleExecution(
  operation: Pick<ActivationOperation, 'status' | 'started_at'>,
  now = Date.now(),
): boolean {
  if (!['executing', 'verifying'].includes(operation.status)) return false;
  if (!operation.started_at) return false;
  const started = Date.parse(operation.started_at);
  return Number.isFinite(started) && now - started >= RECOVERY_GRACE_MS;
}

export function mapActivationOperation(row: ActivationOperation): ActivationOperationView {
  return {
    ...row,
    proposal: {
      action: { toolId: row.action_tool_id, input: row.action_input },
      verifier: {
        toolId: row.verifier_tool_id,
        input: row.verifier_input,
        path: row.verifier_path,
        match: row.verifier_match,
        expected: row.verifier_expected,
      },
    },
  };
}

function verifierFromOperation(operation: ActivationOperation): ActivationVerifier {
  return {
    toolId: operation.verifier_tool_id,
    input: operation.verifier_input,
    path: operation.verifier_path,
    match: operation.verifier_match,
    expected: operation.verifier_expected,
  };
}

async function readCustomTool(db: SupabaseClient, toolId: string): Promise<CustomToolRow | null> {
  if (!TOOL_ID.test(toolId)) return null;
  const slug = toolId.slice('custom.'.length);
  const result = await db
    .from('custom_tools')
    .select(EXECUTION_COLUMNS)
    .eq('slug', slug)
    .maybeSingle();
  if (result.error || !result.data) return null;
  return result.data as unknown as CustomToolRow;
}

async function readAgent(db: SupabaseClient, agentId?: string) {
  let query = db.from('agents').select('id,allowed_tool_ids,archived').eq('archived', false);
  query = agentId ? query.eq('id', agentId) : query.eq('slug', 'cortex');
  const result = await query.maybeSingle();
  if (result.error || !result.data) return null;
  return result.data as { id: string; allowed_tool_ids: string[] | null; archived: boolean };
}

/**
 * Tool choices shown by the activation panel. This is a projection of the
 * existing custom-tool catalogue and the existing agent/team access checks;
 * it never returns the encrypted credential or creates a second permission
 * policy for activations.
 */
export async function listActivationToolOptions(
  db: SupabaseClient,
  actorId: string,
): Promise<ActivationToolOption[]> {
  const agent = await readAgent(db);
  if (!agent) return [];
  const [toolsResult, denied] = await Promise.all([
    db
      .from('custom_tools')
      .select(SAFE_COLUMNS)
      .eq('enabled', true)
      .order('slug', { ascending: true })
      .limit(40),
    deniedToolPatterns(db, actorId, { failClosed: true }),
  ]);
  if (toolsResult.error)
    throw new ActivationExecutionError('No se pudieron cargar las herramientas de empresa.', 503);
  return ((toolsResult.data ?? []) as unknown as CustomToolRow[])
    .filter(
      (row) =>
        toolIdAllowed(agent.allowed_tool_ids ?? [], `custom.${row.slug}`) &&
        !isToolDenied(`custom.${row.slug}`, denied),
    )
    .map((row) => ({
      toolId: `custom.${row.slug}`,
      name: row.name,
      description: row.description,
      httpMethod: row.http_method,
      inputSchema: row.input_schema,
      requiresConfirmation: row.requires_confirmation,
    }));
}

async function assertToolAccess(
  db: SupabaseClient,
  actorId: string,
  agentId: string,
  row: CustomToolRow,
) {
  if (!row.enabled)
    throw new ActivationExecutionError('La herramienta de empresa está desactivada.', 409);
  const agent = await readAgent(db, agentId);
  if (
    !agent ||
    agent.id !== agentId ||
    !toolIdAllowed(agent.allowed_tool_ids ?? [], `custom.${row.slug}`)
  )
    throw new ActivationExecutionError(
      'Cortex ya no tiene permiso para usar esta herramienta.',
      403,
    );
  const denied = await deniedToolPatterns(db, actorId, { failClosed: true });
  if (isToolDenied(`custom.${row.slug}`, denied))
    throw new ActivationExecutionError('Tu equipo retiró el acceso a esta herramienta.', 403);
}

async function readActivationContext(
  db: SupabaseClient,
  actorId: string,
  caseId: string,
  runId: string,
) {
  const item = await getManagementCase(db, caseId);
  if (['verified', 'cancelled'].includes(item.data.state))
    throw new ActivationExecutionError(
      'El asunto ya está cerrado; reábrelo antes de preparar una operación.',
      409,
    );
  const runResult = await db
    .from('activation_runs')
    .select('id,actor_id,status,case_ids,source_id')
    .eq('id', runId)
    .eq('actor_id', actorId)
    .maybeSingle();
  if (runResult.error || !runResult.data)
    throw new ActivationExecutionError('La simulación no pertenece a esta persona o empresa.', 403);
  const run = runResult.data as {
    id: string;
    actor_id: string;
    status: string;
    case_ids: string[] | null;
    source_id: string;
  };
  if (run.status !== 'committed' || !(run.case_ids ?? []).includes(caseId))
    throw new ActivationExecutionError(
      'El asunto no está vinculado a una activación comprometida.',
      409,
    );
  const source = await db
    .from('chat_attachments')
    .select('id,created_by,purge_at')
    .eq('id', run.source_id)
    .eq('created_by', actorId)
    .maybeSingle();
  if (source.error)
    throw new ActivationExecutionError('No se pudo comprobar la vigencia de la fuente.', 503);
  const purgeAt =
    typeof source.data?.purge_at === 'string' ? Date.parse(source.data.purge_at) : Number.NaN;
  if (!source.data || !Number.isFinite(purgeAt) || purgeAt <= Date.now())
    throw new ActivationExecutionError(
      'La fuente de la activación venció. Simula una fuente vigente antes de preparar o ejecutar una escritura.',
      409,
    );
  const evidence = item.data.activationEvidence;
  if (!evidence || typeof evidence.runId !== 'string')
    throw new ActivationExecutionError('Falta la evidencia original de la activación.', 409);
  // `activation_commit_run` intentionally reuses an existing management case
  // when the same source identity appears in a later committed run. In that
  // case activationEvidence.runId names the original run and must remain
  // untouched; the current committed run + server-owned case_ids is the link
  // that authorizes this panel to propose work against it.
  return { item, run, evidence: structuredClone(evidence) as Record<string, unknown> };
}

async function readOperation(
  db: SupabaseClient,
  actorId: string,
  id: string,
): Promise<ActivationOperation | null> {
  const result = await db
    .from('activation_operations')
    .select(OPERATION_COLUMNS)
    .eq('id', id)
    .eq('actor_id', actorId)
    .maybeSingle();
  if (result.error) throw new ActivationExecutionError('No se pudo leer la operación.', 503);
  return (result.data as ActivationOperation | null) ?? null;
}

async function saveOperation(
  db: SupabaseClient,
  row: ActivationOperation,
  patch: Partial<ActivationOperation>,
  expectedStatuses?: ActivationOperationStatus[],
) {
  const next = {
    ...patch,
    revision: row.revision + 1,
    updated_at: new Date().toISOString(),
  };
  let query = db
    .from('activation_operations')
    .update(next)
    .eq('id', row.id)
    .eq('actor_id', row.actor_id)
    .eq('revision', row.revision);
  if (expectedStatuses?.length) query = query.in('status', expectedStatuses);
  const result = await query.select(OPERATION_COLUMNS).maybeSingle();
  if (result.error || !result.data)
    throw new ActivationExecutionError(
      'La operación cambió mientras se procesaba. Actualiza para ver su estado.',
      409,
    );
  return result.data as ActivationOperation;
}

async function prepareApproval(
  db: SupabaseClient,
  operation: ActivationOperation,
): Promise<ActivationOperation> {
  // A second prepare can observe the operation between its insert and the
  // approval link. Never return an unapprovable row: wait for the first writer
  // to finish its CAS link, then let the caller render the exact approval.
  if (operation.approval_id) return operation;
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  const approval = await db
    .from('mcp_pending_actions')
    .insert({
      user_id: operation.actor_id,
      agent_id: operation.agent_id,
      tool_id: operation.action_tool_id,
      input: operation.action_input,
      expires_at: expiresAt.toISOString(),
      // The row still lives in mcp_pending_actions and uses its atomic claim;
      // this origin only routes generic approval surfaces away from an
      // activation operation's mandatory verifier.
      staged_via: 'activation',
    })
    .select('id,expires_at')
    .single();
  if (approval.error || !approval.data) {
    await db
      .from('activation_operations')
      .update({
        status: 'blocked',
        error: 'No se pudo crear la aprobación.',
        completed_at: new Date().toISOString(),
      })
      .eq('id', operation.id)
      .eq('actor_id', operation.actor_id);
    throw new ActivationExecutionError(
      'No se pudo crear la aprobación. No se ejecutó ninguna herramienta.',
      503,
    );
  }
  const updated = await db
    .from('activation_operations')
    .update({
      approval_id: approval.data.id,
      approval_expires_at: approval.data.expires_at,
      updated_at: new Date().toISOString(),
      revision: operation.revision + 1,
    })
    .eq('id', operation.id)
    .eq('actor_id', operation.actor_id)
    .eq('revision', operation.revision)
    .select(OPERATION_COLUMNS)
    .maybeSingle();
  if (updated.error || !updated.data)
    throw new ActivationExecutionError(
      'La operación quedó pendiente de vincular a su aprobación. Actualiza antes de continuar.',
      409,
    );
  return updated.data as ActivationOperation;
}

async function waitForApprovalLink(
  db: SupabaseClient,
  actorId: string,
  operationId: string,
): Promise<ActivationOperation> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await readOperation(db, actorId, operationId);
    if (!current)
      throw new ActivationExecutionError('La operación desapareció mientras se preparaba.', 409);
    if (current.approval_id || current.status !== 'awaiting_approval') return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new ActivationExecutionError(
    'La propuesta aún está vinculando su aprobación. Actualiza en unos segundos.',
    409,
  );
}

export async function prepareActivationOperation(
  db: SupabaseClient,
  actorId: string,
  raw: unknown,
): Promise<ActivationOperationView> {
  const input = activationOperationPrepareSchema.parse(raw);
  const context = await readActivationContext(db, actorId, input.caseId, input.runId);
  const [actionTool, verifierTool, agent] = await Promise.all([
    readCustomTool(db, input.operation.toolId),
    readCustomTool(db, input.verifier.toolId),
    readAgent(db),
  ]);
  if (!actionTool || !verifierTool || !agent)
    throw new ActivationExecutionError(
      'La herramienta o el agente de la empresa ya no están disponibles.',
      404,
    );
  if (verifierTool.http_method !== 'GET' || verifierTool.requires_confirmation)
    throw new ActivationExecutionError(
      'El verificador debe ser una herramienta GET de solo lectura.',
      422,
    );
  await assertToolAccess(db, actorId, agent.id, actionTool);
  await assertToolAccess(db, actorId, agent.id, verifierTool);
  const actionDef = customToolDef(actionTool);
  const verifierDef = customToolDef(verifierTool);
  if (!actionDef.inputSchema.safeParse(input.operation.input).success)
    throw new ActivationExecutionError(
      'Los parámetros de la operación no coinciden con la herramienta.',
      422,
    );
  if (!verifierDef.inputSchema.safeParse(input.verifier.input).success)
    throw new ActivationExecutionError(
      'Los parámetros del verificador no coinciden con la herramienta.',
      422,
    );

  const actionSnapshot = customToolSnapshot(actionTool);
  const verifierSnapshot = customToolSnapshot(verifierTool);
  const intentHash = digest({
    caseId: input.caseId,
    runId: input.runId,
    sourceEvidence: context.evidence,
    operation: input.operation,
    verifier: input.verifier,
    actionSnapshot,
    verifierSnapshot,
  });
  const idempotencyKey =
    `activation:${input.caseId}:${input.runId}:${input.idempotencyKey ?? intentHash}`.slice(0, 300);
  const existing = await db
    .from('activation_operations')
    .select(OPERATION_COLUMNS)
    .eq('idempotency_key', idempotencyKey)
    .eq('actor_id', actorId)
    .maybeSingle();
  if (existing.error)
    throw new ActivationExecutionError('No se pudo comprobar una operación anterior.', 503);
  if (existing.data) {
    const existingOperation = existing.data as ActivationOperation;
    if (
      existingOperation.intent_hash !== intentHash ||
      existingOperation.case_id !== input.caseId ||
      existingOperation.activation_run_id !== input.runId
    )
      throw new ActivationExecutionError(
        'La clave de idempotencia ya pertenece a otra propuesta. Usa una clave nueva.',
        409,
      );
    const linked = await waitForApprovalLink(db, actorId, existingOperation.id);
    return mapActivationOperation(linked);
  }

  const created = await db
    .from('activation_operations')
    .insert({
      id: randomUUID(),
      actor_id: actorId,
      agent_id: agent.id,
      case_id: input.caseId,
      activation_run_id: input.runId,
      action_tool_id: input.operation.toolId,
      action_input: input.operation.input,
      action_tool_snapshot: actionSnapshot,
      verifier_tool_id: input.verifier.toolId,
      verifier_input: input.verifier.input,
      verifier_path: input.verifier.path,
      verifier_match: input.verifier.match,
      verifier_expected: input.verifier.expected,
      verifier_tool_snapshot: verifierSnapshot,
      source_evidence: context.evidence,
      intent_hash: intentHash,
      idempotency_key: idempotencyKey,
      status: 'awaiting_approval',
      attempt: 0,
      revision: 1,
    })
    .select(OPERATION_COLUMNS)
    .maybeSingle();
  if (created.error || !created.data) {
    const retry = await db
      .from('activation_operations')
      .select(OPERATION_COLUMNS)
      .eq('idempotency_key', idempotencyKey)
      .eq('actor_id', actorId)
      .maybeSingle();
    if (retry.data) {
      const retryOperation = retry.data as ActivationOperation;
      if (
        retryOperation.intent_hash !== intentHash ||
        retryOperation.case_id !== input.caseId ||
        retryOperation.activation_run_id !== input.runId
      )
        throw new ActivationExecutionError(
          'La clave de idempotencia ya pertenece a otra propuesta. Usa una clave nueva.',
          409,
        );
      const linked = await waitForApprovalLink(db, actorId, retryOperation.id);
      return mapActivationOperation(linked);
    }
    throw new ActivationExecutionError('No se pudo guardar la operación.', 503);
  }
  const operation = await prepareApproval(db, created.data as ActivationOperation);
  return mapActivationOperation(operation);
}

export async function listActivationOperations(
  db: SupabaseClient,
  actorId: string,
  options: { caseId?: string; runId?: string } = {},
) {
  let query = db
    .from('activation_operations')
    .select(OPERATION_COLUMNS)
    .eq('actor_id', actorId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (options.caseId) query = query.eq('case_id', options.caseId);
  if (options.runId) query = query.eq('activation_run_id', options.runId);
  const result = await query;
  if (result.error) throw new ActivationExecutionError('No se pudieron leer las operaciones.', 503);
  return ((result.data ?? []) as ActivationOperation[]).map(mapActivationOperation);
}

export async function listActivationCaseOptions(
  db: SupabaseClient,
  actorId: string,
  runId: string,
): Promise<ActivationCaseOption[]> {
  const run = await db
    .from('activation_runs')
    .select('id,status,case_ids,source_id')
    .eq('id', runId)
    .eq('actor_id', actorId)
    .maybeSingle();
  if (run.error)
    throw new ActivationExecutionError('No se pudo leer la activación comprometida.', 503);
  if (!run.data || run.data.status !== 'committed') return [];
  const source = await db
    .from('chat_attachments')
    .select('id,created_by,purge_at')
    .eq('id', run.data.source_id)
    .eq('created_by', actorId)
    .maybeSingle();
  if (source.error)
    throw new ActivationExecutionError('No se pudo comprobar la vigencia de la fuente.', 503);
  const purgeAt =
    typeof source.data?.purge_at === 'string' ? Date.parse(source.data.purge_at) : Number.NaN;
  if (!source.data || !Number.isFinite(purgeAt) || purgeAt <= Date.now()) return [];
  const ids = (run.data.case_ids as string[] | null) ?? [];
  if (ids.length === 0) return [];
  const cases = await db.from('management_cases').select('id,data').in('id', ids);
  if (cases.error)
    throw new ActivationExecutionError('No se pudieron cargar los asuntos de la activación.', 503);
  const byId = new Map(
    ((cases.data ?? []) as Array<{ id: string; data: Record<string, unknown> }>).map((item) => [
      item.id,
      item,
    ]),
  );
  return ids.flatMap((id) => {
    const item = byId.get(id);
    if (!item) return [];
    const evidence = item.data.activationEvidence;
    return [
      {
        id,
        title: typeof item.data.title === 'string' ? item.data.title : 'Asunto de activación',
        state: typeof item.data.state === 'string' ? item.data.state : 'open',
        evidenceRunId:
          evidence &&
          typeof evidence === 'object' &&
          typeof (evidence as Record<string, unknown>).runId === 'string'
            ? ((evidence as Record<string, unknown>).runId as string)
            : null,
      },
    ];
  });
}

export async function claimActivationApproval(
  db: SupabaseClient,
  actorId: string,
  operationId: string,
  decision: 'approve' | 'decline',
) {
  const operation = await readOperation(db, actorId, operationId);
  if (!operation)
    throw new ActivationExecutionError('La operación no existe en esta empresa.', 404);
  if (operation.status !== 'awaiting_approval' || !operation.approval_id)
    return mapActivationOperation(operation);

  const claimed = await claimApproval(supabaseApprovalStore(db), {
    id: operation.approval_id,
    userId: actorId,
    decision: decision === 'approve' ? 'approved' : 'declined',
    via: 'web',
    now: new Date(),
    requiredStagedVia: 'activation',
  });
  if (claimed.status !== 'claimed') {
    if (claimed.status === 'already_decided') {
      const current = await readOperation(db, actorId, operation.id);
      if (!current) throw new ActivationExecutionError('La operación ya no existe.', 409);
      if (current.status !== 'awaiting_approval') return mapActivationOperation(current);
      if (claimed.decision === 'declined') {
        const cancelled = await saveOperation(
          db,
          current,
          {
            status: 'cancelled',
            error: 'La persona rechazó la propuesta en otra superficie.',
            completed_at: new Date().toISOString(),
          },
          ['awaiting_approval'],
        );
        return mapActivationOperation(cancelled);
      }
      // A competing activation request may have won the approval claim just
      // before its operation CAS. Let the same execution path race on the
      // operation revision; only one caller can enter the effect boundary.
      return mapActivationOperation(
        await executeActivationOperation(db, current, current.action_input),
      );
    }
    if (claimed.status === 'unknown') {
      const current = await readOperation(db, actorId, operation.id);
      if (current && current.status !== 'awaiting_approval') return mapActivationOperation(current);
      if (current) {
        const marked = await saveOperation(
          db,
          current,
          {
            status: 'outcome_unknown',
            error: 'La aprobación desapareció antes de confirmar el punto de ejecución.',
            completed_at: new Date().toISOString(),
          },
          ['awaiting_approval'],
        );
        return mapActivationOperation(marked);
      }
      return mapActivationOperation(operation);
    }
    if (claimed.status === 'expired') {
      const marked = await saveOperation(
        db,
        operation,
        {
          status: 'blocked',
          error: 'La aprobación venció antes de ejecutarse. Prepara una propuesta nueva.',
          completed_at: new Date().toISOString(),
        },
        ['awaiting_approval'],
      );
      return mapActivationOperation(marked);
    }
    throw new ActivationExecutionError(
      'Solo la persona que preparó la operación puede aprobarla.',
      403,
    );
  }
  if (decision === 'decline') {
    const cancelled = await saveOperation(
      db,
      operation,
      {
        status: 'cancelled',
        error: 'La persona rechazó la propuesta.',
        completed_at: new Date().toISOString(),
      },
      ['awaiting_approval'],
    );
    return mapActivationOperation(cancelled);
  }
  return mapActivationOperation(
    await executeActivationOperation(db, operation, claimed.action.input),
  );
}

async function executeTool(
  db: SupabaseClient,
  operation: ActivationOperation,
  row: CustomToolRow,
  input: Record<string, unknown>,
  timeoutMs: number,
) {
  const context = buildToolContext({
    organizationId: operation.organization_id,
    userId: operation.actor_id,
    agentId: operation.agent_id,
    surface: 'web',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await runTool(customToolDef(row), input, context, {
    confirmed: true,
  })) as CustomToolResult;
}

async function assertCurrentDefinition(
  db: SupabaseClient,
  operation: ActivationOperation,
  actionTool: CustomToolRow,
  verifierTool: CustomToolRow,
) {
  if (!actionTool.enabled || !verifierTool.enabled)
    throw new ActivationExecutionError(
      'La herramienta cambió a desactivada después de aprobar.',
      409,
    );
  if (verifierTool.http_method !== 'GET' || verifierTool.requires_confirmation)
    throw new ActivationExecutionError('El verificador dejó de ser una lectura GET.', 409);
  if (
    customToolSnapshot(actionTool) !== operation.action_tool_snapshot ||
    customToolSnapshot(verifierTool) !== operation.verifier_tool_snapshot
  )
    throw new ActivationExecutionError(
      'La definición de una herramienta cambió después de preparar la propuesta. Revísala y apruébala de nuevo.',
      409,
    );
  await assertToolAccess(db, operation.actor_id, operation.agent_id, actionTool);
  await assertToolAccess(db, operation.actor_id, operation.agent_id, verifierTool);
}

async function assertCurrentContext(db: SupabaseClient, operation: ActivationOperation) {
  const context = await readActivationContext(
    db,
    operation.actor_id,
    operation.case_id,
    operation.activation_run_id,
  );
  if (digest(context.evidence) !== digest(operation.source_evidence))
    throw new ActivationExecutionError(
      'La evidencia del asunto cambió después de preparar la propuesta. Revísala y apruébala de nuevo.',
      409,
    );
}

/**
 * Reconciliation may outlive the temporary activation source and its run.
 * The operation owns the immutable evidence snapshot, while the shared case
 * remains the authorization anchor. Never require the private run to still be
 * present here: a stale provider result must remain auditable after retention
 * cleanup, and this path can only issue the read-only verifier.
 */
async function assertHistoricalContext(db: SupabaseClient, operation: ActivationOperation) {
  const item = await getManagementCase(db, operation.case_id);
  const evidence = item.data.activationEvidence;
  if (!evidence || digest(evidence) !== digest(operation.source_evidence))
    throw new ActivationExecutionError(
      'La evidencia del asunto ya no coincide con la operación. El resultado permanece desconocido.',
      409,
    );
}

/** The approval is immutable after claim, but re-read it at the effect edge. */
async function assertApprovalStillApproved(db: SupabaseClient, operation: ActivationOperation) {
  if (!operation.approval_id)
    throw new ActivationExecutionError('La operación no tiene una aprobación vinculada.', 409);
  const result = await db
    .from('mcp_pending_actions')
    .select('decision,user_id,agent_id,tool_id,input')
    .eq('id', operation.approval_id)
    .maybeSingle();
  if (result.error || !result.data)
    throw new ActivationExecutionError(
      'La aprobación ya no está disponible. No se ejecutó la herramienta.',
      409,
    );
  if (
    result.data.decision !== 'approved' ||
    result.data.user_id !== operation.actor_id ||
    result.data.agent_id !== operation.agent_id ||
    result.data.tool_id !== operation.action_tool_id ||
    digest(result.data.input) !== digest(operation.action_input)
  )
    throw new ActivationExecutionError(
      'La aprobación ya no coincide con esta propuesta. No se ejecutó la herramienta.',
      409,
    );
}

async function markBlocked(db: SupabaseClient, operation: ActivationOperation, error: string) {
  const current = await readOperation(db, operation.actor_id, operation.id);
  if (!current || ['succeeded', 'cancelled', 'failed'].includes(current.status))
    return current ?? operation;
  return saveOperation(
    db,
    current,
    {
      status: 'blocked',
      error: error.slice(0, 2000),
      completed_at: new Date().toISOString(),
    },
    ['awaiting_approval', 'executing', 'verifying', 'outcome_unknown', 'verification_failed'],
  );
}

async function markOutcomeUnknown(
  db: SupabaseClient,
  operation: ActivationOperation,
  error: string,
) {
  const current = await readOperation(db, operation.actor_id, operation.id);
  if (
    !current ||
    ['succeeded', 'cancelled', 'blocked', 'failed', 'outcome_unknown'].includes(current.status)
  )
    return current ?? operation;
  return saveOperation(
    db,
    current,
    {
      status: 'outcome_unknown',
      error: error.slice(0, 2000),
      completed_at: new Date().toISOString(),
      evidence: {
        source: current.source_evidence,
        before: current.before_observation,
        action: current.action_result,
        outcome: 'outcome_unknown',
        observedAt: new Date().toISOString(),
      },
    },
    ['executing', 'verifying'],
  );
}

async function markReconcileUnknown(
  db: SupabaseClient,
  operation: ActivationOperation,
  error: string,
) {
  const current = await readOperation(db, operation.actor_id, operation.id);
  if (!current || ['succeeded', 'cancelled'].includes(current.status)) return current ?? operation;
  return saveOperation(db, current, { status: 'outcome_unknown', error: error.slice(0, 2000) }, [
    'executing',
    'verifying',
    'outcome_unknown',
    'verification_failed',
  ]);
}

async function executeActivationOperation(
  db: SupabaseClient,
  initial: ActivationOperation,
  approvedInput: unknown,
) {
  let operation = initial;
  const actionInputHash = digest(approvedInput);
  if (actionInputHash !== digest(operation.action_input))
    return markBlocked(
      db,
      operation,
      'El contenido aprobado no coincide con la propuesta guardada.',
    );
  let actionTool = await readCustomTool(db, operation.action_tool_id);
  let verifierTool = await readCustomTool(db, operation.verifier_tool_id);
  if (!actionTool || !verifierTool)
    return markBlocked(db, operation, 'La herramienta o el verificador ya no existen.');
  try {
    await assertCurrentContext(db, operation);
    await assertCurrentDefinition(db, operation, actionTool, verifierTool);
  } catch (error) {
    return markBlocked(
      db,
      operation,
      error instanceof Error ? error.message : 'La propuesta quedó inválida.',
    );
  }

  // This CAS is the operation-side half of the existing atomic approval claim.
  // If another activation click won after the approval claim, return its state
  // instead of running the provider twice.
  try {
    operation = await saveOperation(
      db,
      operation,
      {
        status: 'executing',
        attempt: operation.attempt + 1,
        started_at: new Date().toISOString(),
        error: null,
      },
      ['awaiting_approval'],
    );
  } catch (error) {
    const current = await readOperation(db, operation.actor_id, operation.id);
    if (current && current.status !== 'awaiting_approval') return current;
    throw error;
  }

  // A pre-read makes retries idempotent: if the provider already reflects the
  // requested state, no write is sent after a crash or a lost response.
  let before: CustomToolResult;
  try {
    before = await executeTool(
      db,
      operation,
      verifierTool,
      operation.verifier_input,
      READ_TIMEOUT_MS,
    );
  } catch (error) {
    return markBlocked(
      db,
      operation,
      error instanceof Error ? error.message : 'No se pudo leer el estado previo.',
    );
  }
  operation = await saveOperation(
    db,
    operation,
    {
      before_observation: limitJson(before),
    },
    ['executing'],
  );
  if (!before.ok || before.truncated)
    return markBlocked(
      db,
      operation,
      before.truncated
        ? 'La lectura previa llegó incompleta. No se envió la escritura.'
        : (before.message ?? 'No se pudo leer el estado previo del proveedor.'),
    );
  if (verificationMatches(before, verifierFromOperation(operation))) {
    const completed = await saveOperation(
      db,
      operation,
      {
        status: 'succeeded',
        verification_result: limitJson(before),
        evidence: {
          source: operation.source_evidence,
          before: limitJson(before),
          after: limitJson(before),
          outcome: 'already_applied',
          observedAt: new Date().toISOString(),
        },
        completed_at: new Date().toISOString(),
      },
      ['executing'],
    );
    return completed;
  }

  // The read above may take seconds. Re-read the case, evidence, operation,
  // approval and both tool definitions at the edge where the write would occur.
  // A revoked permission, closed case, changed provider definition or
  // cancellation therefore stops before the external effect.
  const live = await readOperation(db, operation.actor_id, operation.id);
  if (!live)
    return markBlocked(db, operation, 'La operación dejó de estar disponible antes de ejecutar.');
  if (live.status !== 'executing') return live;
  operation = live;
  actionTool = await readCustomTool(db, operation.action_tool_id);
  verifierTool = await readCustomTool(db, operation.verifier_tool_id);
  if (!actionTool || !verifierTool)
    return markBlocked(
      db,
      operation,
      'La herramienta o el verificador ya no existen antes de ejecutar.',
    );
  try {
    await assertCurrentContext(db, operation);
    await assertCurrentDefinition(db, operation, actionTool, verifierTool);
    await assertApprovalStillApproved(db, operation);
  } catch (error) {
    return markBlocked(
      db,
      operation,
      error instanceof Error ? error.message : 'La propuesta quedó inválida antes de ejecutar.',
    );
  }

  let actionResult: CustomToolResult;
  try {
    actionResult = await executeTool(
      db,
      operation,
      actionTool,
      operation.action_input,
      ACTION_TIMEOUT_MS,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'La herramienta no devolvió resultado.';
    // The provider may have committed before the transport or handler threw.
    // Never classify this as a clean block and never retry the write; reconcile
    // can only issue the read-only verifier.
    return markOutcomeUnknown(db, operation, message);
  }
  operation = await saveOperation(
    db,
    operation,
    {
      action_result: limitJson(actionResult),
      status: 'verifying',
    },
    ['executing'],
  );

  let after: CustomToolResult;
  try {
    after = await executeTool(
      db,
      operation,
      verifierTool,
      operation.verifier_input,
      READ_TIMEOUT_MS,
    );
  } catch (error) {
    after = {
      ok: false,
      status: null,
      message: error instanceof Error ? error.message : 'No se pudo leer el resultado.',
    };
  }
  const matches = verificationMatches(after, verifierFromOperation(operation));
  const unknown =
    isUnknownProviderResult(actionResult, actionTool.http_method) ||
    after.truncated === true ||
    (!after.ok && isVerificationUnavailable(after));
  if (matches) {
    return saveOperation(
      db,
      operation,
      {
        status: 'succeeded',
        verification_result: limitJson(after),
        evidence: {
          source: operation.source_evidence,
          before: limitJson(before),
          action: limitJson(actionResult),
          after: limitJson(after),
          outcome: unknown ? 'reconciled_after_ambiguous_response' : 'verified',
          observedAt: new Date().toISOString(),
        },
        provider_ref:
          actionResult.data && typeof actionResult.data === 'object'
            ? String((actionResult.data as Record<string, unknown>).id ?? '') || null
            : null,
        completed_at: new Date().toISOString(),
      },
      ['verifying'],
    );
  }
  return saveOperation(
    db,
    operation,
    {
      status: unknown ? 'outcome_unknown' : actionResult.ok ? 'verification_failed' : 'failed',
      verification_result: limitJson(after),
      error: unknown
        ? 'El proveedor no confirmó si aplicó el cambio. Consulta el verificador; no se reintentará automáticamente.'
        : !actionResult.ok
          ? (actionResult.message ?? 'La herramienta no aplicó el cambio.')
          : 'La herramienta respondió, pero la lectura de verificación no coincide con el resultado esperado.',
      evidence: {
        source: operation.source_evidence,
        before: limitJson(before),
        action: limitJson(actionResult),
        after: limitJson(after),
        outcome: unknown ? 'outcome_unknown' : 'verification_failed',
        observedAt: new Date().toISOString(),
      },
      completed_at: new Date().toISOString(),
    },
    ['verifying'],
  );
}

export async function reconcileActivationOperation(
  db: SupabaseClient,
  actorId: string,
  operationId: string,
) {
  const operation = await readOperation(db, actorId, operationId);
  if (!operation)
    throw new ActivationExecutionError('La operación no existe en esta empresa.', 404);
  if (['executing', 'verifying'].includes(operation.status) && !isStaleExecution(operation))
    return mapActivationOperation(operation);
  if (
    !['executing', 'verifying', 'outcome_unknown', 'verification_failed'].includes(operation.status)
  )
    return mapActivationOperation(operation);
  const verifierTool = await readCustomTool(db, operation.verifier_tool_id);
  const actionTool = await readCustomTool(db, operation.action_tool_id);
  if (!verifierTool || !actionTool)
    return mapActivationOperation(
      await markReconcileUnknown(
        db,
        operation,
        'El verificador ya no existe; el resultado permanece desconocido.',
      ),
    );
  try {
    const agent = await readAgent(db, operation.agent_id);
    if (!agent)
      throw new ActivationExecutionError('El agente que aprobó la operación ya no existe.', 403);
    await assertHistoricalContext(db, operation);
    await assertCurrentDefinition(db, operation, actionTool, verifierTool);
  } catch (error) {
    return mapActivationOperation(
      await markReconcileUnknown(
        db,
        operation,
        error instanceof Error
          ? error.message
          : 'El contexto o el verificador cambió; el resultado permanece desconocido.',
      ),
    );
  }
  let result: CustomToolResult;
  try {
    // Reconciliation is deliberately read-only, including for a process that
    // died while it was in executing/verifying. No action tool is ever called.
    result = await executeTool(
      db,
      operation,
      verifierTool,
      operation.verifier_input,
      READ_TIMEOUT_MS,
    );
  } catch (error) {
    result = {
      ok: false,
      status: null,
      message: error instanceof Error ? error.message : 'No se pudo leer el verificador.',
    };
  }
  if (verificationMatches(result, verifierFromOperation(operation))) {
    const completed = await saveOperation(
      db,
      operation,
      {
        status: 'succeeded',
        verification_result: limitJson(result),
        evidence: {
          source: operation.source_evidence,
          action: limitJson(operation.action_result),
          after: limitJson(result),
          outcome: 'reconciled_read',
          observedAt: new Date().toISOString(),
        },
        error: null,
        completed_at: new Date().toISOString(),
      },
      ['executing', 'verifying', 'outcome_unknown', 'verification_failed'],
    );
    return mapActivationOperation(completed);
  }
  const unchanged = await saveOperation(
    db,
    operation,
    {
      status: 'outcome_unknown',
      verification_result: limitJson(result),
      error:
        result.message ?? 'La lectura no confirma el resultado. No se reintentará la escritura.',
    },
    ['executing', 'verifying', 'outcome_unknown', 'verification_failed'],
  );
  return mapActivationOperation(unchanged);
}
