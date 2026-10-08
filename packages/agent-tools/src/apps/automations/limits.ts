import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type AutomationLimits,
  DEFAULT_AUTOMATION_LIMITS,
  MAX_AUTOMATION_LIMITS,
  resolveLimits,
} from './engine';

/** Los topes diarios de las automatizaciones de UNA app (0212), con los valores por defecto aplicados. */
export async function getAppLimits(db: SupabaseClient, appId: string): Promise<AutomationLimits> {
  const { data, error } = await db
    .from('custom_apps')
    .select('automation_limits')
    .eq('id', appId)
    .maybeSingle();
  if (error) return { ...DEFAULT_AUTOMATION_LIMITS };
  return resolveLimits((data as { automation_limits?: unknown } | null)?.automation_limits);
}

/** Cambia los topes de la app; lo que pase de los máximos se rechaza con un mensaje claro. */
export async function setAppLimits(
  db: SupabaseClient,
  appId: string,
  input: Partial<AutomationLimits>,
): Promise<AutomationLimits> {
  const next = { ...(await getAppLimits(db, appId)) };
  for (const key of ['runsPerDay', 'askCortexPerDay'] as const) {
    const v = input[key];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < 1 || v > MAX_AUTOMATION_LIMITS[key])
      throw new ValidationError(
        `El tope de ${key === 'runsPerDay' ? 'corridas' : 'pedidos a Cortex'} por día va de 1 a ${MAX_AUTOMATION_LIMITS[key]}.`,
      );
    next[key] = v;
  }
  const { error } = await db
    .from('custom_apps')
    .update({ automation_limits: next })
    .eq('id', appId);
  if (error) throw error;
  return next;
}
