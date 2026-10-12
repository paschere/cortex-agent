import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { mandatoryHumanConfirmation } from './mandatory-confirmation.js';

/**
 * LA CONCESIÓN DE PLAN: «aprobé el plan completo, hace un momento, aquí».
 *
 * ===========================================================================
 * EL PROBLEMA QUE CIERRA
 * ===========================================================================
 * Un trabajo de varios pasos (tabla → filas → vista → app) paraba en cada
 * escritura con una tarjeta. Con `cortex.plan` la persona ya VIO la lista de
 * pasos y las herramientas que Cortex piensa usar; aprobarla una sola vez es
 * decir que sí a ESA lista, no a cualquier cosa.
 *
 * ===========================================================================
 * QUÉ ES — Y QUÉ NO ES
 * ===========================================================================
 * Una fila de auditoría (`audit_events`, herramienta `cortex.plan_grant`) que la
 * ruta /api/chat/plan escribe DEL LADO DEL SERVIDOR cuando la persona aprueba:
 *
 *   * el ALCANCE sale del plan guardado en la conversación — nunca de lo que
 *     diga el navegador — y se recorta aquí: sólo herramientas conocidas y que
 *     `neverUnderPlanGrant` no excluya;
 *   * vale para ESTA conversación y ESTE usuario, por `PLAN_GRANT_TTL_MS` y
 *     `PLAN_GRANT_MAX_CALLS` llamadas, y muere antes si la persona pulsa
 *     «Detener el plan» (fila `cortex.plan_grant_revoke`);
 *   * cada uso deja su propia fila (`cortex.plan_grant_use`) ANTES de ejecutar
 *     y es lo que se cuenta contra el tope; si no se puede anotar, no hay
 *     concesión y la llamada pide tarjeta;
 *   * en la auditoría la llamada queda `delegated` con su `risk_level` REAL.
 *
 * Lo que NO afloja:
 *   * NO cubre nunca lo no delegable (`mandatoryHumanConfirmation`) ni lo que
 *     sale a terceros, mueve plata o radica (`neverUnderPlanGrant`);
 *   * NO levanta la puerta de seguridad si el riesgo REAL de la llamada es
 *     alto o crítico: sólo bajo/medio;
 *   * NO levanta un `block`, ni una regla CEL del tenant;
 *   * NO cruza conversaciones ni usuarios, ni herramientas fuera de la lista.
 *
 * Fail-closed: cualquier duda responde null, y null es una tarjeta.
 */

export const PLAN_GRANT_TOOL_ID = 'cortex.plan_grant';
export const PLAN_GRANT_REVOKE_TOOL_ID = 'cortex.plan_grant_revoke';
export const PLAN_GRANT_USE_TOOL_ID = 'cortex.plan_grant_use';
export const PLAN_GRANT_TTL_MS = 30 * 60_000;
export const PLAN_GRANT_MAX_CALLS = 20;
/** Por encima de esto la llamada vuelve a preguntar aunque el plan la nombrara. */
export const PLAN_GRANT_RISK_CEILING = ['low', 'medium'] as const;

const OUTBOUND =
  /(^|[._])(send|send_draft|send_message|reply|group_send|post_message|publish|submit|submit_flow|pay|transfer|approve|invite|share|emit|charge|refund|void|cancel|disburse|file)([._]|$)/;
const NEVER_FAMILIES =
  /^(payments|banking|payroll|accounting|close|team|security|mandates|schedule)\./;

/**
 * Lo que un plan aprobado NO puede cubrir: todo lo no delegable más lo que sale
 * a otras personas, mueve plata, radica ante un tercero o crea rutinas
 * desatendidas. Una tarjeta normal, siempre.
 */
export function neverUnderPlanGrant(toolId: string): boolean {
  return (
    mandatoryHumanConfirmation(toolId) ||
    OUTBOUND.test(toolId) ||
    NEVER_FAMILIES.test(toolId) ||
    toolId === 'gcal.create_event' // invita a gente de fuera por correo
  );
}

export interface PlanToolSplit {
  /** Lo que la concesión sí cubrirá. */
  grantable: string[];
  /** Lo que el plan nombra y seguirá preguntando. */
  alwaysAsk: string[];
  /** Ids que no existen: se ignoran. */
  unknown: string[];
}

/** Pura: reparte los ids de un plan. `known` dice si la herramienta existe. */
export function splitPlanTools(
  toolIds: readonly string[],
  known: (id: string) => boolean,
): PlanToolSplit {
  const out: PlanToolSplit = { grantable: [], alwaysAsk: [], unknown: [] };
  for (const id of new Set(toolIds)) {
    if (!known(id)) out.unknown.push(id);
    else if (neverUnderPlanGrant(id)) out.alwaysAsk.push(id);
    else out.grantable.push(id);
  }
  return out;
}

export interface PlanGrant {
  id: string;
  tools: string[];
  createdAt: string;
  expiresAt: string;
  maxCalls: number;
  planCallId: string | null;
}

export interface GrantRow {
  id: string;
  tool_id: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Pura: de las filas de concesión/revocación de una conversación, la concesión
 * vigente o null. La más reciente manda (aprobar otro plan sustituye al
 * anterior); una revocación posterior la apaga; el reloj la vence.
 */
export function resolvePlanGrant(
  rows: readonly GrantRow[],
  now: Date = new Date(),
): PlanGrant | null {
  const sorted = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const grantRow = sorted.find((r) => r.tool_id === PLAN_GRANT_TOOL_ID);
  if (!grantRow) return null;
  const created = Date.parse(grantRow.created_at);
  if (Number.isNaN(created)) return null;
  const revoked = sorted.some(
    (r) =>
      r.tool_id === PLAN_GRANT_REVOKE_TOOL_ID &&
      Date.parse(r.created_at) >= created &&
      (r.metadata?.grantId === undefined || r.metadata.grantId === grantRow.id),
  );
  if (revoked) return null;
  const spec = (grantRow.metadata?.planGrant ?? {}) as {
    tools?: unknown;
    ttlMs?: unknown;
    maxCalls?: unknown;
    planCallId?: unknown;
  };
  // Los topes se leen con techo: una fila manipulada no puede alargar la ventana.
  const ttl = Math.min(
    typeof spec.ttlMs === 'number' && spec.ttlMs > 0 ? spec.ttlMs : PLAN_GRANT_TTL_MS,
    PLAN_GRANT_TTL_MS,
  );
  const maxCalls = Math.min(
    typeof spec.maxCalls === 'number' && spec.maxCalls > 0
      ? Math.floor(spec.maxCalls)
      : PLAN_GRANT_MAX_CALLS,
    PLAN_GRANT_MAX_CALLS,
  );
  if (now.getTime() > created + ttl) return null;
  const tools = (Array.isArray(spec.tools) ? spec.tools : []).filter(
    (t): t is string => typeof t === 'string' && !neverUnderPlanGrant(t),
  );
  if (tools.length === 0) return null;
  return {
    id: grantRow.id,
    tools,
    createdAt: grantRow.created_at,
    expiresAt: new Date(created + ttl).toISOString(),
    maxCalls,
    planCallId: typeof spec.planCallId === 'string' ? spec.planCallId : null,
  };
}

/** Pura: ¿esta llamada cabe en la concesión? */
export function planGrantCovers(
  grant: PlanGrant | null,
  args: { toolId: string; riskLevel: string; usedCalls: number },
): boolean {
  if (!grant) return false;
  if (neverUnderPlanGrant(args.toolId)) return false;
  if (!(PLAN_GRANT_RISK_CEILING as readonly string[]).includes(args.riskLevel)) return false;
  if (!grant.tools.includes(args.toolId)) return false;
  return args.usedCalls < grant.maxCalls;
}

const RECENT_COLUMNS = 'id,tool_id,created_at,metadata';

/** La concesión vigente de la conversación, o null (también ante cualquier error). */
export async function findActivePlanGrant(
  db: SupabaseClient,
  opts: { conversationId: string | undefined; userId: string; now?: Date },
): Promise<PlanGrant | null> {
  if (!opts.conversationId) return null;
  const now = opts.now ?? new Date();
  try {
    const since = new Date(now.getTime() - PLAN_GRANT_TTL_MS).toISOString();
    const { data, error } = await db
      .from('audit_events')
      .select(RECENT_COLUMNS)
      .eq('conversation_id', opts.conversationId)
      .eq('user_id', opts.userId)
      .in('tool_id', [PLAN_GRANT_TOOL_ID, PLAN_GRANT_REVOKE_TOOL_ID])
      .eq('status', 'ok')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) {
      logger.warn({ err: error.message }, 'plan grant lookup failed');
      return null;
    }
    return resolvePlanGrant((data ?? []) as GrantRow[], now);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'plan grant lookup threw');
    return null;
  }
}

async function countPlanGrantUses(
  db: SupabaseClient,
  opts: { conversationId: string; userId: string; grantId: string },
): Promise<number | null> {
  try {
    const { count, error } = await db
      .from('audit_events')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', opts.conversationId)
      .eq('user_id', opts.userId)
      .eq('tool_id', PLAN_GRANT_USE_TOOL_ID)
      .eq('metadata->>planGrantId', opts.grantId);
    if (error || count === null) return null;
    return count;
  } catch {
    return null;
  }
}

export interface PlanGrantUse {
  grantId: string;
  usedBefore: number;
  maxCalls: number;
}

/**
 * LA PUERTA PARA runTool. Devuelve el uso anotado si la llamada cabe en la
 * concesión vigente, o null (= tarjeta). El uso se anota ANTES de ejecutar; si
 * no se puede anotar, no hay concesión.
 */
export async function usePlanGrant(
  db: SupabaseClient,
  opts: {
    conversationId: string | undefined;
    userId: string;
    agentId?: string;
    toolId: string;
    riskLevel: string;
    now?: Date;
  },
): Promise<PlanGrantUse | null> {
  if (!opts.conversationId) return null;
  if (neverUnderPlanGrant(opts.toolId)) return null;
  if (!(PLAN_GRANT_RISK_CEILING as readonly string[]).includes(opts.riskLevel)) return null;
  const grant = await findActivePlanGrant(db, opts);
  if (!grant || !grant.tools.includes(opts.toolId)) return null;
  const used = await countPlanGrantUses(db, {
    conversationId: opts.conversationId,
    userId: opts.userId,
    grantId: grant.id,
  });
  if (used === null) return null;
  if (!planGrantCovers(grant, { toolId: opts.toolId, riskLevel: opts.riskLevel, usedCalls: used }))
    return null;
  try {
    const { error } = await db.from('audit_events').insert({
      user_id: opts.userId,
      agent_id: opts.agentId ?? null,
      conversation_id: opts.conversationId,
      tool_id: PLAN_GRANT_USE_TOOL_ID,
      input_hash: opts.toolId,
      status: 'ok',
      latency_ms: 0,
      metadata: { planGrantId: grant.id, toolId: opts.toolId, n: used + 1, of: grant.maxCalls },
      decision: 'delegated',
      risk_level: opts.riskLevel,
      risk_signals: [],
    });
    if (error) {
      logger.warn({ err: error.message }, 'plan grant use not recorded');
      return null;
    }
  } catch {
    return null;
  }
  return { grantId: grant.id, usedBefore: used, maxCalls: grant.maxCalls };
}

/** Escribe la concesión (lo llama la ruta del servidor, con el alcance ya recortado). */
export async function createPlanGrant(
  db: SupabaseClient,
  opts: {
    conversationId: string;
    userId: string;
    agentId?: string;
    tools: string[];
    planCallId?: string;
  },
): Promise<PlanGrant | null> {
  const tools = [...new Set(opts.tools)].filter((t) => !neverUnderPlanGrant(t));
  if (tools.length === 0) return null;
  try {
    const { data, error } = await db
      .from('audit_events')
      .insert({
        user_id: opts.userId,
        agent_id: opts.agentId ?? null,
        conversation_id: opts.conversationId,
        tool_id: PLAN_GRANT_TOOL_ID,
        input_hash: (opts.planCallId ?? '').slice(0, 32),
        status: 'ok',
        latency_ms: 0,
        decision: 'confirmed',
        risk_signals: [],
        metadata: {
          planGrant: {
            tools,
            ttlMs: PLAN_GRANT_TTL_MS,
            maxCalls: PLAN_GRANT_MAX_CALLS,
            planCallId: opts.planCallId ?? null,
          },
        },
      })
      .select(RECENT_COLUMNS)
      .single();
    if (error || !data) {
      logger.warn({ err: error?.message }, 'plan grant not recorded');
      return null;
    }
    return resolvePlanGrant([data as GrantRow]);
  } catch {
    return null;
  }
}

/** «Detener el plan»: escribe la revocación de la concesión vigente. */
export async function revokePlanGrant(
  db: SupabaseClient,
  opts: { conversationId: string; userId: string; agentId?: string },
): Promise<boolean> {
  const grant = await findActivePlanGrant(db, opts);
  if (!grant) return true;
  try {
    const { error } = await db.from('audit_events').insert({
      user_id: opts.userId,
      agent_id: opts.agentId ?? null,
      conversation_id: opts.conversationId,
      tool_id: PLAN_GRANT_REVOKE_TOOL_ID,
      input_hash: grant.id.slice(0, 32),
      status: 'ok',
      latency_ms: 0,
      decision: 'confirmed',
      risk_signals: [],
      metadata: { grantId: grant.id },
    });
    return !error;
  } catch {
    return false;
  }
}
