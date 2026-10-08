import { addDays, bogotaToday } from '../commitments/shape';
import type { PurchaseCursor, PurchasePlan } from './purchase-plan';

/** Cuánta historia trae la primera carga de nómina. */
export const PAYROLL_HISTORY_DAYS = 730;
/** El repaso de todos los días mira los últimos dos meses: un comprobante corregido llega solo. */
export const PAYROLL_ROLLING_DAYS = 60;
const FULL_SWEEP_MS = 30 * 24 * 60 * 60_000;

/**
 * Qué pedirle a Siigo de nómina esta vez. Igual que las compras: primera
 * carga reanudable (dos años), repaso mensual de todo ese rango por si un
 * comprobante viejo se corrigió, y entre uno y otro sólo los últimos 60 días.
 * El cursor se guarda en `cursors.payroll`; `nextPurchaseCursor` lo avanza.
 */
export function planPayrollSync(previous: PurchaseCursor | undefined, now: Date): PurchasePlan {
  if (previous?.resume) return previous.resume;
  const today = bogotaToday(now);
  if (!previous?.since)
    return { mode: 'initial', since: addDays(today, -PAYROLL_HISTORY_DAYS), page: 1 };
  if (!previous.full_at || now.getTime() - Date.parse(previous.full_at) >= FULL_SWEEP_MS)
    return { mode: 'sweep', since: addDays(today, -PAYROLL_HISTORY_DAYS), page: 1 };
  return { mode: 'rolling', since: addDays(today, -PAYROLL_ROLLING_DAYS), page: 1 };
}
