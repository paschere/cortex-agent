import type { SupabaseClient } from '@supabase/supabase-js';
import type { SnapshotAtRisk, SnapshotCrm } from './autopilot-collect';
import { MAX_RISK_TELLS } from './autopilot-collect';
import { atRiskList } from './churn';
import { assessClientRisk, loadCrmBoard } from './read';
import { RISK_RANK } from './shape';
import { listStoredRisk, markRiskTold, saveRisk } from './store';
import { reconcileQuoteStages } from './sync';

/**
 * LA FOTOGRAFÍA COMERCIAL DE LA MAÑANA (migración 0193).
 *
 * 1. Pone el embudo al día con Ventas (una cotización que venció anoche no
 *    deja evento: aquí se entera).
 * 2. Los negocios quietos.
 * 3. El riesgo de cada cliente: lo guarda y separa lo NUEVO (subió de nivel
 *    desde lo último que se contó). Lo nuevo se marca como contado aquí mismo:
 *    si el plan de hoy no lo llega a decir, el riesgo sigue a la vista en
 *    /comercial — repetirlo cada mañana sería peor.
 *
 * Con el handle de la empresa. Lo llama autopilot/sources.ts sólo si el
 * módulo `crm` está prendido.
 */
export async function loadCrmSnapshot(
  db: SupabaseClient,
  today: string,
  names: Map<string, string>,
): Promise<SnapshotCrm> {
  await reconcileQuoteStages(db, { today }).catch(() => []);
  const board = await loadCrmBoard(db, { today });
  const byId = new Map(board.opportunities.map((o) => [o.id, o]));
  const stale = board.stale.map((d) => {
    const owner = byId.get(d.id)?.owner_user_id ?? null;
    return {
      id: d.id,
      title: d.title,
      clientName: d.clientName,
      ownerName: owner ? (names.get(owner) ?? null) : null,
      value: d.value,
      currency: d.currency,
      quietDays: d.quietDays,
      why: d.why,
      suggestion: d.suggestion,
    };
  });

  const risk = await assessClientRisk(db, { today });
  const stored = new Map((await listStoredRisk(db)).map((r) => [r.client_id, r]));
  await saveRisk(
    db,
    risk.assessments
      .filter((a) => a.level !== 'bajo' || stored.has(a.clientId))
      .map((a) => ({
        clientId: a.clientId,
        level: a.level,
        score: a.score,
        evidence: a.signals.map((s) => s.evidence),
        action: a.action,
      })),
  );
  const fresh: SnapshotAtRisk[] = [];
  for (const a of atRiskList(risk.assessments)) {
    const told = stored.get(a.clientId)?.told_level ?? 'bajo';
    if (RISK_RANK[a.level] <= RISK_RANK[told]) continue;
    fresh.push({
      clientId: a.clientId,
      clientName: a.clientName,
      level: a.level,
      score: a.score,
      evidence: a.signals.map((s) => s.evidence),
      action: a.action,
      ownerName: risk.owners.get(a.clientId) ?? null,
      revenue12m: a.revenue12m,
    });
  }
  const newlyAtRisk = fresh.slice(0, MAX_RISK_TELLS);
  // Lo que bajó a «sin señales» se olvida: si vuelve a subir, se cuenta otra vez.
  const cleared = risk.assessments
    .filter((a) => a.level === 'bajo' && stored.get(a.clientId)?.told_level)
    .map((a) => ({ clientId: a.clientId, level: 'bajo' as const }));
  await markRiskTold(db, [
    ...newlyAtRisk.map((c) => ({ clientId: c.clientId, level: c.level })),
    ...cleared,
  ]);
  return { stale, newlyAtRisk };
}
