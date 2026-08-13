/**
 * The enforcement glue between `runTool` and the risk model.
 *
 * Everything the choke point needs is here so registry.ts stays readable:
 * evaluate (classify + policy + frequency), turn the verdict into audit
 * columns, and record incidents in `security_events`.
 *
 * Latency budget: `evaluate()` issues AT MOST one round-trip of latency —
 * the policy load and the frequency count are fired in parallel, both are
 * memoised for 60s, and the frequency count is skipped outright for
 * non-sensitive tools. A low-risk call with warm caches costs zero queries.
 */

import { type UUID, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hashInput } from '../audit.js';
import { isHighFrequency, noteSensitiveCall, sensitiveCallCount } from './frequency.js';
import { loadMandates } from './mandate-store.js';
import { type MandateGrant, type MandateTool, applyMandate } from './mandate.js';
import {
  type Classification,
  DEFAULT_POLICY,
  type Decision,
  type RiskSignal,
  type SecurityPolicy,
  type Surface,
  classify,
  decide,
  explainBlock,
  explainFlag,
  isSensitiveFamily,
} from './policy.js';
import { loadPolicy } from './store.js';

/**
 * What lands in `audit_events.decision` — see migration 0042, and 0099 for
 * `delegated`.
 *
 * `delegated` es un valor NUEVO junto a los cuatro de siempre, y no un
 * `allowed` con adorno: significa «esto iba a preguntarte y no te preguntó,
 * porque un mandato lo cubría». La fila conserva el `risk_level` REAL de la
 * llamada; el mandato no toca la clasificación, porque una clasificación que se
 * mueve para justificar una decisión deja de servir para revisarla después.
 */
export type AuditDecision = 'allowed' | 'flagged' | 'blocked' | 'confirmed' | 'delegated';

export interface SecurityEvaluation {
  classification: Classification;
  /** El veredicto RESUELTO: doctrina más excepción. */
  decision: Decision;
  policy: SecurityPolicy;
  surface: Surface;
  /**
   * La concesión que levantó la pregunta, o null. Cuando no es null, `decision`
   * puede haber pasado de `confirm` a `allow` — y la puerta propia de la
   * herramienta (`requiresConfirmation`) también queda levantada, que es lo que
   * `registry.ts` lee.
   */
  mandate: MandateGrant | null;
  /** Lo que había dicho `decide()` a solas. Se guarda para poder explicarlo. */
  doctrine: Decision;
}

export interface RiskAuditFields {
  surface: Surface;
  riskLevel: string;
  decision: AuditDecision;
  riskReason: string;
  riskSignals: RiskSignal[];
  mandateId: string;
}

export interface EvaluateArgs {
  tool: MandateTool;
  input: unknown;
  db: SupabaseClient;
  userId: string;
  surface?: Surface;
  confirmed?: boolean;
  now?: Date;
}

/**
 * Classify a call and decide what to do with it. Never throws — a failure
 * anywhere in here degrades to "classify with default policy and no frequency
 * signal", which can only ever be more permissive, never less correct.
 */
export async function evaluate(args: EvaluateArgs): Promise<SecurityEvaluation> {
  const surface: Surface = args.surface ?? 'web';
  let policy = DEFAULT_POLICY;
  const extraSignals: RiskSignal[] = [];

  try {
    // Only sensitive-family tools pay for the frequency count; both lookups
    // are cached and run concurrently, so this is one round-trip of latency.
    const needFrequency = isSensitiveFamily(args.tool.id);
    const [loaded, count] = await Promise.all([
      loadPolicy(args.db),
      needFrequency ? sensitiveCallCount(args.db, args.userId) : Promise.resolve(null),
    ]);
    policy = loaded;
    if (needFrequency) {
      if (isHighFrequency(count, policy.sensitiveReadsPerHour)) extraSignals.push('high-frequency');
      noteSensitiveCall(args.userId);
    }
  } catch (err) {
    // Fail open on the I/O half; the deterministic half below still runs.
    //
    // OJO, Y ESTO NO ES UNA NOTA DE ESTILO: este fallo abierto vale porque solo
    // puede hacer la capa MÁS estricta (los valores por defecto son los duros).
    // La lectura de MANDATOS que hay más abajo es la única I/O de esta función
    // que puede hacerla más permisiva, y por eso falla en la dirección
    // CONTRARIA — cerrada. Si alguna vez alguien unifica los dos try/catch
    // «para que sean iguales», habrá convertido una caída de base de datos en
    // permiso para actuar sin preguntar. Ver mandate-store.ts.
    logger.warn(
      { err, toolId: args.tool.id },
      'security: policy/frequency lookup failed, using defaults',
    );
  }

  const classification = classify({
    tool: args.tool,
    input: args.input,
    ctx: { confirmed: args.confirmed, now: args.now, extraSignals },
    surface,
  });

  // La doctrina de la casa. Intacta: nada de lo que venga después la reescribe,
  // se guarda tal cual y se puede enseñar al lado de lo que acabó pasando.
  const doctrine = decide(classification, policy);

  // La excepción del cliente. Solo se buscan concesiones cuando la llamada IBA A
  // PARARSE — porque `decide()` dijo `confirm`, o porque la herramienta lleva su
  // propia puerta puesta. Fuera de esos dos casos no hay nada que levantar, así
  // que no se paga ni una consulta: una llamada de riesgo bajo cuesta lo mismo
  // que antes de que existieran los mandatos.
  const gated = doctrine === 'confirm' || args.tool.requiresConfirmation === true;
  const mandates =
    doctrine !== 'block' && gated
      ? await loadMandates(args.db, { toolId: args.tool.id, now: args.now })
      : [];

  const outcome = applyMandate({
    classification,
    decision: doctrine,
    tool: args.tool,
    input: args.input,
    surface,
    mandates,
  });

  return {
    classification,
    decision: outcome.decision,
    mandate: outcome.mandate,
    doctrine,
    policy,
    surface,
  };
}

/**
 * Audit columns for a given evaluation. `override` lets the caller record what
 * actually happened (e.g. 'confirmed' once the user approved a gated call).
 */
export function riskAuditFields(
  ev: SecurityEvaluation | null,
  override?: AuditDecision,
): Partial<RiskAuditFields> {
  if (!ev) return override ? { decision: override } : {};
  const natural: AuditDecision = ev.mandate
    ? // Ni `allowed` ni `confirmed`: nadie confirmó nada. La fila tiene que
      // poder distinguirse de las dos, o la pregunta «¿qué hizo Cortex por su
      // cuenta este mes?» no se puede contestar con una consulta.
      'delegated'
    : ev.decision === 'block'
      ? 'blocked'
      : ev.decision === 'confirm'
        ? 'flagged'
        : ev.classification.riskLevel === 'low'
          ? 'allowed'
          : 'flagged';
  return {
    surface: ev.surface,
    // El nivel REAL de la llamada, no el techo del mandato. Si esto guardara el
    // techo, `audit_events.risk_level` empezaría a mentir sobre lo que la
    // llamada era, que es justo el dato por el que se abre la auditoría.
    riskLevel: ev.classification.riskLevel,
    decision: override ?? natural,
    riskReason: ev.classification.reason,
    riskSignals: ev.classification.signals,
    ...(ev.mandate ? { mandateId: ev.mandate.id } : {}),
  };
}

/**
 * True when the call should leave a standalone incident row.
 *
 * Una llamada delegada SIEMPRE deja fila, aunque su riesgo sea bajo: la razón
 * de ser de la tabla es que una revisión de seguridad pueda leer qué se hizo sin
 * que nadie mirara, y eso incluye lo pequeño.
 */
export function isIncident(ev: SecurityEvaluation): boolean {
  return ev.mandate !== null || ev.decision !== 'allow' || ev.classification.riskLevel !== 'low';
}

export interface SecurityEventOpts {
  db: SupabaseClient;
  userId: UUID;
  agentId: UUID;
  toolId: string;
  input: unknown;
  evaluation: SecurityEvaluation;
  /** 'blocked' | 'confirm_required' | 'flagged' | 'confirmed' | 'delegated' */
  decision: string;
}

/**
 * One row per blocked / gated / flagged attempt. Survives audit pruning; this
 * is what a security review reads. Never throws.
 */
export async function writeSecurityEvent(opts: SecurityEventOpts): Promise<void> {
  const { classification } = opts.evaluation;
  try {
    const { error } = await opts.db.from('security_events').insert({
      user_id: opts.userId,
      agent_id: opts.agentId,
      tool_id: opts.toolId,
      surface: opts.evaluation.surface,
      risk_level: classification.riskLevel,
      decision: opts.decision,
      reason: classification.reason,
      signals: classification.signals,
      input_digest: hashInput(opts.input),
      // Qué concesión respondió (migración 0099). Null en todo lo demás, que es
      // la inmensa mayoría de las filas.
      mandate_id: opts.evaluation.mandate?.id ?? null,
    });
    if (error) logger.error({ err: error }, 'security_events insert failed');
  } catch (err) {
    logger.error({ err }, 'security_events insert threw');
  }
}

export { explainBlock, explainFlag };
