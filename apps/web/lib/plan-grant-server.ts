import 'server-only';
import { confirmationResults } from '@/lib/confirmation-claim';
import { type PlanState, planFromInvocations, planToolIds } from '@/lib/plan-state';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { getTool, splitPlanTools, toolIdAllowed } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * EL ALCANCE DE UN PLAN APROBADO, LEÍDO EN EL SERVIDOR.
 *
 * El navegador no dice qué herramientas cubre la aprobación: este archivo relee
 * el plan que Cortex declaró (`cortex.plan`, guardado en los mensajes de la
 * conversación), toma las herramientas de los pasos que faltan y las filtra por
 * lo que existe, lo que el agente puede usar, lo que la persona no tiene
 * vetado, y lo que un plan nunca puede cubrir (`splitPlanTools`).
 */

export interface PlanScopeResult {
  plan: PlanState;
  grantable: string[];
  alwaysAsk: string[];
  unknown: string[];
}

export async function loadConversationPlan(
  db: SupabaseClient,
  conversationId: string,
): Promise<PlanState | null> {
  const { data, error } = await db
    .from('messages')
    .select('tool_results,parts')
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error || !data) return null;
  const invocations = [...data].reverse().flatMap((row) =>
    confirmationResults(row.tool_results, row.parts).map((e) => ({
      toolCallId: typeof e.toolCallId === 'string' ? e.toolCallId : '',
      toolName: typeof e.toolName === 'string' ? e.toolName : '',
      state: 'result',
      result: e.result,
    })),
  );
  return planFromInvocations(invocations);
}

export async function planScope(
  db: SupabaseClient,
  args: { conversationId: string; userId: string; agentToolIds: string[] },
): Promise<PlanScopeResult | null> {
  const plan = await loadConversationPlan(db, args.conversationId);
  if (!plan) return null;
  const denied = await deniedToolPatterns(db, args.userId, { failClosed: true });
  const split = splitPlanTools(planToolIds(plan), (id) => Boolean(getTool(id)));
  // Lo que el agente no puede usar o la persona tiene vetado no entra en el
  // alcance ni se promete: simplemente no se cubre.
  const usable = (id: string) => toolIdAllowed(args.agentToolIds, id) && !isToolDenied(id, denied);
  return {
    plan,
    grantable: split.grantable.filter(usable),
    alwaysAsk: split.alwaysAsk,
    unknown: split.unknown,
  };
}
