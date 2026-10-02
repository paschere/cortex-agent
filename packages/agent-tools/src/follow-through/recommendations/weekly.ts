import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../../commitments/shape';
import { isCompanyManager } from '../../directory/store';
import { readWorkSettings } from '../../work/store';
import type { KindHistory } from './rank';
import type { RecommendationCandidate, RecommendationDraft, RecommendationRecord } from './shape';
import {
  countOpenCases,
  countOverdueCommitments,
  evaluateRecommendations,
  readKindHistory,
  recordRecommendations,
} from './store';

/**
 * LO QUE LA REVISIÓN SEMANAL APRENDE Y RECUERDA, DETRÁS DE UNA INTERFAZ.
 *
 * La revisión (views/pulse-weekly.ts) hace tres cosas nuevas con esto:
 *
 *   1. ORDENA sus recomendaciones con la tasa de acierto de esta empresa
 *      (`history`), sin sacar nunca la caja en rojo ni la cartera vencida.
 *   2. CUENTA lo que recomendó antes y qué pasó (`past`), ya juzgado con los
 *      hechos de hoy.
 *   3. GUARDA lo que recomienda esta semana (`record`), con las cifras del
 *      momento, para poder contarlo la que viene.
 *
 * Es una interfaz para que las pruebas de la revisión no necesiten una base
 * que entienda `recommendations`, y para que un fallo aquí NUNCA tumbe la
 * revisión: quien la llama envuelve cada paso en su `catch`.
 *
 * QUIÉN LEE ESTO. La revisión queda en el pulso de la empresa, que ve todo el
 * espacio de trabajo. Lo que nombra a una persona del equipo («repartir los
 * despachos de Laura») sólo entra si quien la pide administra la empresa Y el
 * equipo ve el trabajo de todos (`team_visibility = 'all'`), o si la revisión
 * no va a una vista compartida. Lo que esperaba la aprobación de alguien sólo
 * entra en la revisión de esa persona.
 */

export interface WeeklyLearning {
  history(): Promise<KindHistory[]>;
  past(input: { now: Date; cashAlertKinds: string[] | null }): Promise<RecommendationRecord[]>;
  record(candidates: readonly RecommendationCandidate[], now: Date): Promise<number>;
}

/** Cuántos días atrás se cuenta en «Lo que recomendé y qué pasó». */
export const FOLLOW_UP_LOOKBACK_DAYS = 35;

export function supabaseWeeklyLearning(
  db: SupabaseClient,
  opts: { userId: string; sharedView: boolean },
): WeeklyLearning {
  return {
    history: () => readKindHistory(db),
    async past({ now, cashAlertKinds }) {
      const [{ records }, manager, settings] = await Promise.all([
        evaluateRecommendations(db, { now, cashAlertKinds }),
        isCompanyManager(db, opts.userId).catch(() => false),
        readWorkSettings(db).catch(() => null),
      ]);
      const showPeople = manager && (!opts.sharedView || settings?.teamVisibility === 'all');
      const todayStart = Date.parse(`${bogotaToday(now)}T05:00:00Z`);
      const oldest = now.getTime() - FOLLOW_UP_LOOKBACK_DAYS * 86_400_000;
      return records.filter((r) => {
        const at = Date.parse(r.createdAt);
        if (!Number.isFinite(at) || at >= todayStart || at < oldest) return false;
        if (r.kind === 'review_approvals') return r.createdFor === opts.userId;
        if (r.subjectKind === 'person') return showPeople;
        return true;
      });
    },
    async record(candidates, now) {
      // Las líneas base que la vista no da con la misma regla con que después
      // se mide: se cuentan aquí, igual que las contará el juez.
      const needs = new Set(candidates.map((c) => c.kind));
      const today = bogotaToday(now);
      const [overdue, open] = await Promise.all([
        needs.has('close_commitments')
          ? countOverdueCommitments(db, today).catch(() => null)
          : null,
        needs.has('decide_cases') ? countOpenCases(db).catch(() => null) : null,
      ]);
      const drafts: RecommendationDraft[] = candidates.map((c) => ({
        ...c,
        source: 'weekly_review',
        createdFor: opts.userId,
        baseline:
          c.kind === 'close_commitments' && overdue !== null
            ? { ...c.baseline, count: overdue }
            : c.kind === 'decide_cases' && open !== null
              ? { ...c.baseline, count: open }
              : c.baseline,
      }));
      return recordRecommendations(db, drafts, { now });
    },
  };
}
