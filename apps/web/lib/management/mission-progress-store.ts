import 'server-only';

import {
  type StoredRun,
  activationSource,
  mapRun,
  readOwnedPreparedViews,
  readOwnedTableSources,
} from '@/lib/activations/service';
import type { ActivationRun } from '@/lib/activations/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type MissionProgress, buildMissionProgress } from './mission-progress';
import type { ManagementCase } from './shape';

const RUN_SELECT =
  'id,source_id,source_name,prepared_view_id,sheet_index,sheet_name,definition,mapping,candidates,status,created_at,committed_at,case_ids';
const CASE_SELECT = 'id,data,revision,created_by,updated_by,created_at,updated_at';

/**
 * Read the first mission from existing private runs and shared cases. Every
 * source/run read is narrowed to the authenticated actor; cases come through
 * the organization-scoped client and are additionally limited to the run's
 * case ids. A failed read remains visible as `unknown` instead of becoming a
 * false completed step.
 */
export async function readMissionProgress(
  db: SupabaseClient,
  actorId: string,
): Promise<MissionProgress> {
  const errors: string[] = [];
  let sources: Awaited<ReturnType<typeof readOwnedTableSources>> = [];
  let sourceViews: Awaited<ReturnType<typeof readOwnedPreparedViews>> = [];
  let sourceCount: number | null = null;
  try {
    [sources, sourceViews] = await Promise.all([
      readOwnedTableSources(db, actorId),
      readOwnedPreparedViews(db, actorId),
    ]);
    sourceCount = sources.length;
  } catch {
    sourceCount = null;
    errors.push('No se pudo comprobar Feed. Reintenta para validar la fuente de la misión.');
  }

  let runs: ActivationRun[] = [];
  let runsAvailable = true;
  try {
    const result = await db
      .from('activation_runs')
      .select(RUN_SELECT)
      .eq('actor_id', actorId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (result.error) {
      runsAvailable = false;
      errors.push('No se pudo leer el historial de simulaciones.');
    } else runs = ((result.data ?? []) as StoredRun[]).map(mapRun);
  } catch {
    runsAvailable = false;
    errors.push('No se pudo leer el historial de simulaciones.');
    runs = [];
  }

  const caseIds = [...new Set(runs.flatMap((run) => run.caseIds))];
  let cases: ManagementCase[] = [];
  let casesAvailable = true;
  if (caseIds.length > 0) {
    try {
      const result = await db
        .from('management_cases')
        .select(CASE_SELECT)
        .in('id', caseIds)
        .limit(200);
      if (result.error) {
        casesAvailable = false;
        errors.push('No se pudieron leer los asuntos del resultado.');
      } else cases = (result.data ?? []) as ManagementCase[];
    } catch {
      casesAvailable = false;
      errors.push('No se pudieron leer los asuntos del resultado.');
      cases = [];
    }
  }

  // activation_runs.source_id is intentionally ON DELETE CASCADE because Feed
  // snapshots are private and expire. The committed management case is the
  // durable, company-visible result, so retain the actor's own activation
  // cases as history when the private run is gone. The actor filter is the
  // privacy boundary: no old activation provenance from another person's
  // private run is surfaced here.
  let historicalCases: ManagementCase[] = [];
  let historyAvailable = true;
  try {
    const result = await db
      .from('management_cases')
      .select(CASE_SELECT)
      .eq('created_by', actorId)
      .order('updated_at', { ascending: false })
      .limit(501);
    if (result.error) {
      historyAvailable = false;
      errors.push('No se pudo leer el historial de resultados de la misión.');
    } else {
      const rows = (result.data ?? []) as ManagementCase[];
      historicalCases = rows.slice(0, 500);
      if (rows.length > 500)
        errors.push('El historial de resultados de la misión está limitado a 500 asuntos.');
    }
  } catch {
    historyAvailable = false;
    errors.push('No se pudo leer el historial de resultados de la misión.');
  }

  return buildMissionProgress({
    sources: sources.map((source) => activationSource(source, sourceViews)),
    sourceCount,
    runsAvailable,
    casesAvailable,
    historicalCases,
    historyAvailable,
    errors,
    runs,
    cases,
  });
}
