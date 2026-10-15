'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { parseUsdCopRate } from '@/lib/usage-cost';
import { saveUsdCopRate } from '@/lib/usage-cost-store';
import { revalidatePath } from 'next/cache';

/** Fija la tasa USD→COP con la que se muestra el costo de Cortex (0228). */
export async function saveUsdCopRateAction(raw: string): Promise<{ ok: boolean; note: string }> {
  const user = await requireSession();
  if (user.role !== 'org_admin')
    return { ok: false, note: 'Sólo quien administra la empresa cambia la tasa.' };
  const rate = parseUsdCopRate(raw);
  if (rate === null) return { ok: false, note: 'Escribe pesos por dólar entre 500 y 20.000.' };
  try {
    await saveUsdCopRate(getOrgScopedClient(user.organization.id), rate, user.id);
  } catch (err) {
    return { ok: false, note: err instanceof Error ? err.message : 'No se pudo guardar.' };
  }
  revalidatePath('/admin/usage');
  return { ok: true, note: 'Tasa guardada.' };
}
