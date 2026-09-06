import type { SupabaseClient } from '@supabase/supabase-js';
export type GoalChange = {
  key: string;
  label: string;
  action: 'created' | 'archived';
  at: string;
  actorId: string;
  target: number | string;
  unit: string;
  cadence: string;
};
/** Goals are immutable declarations: changes are archive + new declaration, not overwritten targets. */
export async function readGoalChanges(db: SupabaseClient, start: string, end: string) {
  const columns =
    'id,label,target_value,unit,cadence,created_at,created_by,archived_at,archived_by';
  const [created, archived] = await Promise.all([
    db
      .from('goals')
      .select(columns)
      .gte('created_at', start)
      .lt('created_at', end)
      .order('created_at', { ascending: false })
      .limit(101),
    db
      .from('goals')
      .select(columns)
      .gte('archived_at', start)
      .lt('archived_at', end)
      .order('archived_at', { ascending: false })
      .limit(101),
  ]);
  if (created.error || archived.error)
    throw new Error('No se pudo comprobar el historial de metas.');
  const changes: GoalChange[] = [
    ...(created.data ?? []).slice(0, 100).map((g) => ({
      key: `${g.id}:created`,
      label: g.label,
      action: 'created' as const,
      at: g.created_at,
      actorId: g.created_by,
      target: g.target_value,
      unit: g.unit,
      cadence: g.cadence,
    })),
    ...(archived.data ?? []).slice(0, 100).map((g) => ({
      key: `${g.id}:archived`,
      label: g.label,
      action: 'archived' as const,
      at: g.archived_at,
      actorId: g.archived_by,
      target: g.target_value,
      unit: g.unit,
      cadence: g.cadence,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return {
    changes,
    partial: (created.data?.length ?? 0) > 100 || (archived.data?.length ?? 0) > 100,
  };
}
export function describeGoalChange(change: GoalChange) {
  return `${change.action === 'created' ? 'Se fijó' : 'Se retiró'} «${change.label}»: objetivo ${change.target} ${{ percent: '%', days: 'días', count: 'unidades' }[change.unit] ?? change.unit}, periodicidad ${change.cadence === 'week' ? 'semanal' : 'mensual'}.`;
}
