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
import {
  type ActionPolicy,
  type ActionPolicyDecision,
  evaluateActionPolicy,
} from './action-policy.js';
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
  familyOf,
  isSensitiveFamily,
} from './policy.js';
import { loadActionPolicy, loadPolicy } from './store.js';

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
  /**
   * Lo que dijo la política CEL del tenant (action-policy.ts), o null si el
   * tenant no ha escrito una. Cuando `allowed` es false y `mode` es `enforce`,
   * `decision` ya viene en `block`; en `dry-run` la llamada sigue, con la regla
   * que la habría parado registrada en señales y razón.
   */
  actionPolicy: ActionPolicyDecision | null;
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
  /** Clave del caché de políticas — sin ella el tenant cae en la celda anónima. */
  organizationId?: string;
  /** Para el contexto CEL (`agent.id`); ausente = cadena vacía en las reglas. */
  agentId?: string;
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
  let tenantActionPolicy: ActionPolicy | null = null;
  const extraSignals: RiskSignal[] = [];

  try {
    // Only sensitive-family tools pay for the frequency count; both lookups
    // are cached and run concurrently, so this is one round-trip of latency.
    // La política CEL sale del MISMO fetch que los tres knobs (store.ts), así
    // que pedirla aquí no añade viaje.
    const needFrequency = isSensitiveFamily(args.tool.id);
    const [loaded, cel, count] = await Promise.all([
      loadPolicy(args.db, args.organizationId),
      loadActionPolicy(args.db, args.organizationId),
      needFrequency ? sensitiveCallCount(args.db, args.userId) : Promise.resolve(null),
    ]);
    policy = loaded;
    tenantActionPolicy = cel;
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
    //
    // Excepción asumida: la política CEL también viaja en este fetch, y su
    // pérdida SÍ es más permisiva (motor apagado). Se acepta porque el suelo
    // sigue siendo la matriz + blockCritical por defecto, el caché suele estar
    // caliente, y fallar cerrado aquí pararía TODOS los workspaces (los que no
    // escribieron política incluidos) en cada parpadeo de la base de datos.
    logger.warn(
      { err, toolId: args.tool.id },
      'security: policy/frequency lookup failed, using defaults',
    );
  }

  let classification = classify({
    tool: args.tool,
    input: args.input,
    ctx: { confirmed: args.confirmed, now: args.now, extraSignals },
    surface,
  });

  // La doctrina de la casa. Intacta: nada de lo que venga después la reescribe,
  // se guarda tal cual y se puede enseñar al lado de lo que acabó pasando.
  const doctrine = decide(classification, policy);

  // ---------------------------------------------------------------------------
  // La política CEL del tenant (action-policy.ts), encima de la doctrina y
  // ANTES de los mandatos: un deny escrito por el administrador no puede ser
  // levantado por una concesión — la concesión levanta preguntas, no
  // prohibiciones. El contexto sale de NUESTRA clasificación, nunca de lo que
  // el llamador dice que va a hacer.
  //
  // `allow` de la política tampoco levanta nada: no baja un `confirm` ni un
  // `block` de la doctrina. Esta capa solo puede QUITAR, y en dry-run ni eso —
  // decide, deja rastro y deja pasar.
  // ---------------------------------------------------------------------------
  let celDecision: ActionPolicyDecision | null = null;
  if (tenantActionPolicy) {
    celDecision = evaluateActionPolicy(tenantActionPolicy, {
      tool: { id: args.tool.id, family: familyOf(args.tool.id) },
      surface,
      user: { id: args.userId },
      agent: { id: args.agentId ?? '' },
      risk: {
        level: classification.riskLevel,
        sensitivity: classification.sensitivity,
        blastRadius: classification.blastRadius,
        signals: classification.signals,
      },
      confirmed: args.confirmed === true,
    });

    if (!celDecision.allowed && celDecision.mode === 'enforce') {
      // La razón de la regla sustituye a la de la matriz: la fila de auditoría
      // y el mensaje al usuario tienen que nombrar la regla que decidió, no una
      // explicación genérica que no corresponde a lo que pasó.
      classification = {
        ...classification,
        reason: celDecision.reason,
        signals: [...classification.signals, 'policy-denied'],
      };
      return {
        classification,
        decision: 'block',
        mandate: null,
        doctrine,
        policy,
        surface,
        actionPolicy: celDecision,
      };
    }

    if (!celDecision.allowed) {
      // dry-run: la llamada sigue, pero la fila cuenta qué regla la habría
      // parado — eso es lo que un operador lee antes de pasar a `enforce`.
      classification = {
        ...classification,
        reason: `${classification.reason} · action policy (dry-run): rule \`${celDecision.matched ?? 'default deny'}\` would refuse this.`,
        signals: [...classification.signals, 'policy-dry-run'],
      };
    }
  }

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
    actionPolicy: celDecision,
  };
}

/**
 * El mensaje que acompaña a un `SecurityBlockedError`. Cuando quien paró la
 * llamada fue una regla CEL del tenant, el mensaje nombra la regla; la
 * explicación genérica de la matriz sería mentirle al usuario sobre quién
 * decidió.
 */
export function blockExplanation(ev: SecurityEvaluation): string {
  if (ev.actionPolicy && !ev.actionPolicy.allowed && ev.actionPolicy.mode === 'enforce') {
    return ev.actionPolicy.reason;
  }
  return explainBlock(ev.classification);
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
  return (
    ev.mandate !== null ||
    ev.decision !== 'allow' ||
    ev.classification.riskLevel !== 'low' ||
    // Un deny en dry-run deja fila AUNQUE la llamada sea de riesgo bajo: el
    // rastro es lo único que el operador tiene para decidir pasar a `enforce`.
    (ev.actionPolicy !== null && !ev.actionPolicy.allowed)
  );
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
