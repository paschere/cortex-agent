import type { SupabaseClient } from '@supabase/supabase-js';
import { categoryKey } from './forecast-shared';
import type { ForecastResult } from './types';

/**
 * LA NÓMINA ES CONFIDENCIAL (decisión del dueño).
 *
 * El libro de plata trae la nómina fila por fila: a quién se le pagó y
 * cuánto. Eso no es para todo el equipo. Quien no administra la empresa ve la
 * nómina sólo como un total por categoría, rotulado «Nómina (confidencial)»,
 * sin filas ni contrapartes; quien la administra (`users.role = 'org_admin'`)
 * ve el detalle. La regla es la misma en el chat (`ledger.query`,
 * `ledger.forecast`, `ledger.explain_week`) y en las vistas (`cortex.libro`,
 * `cortex.pyg`): una puerta que la respeta y otra que no, no es una regla.
 *
 * Si no se puede saber quién mira (sin persona, o la lectura del directorio
 * falla), se trata como NO administrador: lo confidencial se esconde por
 * defecto.
 */

export const PAYROLL_CATEGORY = 'nomina';
export const PAYROLL_CONFIDENTIAL_LABEL = 'Nómina (confidencial)';
/** La clave con la que la nómina doblada aparece en un total por categoría. */
export const PAYROLL_CONFIDENTIAL_KEY = 'nomina (confidencial)';

export function isPayrollCategory(category: string | null | undefined): boolean {
  return categoryKey(category) === PAYROLL_CATEGORY;
}

/** ¿Esta persona ve la nómina con detalle? Sólo quien administra la empresa. */
export async function canSeePayrollDetail(
  db: SupabaseClient,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await db.from('users').select('role').eq('id', userId).maybeSingle();
  if (error) return false;
  return (data as { role?: string } | null)?.role === 'org_admin';
}

/**
 * La proyección sin nombres de nómina: cada línea de nómina queda como
 * «Nómina (confidencial)», sin contraparte, y su nombre sale también de las
 * alertas. Las cifras no cambian: todos ven la misma caja.
 */
export function maskPayrollForecast(result: ForecastResult): ForecastResult {
  const hidden = new Set<string>();
  const weeks = result.weeks.map((w) => ({
    ...w,
    items: w.items.map((i) => {
      if (!isPayrollCategory(i.category)) return i;
      if (i.label) hidden.add(i.label);
      if (i.counterpartyName) hidden.add(i.counterpartyName);
      return {
        ...i,
        label: PAYROLL_CONFIDENTIAL_LABEL,
        counterpartyName: null,
        reason: scrub(i.reason, hidden),
      };
    }),
  }));
  if (!hidden.size) return result;
  return {
    ...result,
    weeks: weeks.map((w) => ({
      ...w,
      items: w.items.map((i) => ({ ...i, reason: scrub(i.reason, hidden) })),
    })),
    alerts: result.alerts.map((a) => ({ ...a, message: scrub(a.message, hidden) })),
  };
}

function scrub(text: string, hidden: ReadonlySet<string>): string {
  let out = text;
  // Lo más largo primero: «Nómina · Ana Ruiz» antes que «Ana Ruiz».
  for (const name of [...hidden].sort((a, b) => b.length - a.length)) {
    if (name.trim().length < 3) continue;
    out = out.split(name).join(PAYROLL_CONFIDENTIAL_LABEL);
  }
  return out;
}
