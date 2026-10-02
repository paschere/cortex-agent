'use server';

import { fullMoney, parseAdjustments, parseMoneyInput } from '@/lib/finance/dashboard-shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, writeAuditEvent } from '@cortex/agent-tools';
import {
  decideDetectedRecurring,
  declareRecurring,
  deleteScenario,
  saveLedgerSettings,
  saveScenario,
} from '@cortex/agent-tools/src/ledger/plans';
import { ensureAccount } from '@cortex/agent-tools/src/ledger/store';
import type { UUID } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE CAMBIA DESDE EL PANEL DE FINANZAS.
 *
 * Cada export de un archivo 'use server' es un endpoint que cualquiera con
 * sesión puede llamar, así que cada uno vuelve a mirar quién es y qué puede:
 *
 *   - El saldo de una cuenta y los gastos fijos cambian la caja que ve toda la
 *     empresa: sólo quien administra (`org_admin`).
 *   - Un escenario es un «¿y si…?» que no toca el libro: lo arma cualquiera.
 *   - La caja mínima de la empresa mueve el centro de mando, el pulso y la
 *     revisión semanal de todos: quien administra o es DUEÑO de la empresa.
 *     Se revisa aquí con la sesión y otra vez en la base (`saveLedgerSettings`).
 *
 * Nada calcula aquí: delegan en el almacén del libro y en ledger/plans, las
 * mismas funciones que usan las herramientas del chat.
 */

export type FinanceActionResult =
  | { ok: true; note: string; id?: string }
  | { ok: false; error: string };

const PATH = '/finance';

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

async function admin() {
  const user = await requireSession();
  if (user.role !== 'org_admin') {
    throw new Error('Sólo quien administra la empresa puede cambiar esto.');
  }
  return user;
}

export async function updateBalance(input: {
  account: string;
  currency: string;
  balance: string;
}): Promise<FinanceActionResult> {
  const started = performance.now();
  try {
    const user = await admin();
    const name = String(input.account ?? '')
      .trim()
      .slice(0, 80);
    if (!name) return { ok: false, error: 'Escribe el nombre de la cuenta.' };
    const currency = String(input.currency ?? 'COP')
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'La moneda no es válida.' };
    const raw = String(input.balance ?? '').trim();
    const negative = /^[-−]/.test(raw);
    const amount = parseMoneyInput(raw.replace(/^[-−]/, ''));
    if (amount == null) return { ok: false, error: 'Escribe el saldo, por ejemplo 48.300.000.' };
    const balance = negative ? -amount : amount;
    const db = getOrgScopedClient(user.organization.id);
    const at = bogotaToday();
    const { account, created } = await ensureAccount(db, {
      name,
      currency,
      source: { kind: 'manual', system: '', ref: name.toLowerCase().slice(0, 200) },
      createdBy: user.id,
      balance: { amount: balance, at, source: 'manual' },
    });
    await writeAuditEvent({
      db,
      userId: user.id as UUID,
      toolId: 'ledger.set_balance',
      input: { account: name, currency, balance },
      status: 'ok',
      latencyMs: Math.round(performance.now() - started),
      surface: 'web',
      decision: 'confirmed',
      metadata: { accountId: account.id, created },
    });
    revalidatePath(PATH);
    return {
      ok: true,
      note: `${created ? 'Creé la cuenta' : 'Actualicé el saldo de'} «${account.name}».`,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo guardar el saldo.') };
  }
}

export async function saveScenarioAction(input: {
  id?: string | null;
  label: string;
  adjustments: unknown;
}): Promise<FinanceActionResult> {
  try {
    const user = await requireSession();
    const label = String(input.label ?? '')
      .trim()
      .slice(0, 80);
    if (!label) return { ok: false, error: 'Ponle un nombre al escenario.' };
    const adjustments = parseAdjustments(input.adjustments);
    const db = getOrgScopedClient(user.organization.id);
    const saved = await saveScenario(db, {
      id: input.id ?? undefined,
      label,
      adjustments,
      userId: user.id,
    });
    revalidatePath(PATH);
    return { ok: true, note: `Guardé «${saved.label}».`, id: saved.id };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo guardar el escenario.') };
  }
}

export async function deleteScenarioAction(id: string): Promise<FinanceActionResult> {
  try {
    const user = await requireSession();
    if (typeof id !== 'string' || !id) return { ok: false, error: 'Ese escenario no existe.' };
    const db = getOrgScopedClient(user.organization.id);
    await deleteScenario(db, id);
    revalidatePath(PATH);
    return { ok: true, note: 'Borré el escenario.' };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo borrar el escenario.') };
  }
}

export async function declareRecurringAction(input: {
  label: string;
  direction: 'in' | 'out';
  amount: string;
  every: 'week' | 'month';
  anchor: number;
  category?: string | null;
  currency?: string | null;
}): Promise<FinanceActionResult> {
  try {
    const user = await admin();
    const label = String(input.label ?? '')
      .trim()
      .slice(0, 120);
    if (!label) return { ok: false, error: 'Ponle nombre: «Arriendo bodega», «Nómina».' };
    const amount = parseMoneyInput(String(input.amount ?? ''));
    if (!amount || amount <= 0)
      return { ok: false, error: 'Escribe el monto, por ejemplo 6.500.000.' };
    const every = input.every === 'week' ? 'week' : 'month';
    const anchor = Math.round(Number(input.anchor));
    const maxAnchor = every === 'week' ? 7 : 31;
    if (!Number.isFinite(anchor) || anchor < 1 || anchor > maxAnchor) {
      return {
        ok: false,
        error: every === 'week' ? 'Escoge el día de la semana.' : 'El día del mes va de 1 a 31.',
      };
    }
    const currency = String(input.currency ?? 'COP')
      .trim()
      .toUpperCase();
    const db = getOrgScopedClient(user.organization.id);
    const flow = await declareRecurring(db, {
      label,
      direction: input.direction === 'in' ? 'in' : 'out',
      amount,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : 'COP',
      every,
      anchor,
      category: input.category?.trim() || null,
      userId: user.id,
    });
    revalidatePath(PATH);
    return { ok: true, note: `Agregué «${flow.label}» a los gastos fijos.`, id: flow.id };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo agregar.') };
  }
}

export async function decideRecurringAction(input: {
  detectedKey: string;
  status: 'confirmed' | 'ignored';
}): Promise<FinanceActionResult> {
  try {
    const user = await admin();
    if (typeof input.detectedKey !== 'string' || !input.detectedKey) {
      return { ok: false, error: 'No encontré ese gasto fijo.' };
    }
    const status = input.status === 'ignored' ? 'ignored' : 'confirmed';
    const db = getOrgScopedClient(user.organization.id);
    await decideDetectedRecurring(db, {
      detectedKey: input.detectedKey,
      status,
      userId: user.id,
      today: bogotaToday(),
    });
    revalidatePath(PATH);
    return {
      ok: true,
      note:
        status === 'confirmed'
          ? 'Confirmado: se cuenta en la proyección.'
          : 'Listo: ya no se cuenta como fijo.',
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo guardar la decisión.') };
  }
}

export async function saveMinimumCashAction(input: {
  amount: string | null;
  currency?: string;
}): Promise<FinanceActionResult> {
  const started = performance.now();
  try {
    const user = await requireSession();
    const owner = user.organization.kind === 'company' && user.organization.role === 'owner';
    if (user.role !== 'org_admin' && !owner)
      return {
        ok: false,
        error: 'Sólo quien administra la empresa o es su dueño puede fijar la caja mínima.',
      };
    const raw = String(input?.amount ?? '').trim();
    const amount = raw ? parseMoneyInput(raw) : null;
    if (raw && (amount == null || amount < 0))
      return { ok: false, error: 'Escribe la caja mínima, por ejemplo 20.000.000.' };
    const currency = String(input?.currency ?? 'COP')
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'La moneda no es válida.' };
    const db = getOrgScopedClient(user.organization.id);
    const saved = await saveLedgerSettings(db, {
      minimumCash: amount && amount > 0 ? amount : null,
      currency,
      userId: user.id,
    });
    await writeAuditEvent({
      db,
      userId: user.id as UUID,
      toolId: 'ledger.set_minimum_cash',
      input: { amount: saved.minimumCash, currency: saved.currency },
      status: 'ok',
      latencyMs: Math.round(performance.now() - started),
      surface: 'web',
      decision: 'confirmed',
      metadata: { from: 'finance' },
    });
    revalidatePath(PATH);
    return {
      ok: true,
      note:
        saved.minimumCash === null
          ? 'Quité la caja mínima de la empresa: se mide contra un mes de gastos fijos.'
          : `Listo: ${fullMoney(saved.minimumCash, saved.currency)} es la caja mínima de la empresa. El centro de mando, el pulso y la revisión semanal miden contra ella.`,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo guardar la caja mínima.') };
  }
}
