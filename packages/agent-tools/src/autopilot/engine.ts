import type { SupabaseClient } from '@supabase/supabase-js';
import { getTool } from '../registry';
import type { MandateGrant } from '../security/mandate';
import { loadMandates } from '../security/mandate-store';
import type { ToolFacts } from './policy';
import type { RunDeps } from './run';
import { loadSnapshot } from './sources';
import { loadPlanHistory, readAutopilotSettings } from './store';

/**
 * Las piezas de planear que no dependen de la app: leer la configuración, la
 * fotografía, la historia y los mandatos, y mirar las herramientas. Las usan
 * `autopilot.plan` (chat), «Probar sin hacer nada» (/piloto) y la corrida de
 * verdad (apps/web/inngest/functions/autopilot.ts), así que las tres planean
 * exactamente igual.
 */
export type PlanningDeps = Pick<
  RunDeps,
  'loadSnapshot' | 'loadHistory' | 'loadMandates' | 'tool' | 'now' | 'readSettings'
>;

export function toolFacts(id: string): ToolFacts | undefined {
  const t = getTool(id);
  if (!t) return undefined;
  return {
    id: t.id,
    requiresConfirmation: t.requiresConfirmation,
    declaredAmount: t.declaredAmount,
  };
}

/**
 * Los mandatos vigentes que nombran alguna de estas herramientas, sin los de
 * rutinas concretas (el piloto no es una rutina con mandato propio). La lectura
 * falla CERRADA (loadMandates): sin lectura, sin mandato.
 */
export async function mandatesFor(
  db: SupabaseClient,
  toolIds: string[],
  now: Date,
): Promise<MandateGrant[]> {
  const byId = new Map<string, MandateGrant>();
  for (const toolId of [...new Set(toolIds)]) {
    for (const m of await loadMandates(db, { toolId, now })) byId.set(m.id, m);
  }
  return [...byId.values()];
}

export function planningDeps(
  db: SupabaseClient,
  opts: { day: string; now?: () => Date },
): PlanningDeps {
  const now = opts.now ?? (() => new Date());
  return {
    now,
    readSettings: () => readAutopilotSettings(db),
    loadSnapshot: () => loadSnapshot(db, { today: opts.day, now: now() }),
    loadHistory: () => loadPlanHistory(db, { now: now() }),
    loadMandates: (toolIds) => mandatesFor(db, toolIds, now()),
    tool: toolFacts,
  };
}
