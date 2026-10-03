'use server';

import type { ScreenResult } from '@/components/statements/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  bogotaToday,
  isCompanyManager,
  refreshAccountingReports,
  saveCategoryClasses,
  toolErrorMessage,
} from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE HACE DESDE /estados (0191): traer de nuevo los estados del
 * programa contable (lectura del programa; sólo quien administra, porque
 * gasta la llave de la empresa) y guardar la clasificación de gastos (la
 * revisa también el módulo).
 */

const PATH = '/estados';

export async function refreshStatementsAction(year: number, month: number): Promise<ScreenResult> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    if (!(await isCompanyManager(db, user.id)))
      return {
        ok: false,
        error: 'Sólo quien administra la empresa trae los estados del programa contable.',
      };
    const out = await refreshAccountingReports(db, {
      year: Math.round(year),
      throughMonth: Math.min(Math.max(Math.round(month), 1), 12),
      today: bogotaToday(),
      userId: user.id,
    });
    revalidatePath(PATH);
    if (!out.provider) return { ok: false, error: 'No hay programa contable conectado.' };
    if (!out.fetched.length) return { ok: false, error: out.errors.join(' ') || 'No llegó nada.' };
    return {
      ok: true,
      note: `Traje ${out.fetched.join(', ')}.${out.errors.length ? ` ${out.errors.join(' ')}` : ''}`,
    };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}

export async function saveClassesAction(classes: Record<string, string>): Promise<ScreenResult> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    await saveCategoryClasses(db, classes, { userId: user.id });
    revalidatePath(PATH);
    revalidatePath('/presupuesto');
    return { ok: true, note: 'Guardé la clasificación: los estados y los indicadores ya la usan.' };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}
