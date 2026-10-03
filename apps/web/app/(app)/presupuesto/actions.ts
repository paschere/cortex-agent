'use server';

import type { ScreenResult } from '@/components/statements/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  bogotaToday,
  createBudget,
  removeBudgetCategory,
  setBudgetLines,
  setBudgetStatus,
  toolErrorMessage,
} from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE HACE DESDE /presupuesto (0191). Son escrituras internas de quien
 * administra: el módulo lo vuelve a revisar (budget/store.ts `requireManager`).
 */

const PATH = '/presupuesto';

async function scoped() {
  const user = await requireSession();
  return { user, db: getOrgScopedClient(user.organization.id) };
}

export async function createBudgetAction(input: {
  year: number;
  basis: 'ultimo_anio' | 'desde_cero';
  growthPct: number;
  incomeGrowthPct: number | null;
}): Promise<ScreenResult & { id?: string }> {
  try {
    const { user, db } = await scoped();
    const out = await createBudget(
      db,
      {
        year: Math.round(input.year),
        basis: input.basis === 'ultimo_anio' ? 'ultimo_anio' : 'desde_cero',
        growthPct: Number(input.growthPct) || 0,
        incomeGrowthPct: input.incomeGrowthPct === null ? null : Number(input.incomeGrowthPct),
      },
      { userId: user.id, today: bogotaToday() },
    );
    revalidatePath(PATH);
    return {
      ok: true,
      id: out.budget.id,
      note: out.cells
        ? `Creé «${out.budget.name}» con ${out.cells} celdas desde lo real del año anterior.`
        : `Creé «${out.budget.name}» vacío: agrega las categorías en «Editar el presupuesto».`,
    };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}

export async function setBudgetCellsAction(
  budgetId: string,
  cells: Array<{ category: string; month: number; amount: number }>,
): Promise<ScreenResult> {
  try {
    const { user, db } = await scoped();
    if (!Array.isArray(cells) || cells.length > 600)
      return { ok: false, error: 'Demasiadas celdas a la vez.' };
    const out = await setBudgetLines(db, budgetId, cells, { userId: user.id });
    revalidatePath(PATH);
    return {
      ok: true,
      note: `Guardado (${out.written + out.removed} ${out.written + out.removed === 1 ? 'celda' : 'celdas'}).`,
    };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}

export async function removeBudgetCategoryAction(
  budgetId: string,
  category: string,
): Promise<ScreenResult> {
  try {
    const { user, db } = await scoped();
    await removeBudgetCategory(db, budgetId, category, { userId: user.id });
    revalidatePath(PATH);
    return { ok: true, note: 'Quité la categoría del presupuesto.' };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}

export async function setBudgetStatusAction(
  budgetId: string,
  status: 'borrador' | 'aprobado' | 'archivado',
): Promise<ScreenResult> {
  try {
    const { user, db } = await scoped();
    const b = await setBudgetStatus(db, budgetId, status, { userId: user.id });
    revalidatePath(PATH);
    return {
      ok: true,
      note:
        b.status === 'aprobado'
          ? `«${b.name}» quedó aprobado: es el que se compara contra lo real.`
          : `«${b.name}» quedó como ${b.status}.`,
    };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}
