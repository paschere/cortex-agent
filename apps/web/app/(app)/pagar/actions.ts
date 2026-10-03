'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  approvePayables,
  bogotaToday,
  createIntegrationsClient,
  draftFromManual,
  getPayable,
  intakePayable,
  markPaid,
  pollSupplierInvoiceMail,
  proposeSchedule,
  recheckPayable,
  rejectPayables,
  reopenPayables,
  schedulePayables,
  updateSupplier,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { type UUID, logger } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE DECIDE DESDE «POR PAGAR».
 *
 * Cada export de un archivo 'use server' es un endpoint que cualquiera con
 * sesión puede llamar, así que cada uno vuelve a mirar quién es: aprobar,
 * rechazar, programar y marcar pagada lo puede el aprobador del proveedor, un
 * dueño o un administrador (lo revisa el almacén, payables/store.ts, con la
 * misma regla que usan las herramientas del chat). Ninguna mueve plata.
 */

export type PayablesActionResult = { ok: true; note: string } | { ok: false; error: string };

export interface SuggestedDate {
  id: string;
  date: string;
  lateDays: number;
  belowMinimum: boolean;
  reason: string;
}

const PATH = '/pagar';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function cleanIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return [
    ...new Set(ids.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x))),
  ].slice(0, 100);
}

async function audit(
  user: Awaited<ReturnType<typeof requireSession>>,
  toolId: string,
  input: Record<string, unknown>,
  started: number,
  metadata: Record<string, unknown> = {},
) {
  await writeAuditEvent({
    db: getOrgScopedClient(user.organization.id),
    userId: user.id as UUID,
    toolId,
    input,
    status: 'ok',
    latencyMs: Math.round(performance.now() - started),
    surface: 'web',
    decision: 'confirmed',
    metadata,
  });
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export async function approveInvoices(ids: string[]): Promise<PayablesActionResult> {
  const started = performance.now();
  try {
    const user = await requireSession();
    const list = cleanIds(ids);
    if (!list.length) return { ok: false, error: 'Elige al menos una factura.' };
    const db = getOrgScopedClient(user.organization.id);
    const r = await approvePayables(db, list, { userId: user.id });
    await audit(user, 'payables.approve', { invoices: list }, started, { done: r.done.length });
    revalidatePath(PATH);
    if (!r.done.length)
      return { ok: false, error: r.skipped[0]?.reason ?? 'No se aprobó ninguna.' };
    return {
      ok: true,
      note: `Aprobé ${plural(r.done.length, 'factura', 'facturas')}.${r.skipped.length ? ` ${r.skipped.length} no se podían aprobar.` : ''} Falta el día de pago.`,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo aprobar.') };
  }
}

export async function rejectInvoices(ids: string[], reason: string): Promise<PayablesActionResult> {
  const started = performance.now();
  try {
    const user = await requireSession();
    const list = cleanIds(ids);
    const why = String(reason ?? '')
      .trim()
      .slice(0, 500);
    if (!list.length) return { ok: false, error: 'Elige al menos una factura.' };
    if (why.length < 3) return { ok: false, error: 'Escribe por qué no se paga.' };
    const db = getOrgScopedClient(user.organization.id);
    const r = await rejectPayables(db, list, { userId: user.id, reason: why });
    await audit(user, 'payables.reject', { invoices: list, reason: why }, started, {
      done: r.done.length,
    });
    revalidatePath(PATH);
    if (!r.done.length)
      return { ok: false, error: r.skipped[0]?.reason ?? 'No se rechazó ninguna.' };
    return { ok: true, note: `Rechacé ${plural(r.done.length, 'factura', 'facturas')}.` };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo rechazar.') };
  }
}

export async function reopenInvoices(ids: string[]): Promise<PayablesActionResult> {
  try {
    const user = await requireSession();
    const list = cleanIds(ids);
    const db = getOrgScopedClient(user.organization.id);
    const r = await reopenPayables(db, list, { userId: user.id });
    revalidatePath(PATH);
    if (!r.done.length)
      return { ok: false, error: r.skipped[0]?.reason ?? 'No se reabrió ninguna.' };
    return {
      ok: true,
      note: `${plural(r.done.length, 'factura vuelve', 'facturas vuelven')} a «Por aprobar».`,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo reabrir.') };
  }
}

/** Las fechas que sugiere la caja, sin programar nada (para mostrarlas antes). */
export async function suggestPayDates(
  ids: string[],
): Promise<{ ok: true; suggestions: SuggestedDate[] } | { ok: false; error: string }> {
  try {
    const user = await requireSession();
    const list = cleanIds(ids);
    const db = getOrgScopedClient(user.organization.id);
    const rows = [];
    for (const id of list.slice(0, 25)) {
      const row = await getPayable(db, id);
      if (row) rows.push(row);
    }
    const { suggestions } = await proposeSchedule(db, rows, { today: bogotaToday() });
    return {
      ok: true,
      suggestions: suggestions.map((s) => ({
        id: s.id,
        date: s.date,
        lateDays: s.lateDays,
        belowMinimum: s.belowMinimum,
        reason: s.reason,
      })),
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No pude calcular la fecha.') };
  }
}

export async function scheduleInvoices(
  ids: string[],
  date?: string | null,
): Promise<PayablesActionResult> {
  const started = performance.now();
  try {
    const user = await requireSession();
    const list = cleanIds(ids);
    if (!list.length) return { ok: false, error: 'Elige al menos una factura.' };
    const day = date && DAY_RE.test(date) ? date : null;
    const db = getOrgScopedClient(user.organization.id);
    const r = await schedulePayables(db, list, {
      userId: user.id,
      today: bogotaToday(),
      date: day,
    });
    await audit(user, 'payables.schedule', { invoices: list, date: day }, started, {
      done: r.done.length,
    });
    revalidatePath(PATH);
    revalidatePath('/finance');
    if (!r.done.length)
      return { ok: false, error: r.skipped[0]?.reason ?? 'No se programó ninguna.' };
    const late = r.suggestions.filter((s) => !day && s.lateDays > 0).length;
    const below = r.suggestions.filter((s) => s.belowMinimum).length;
    return {
      ok: true,
      note: `Programé ${plural(r.done.length, 'pago', 'pagos')}${late ? `; ${late} se corre${late === 1 ? '' : 'n'} para no bajar de la caja mínima` : ''}${below ? `; ojo: ${below} deja${below === 1 ? '' : 'n'} la caja debajo del mínimo` : ''}.`,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo programar.') };
  }
}

export async function markInvoicePaid(input: {
  id: string;
  date: string;
  reference: string;
  note?: string;
}): Promise<PayablesActionResult> {
  const started = performance.now();
  try {
    const user = await requireSession();
    const [id] = cleanIds([input.id]);
    if (!id) return { ok: false, error: 'No encontré esa factura.' };
    if (!DAY_RE.test(input.date ?? '')) return { ok: false, error: 'Escribe la fecha del pago.' };
    if (input.date > bogotaToday())
      return { ok: false, error: 'El pago no puede ser de un día que no ha llegado.' };
    const db = getOrgScopedClient(user.organization.id);
    await markPaid(db, id, {
      userId: user.id,
      date: input.date,
      evidence: {
        reference:
          String(input.reference ?? '')
            .trim()
            .slice(0, 120) || null,
        note:
          String(input.note ?? '')
            .trim()
            .slice(0, 300) || null,
      },
    });
    await audit(user, 'payables.mark_paid', { invoice: id, date: input.date }, started);
    revalidatePath(PATH);
    return { ok: true, note: 'Quedó pagada, con su comprobante.' };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo marcar pagada.') };
  }
}

export async function recheckInvoice(id: string): Promise<PayablesActionResult> {
  try {
    const user = await requireSession();
    const [clean] = cleanIds([id]);
    if (!clean) return { ok: false, error: 'No encontré esa factura.' };
    const db = getOrgScopedClient(user.organization.id);
    const row = await recheckPayable(db, clean, { today: bogotaToday() });
    revalidatePath(PATH);
    return {
      ok: true,
      note: row.checks.length ? 'Revisada otra vez.' : 'Revisada: no encontré nada raro.',
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo revisar.') };
  }
}

export async function recordInvoice(input: {
  supplierName: string;
  supplierNit?: string;
  number: string;
  issueDate: string;
  dueDate?: string;
  total: string;
  iva?: string;
}): Promise<PayablesActionResult> {
  try {
    const user = await requireSession();
    const name = String(input.supplierName ?? '').trim();
    const number = String(input.number ?? '').trim();
    const total = Number(
      String(input.total ?? '')
        .replace(/[^\d,.-]/g, '')
        .replace(/\./g, '')
        .replace(',', '.'),
    );
    const iva = input.iva
      ? Number(
          String(input.iva)
            .replace(/[^\d,.-]/g, '')
            .replace(/\./g, '')
            .replace(',', '.'),
        )
      : 0;
    if (name.length < 2) return { ok: false, error: 'Escribe el proveedor.' };
    if (!number) return { ok: false, error: 'Escribe el número de la factura.' };
    if (!DAY_RE.test(input.issueDate ?? ''))
      return { ok: false, error: 'Escribe la fecha de la factura.' };
    if (input.dueDate && !DAY_RE.test(input.dueDate))
      return { ok: false, error: 'El vencimiento no es una fecha.' };
    if (!(total > 0)) return { ok: false, error: 'Escribe el total, por ejemplo 2.380.000.' };
    const db = getOrgScopedClient(user.organization.id);
    const draft = draftFromManual(
      {
        supplierName: name,
        supplierNit: input.supplierNit?.trim() || null,
        docNumber: number,
        issueDate: input.issueDate,
        dueDate: input.dueDate || null,
        total,
        iva: Number.isFinite(iva) ? iva : 0,
      },
      { source: 'manual', ref: `manual:${user.id}:${number}:${name}`.slice(0, 300) },
    );
    const r = await intakePayable(db, draft, { today: bogotaToday(), userId: user.id });
    revalidatePath(PATH);
    return {
      ok: true,
      note:
        r.outcome === 'creada'
          ? `Anotada la factura ${number}.`
          : `La factura ${number} ya estaba; no la dupliqué.`,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo anotar.') };
  }
}

export async function saveSupplier(input: {
  id: string;
  paymentTermsDays?: string;
  approverId?: string;
  retefuenteRate?: string;
  reteivaRate?: string;
  reteicaRate?: string;
  email?: string;
}): Promise<PayablesActionResult> {
  try {
    const user = await requireSession();
    if (
      user.role !== 'org_admin' &&
      user.organization.role !== 'owner' &&
      user.organization.role !== 'admin'
    )
      return {
        ok: false,
        error: 'Sólo un dueño o un administrador cambia las condiciones de un proveedor.',
      };
    const [id] = cleanIds([input.id]);
    if (!id) return { ok: false, error: 'No encontré ese proveedor.' };
    const pct = (raw?: string) => {
      if (raw === undefined) return undefined;
      const t = raw.trim().replace(',', '.');
      if (!t) return null;
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0 || n > 100)
        throw new Error('Una tarifa de retención va de 0 a 100 %.');
      return n;
    };
    const terms =
      input.paymentTermsDays === undefined
        ? undefined
        : input.paymentTermsDays.trim() === ''
          ? null
          : Number(input.paymentTermsDays);
    if (terms != null && (!Number.isInteger(terms) || terms < 0 || terms > 365))
      return { ok: false, error: 'El plazo va de 0 a 365 días.' };
    const db = getOrgScopedClient(user.organization.id);
    await updateSupplier(db, id, {
      paymentTermsDays: terms,
      approverId:
        input.approverId === undefined
          ? undefined
          : UUID_RE.test(input.approverId)
            ? input.approverId
            : null,
      retefuenteRate: pct(input.retefuenteRate),
      reteivaRate: pct(input.reteivaRate),
      reteicaRate: pct(input.reteicaRate),
      email: input.email,
    });
    revalidatePath(PATH);
    return {
      ok: true,
      note: 'Guardé las condiciones del proveedor. Las facturas nuevas las usan; «Revisar otra vez» las aplica a una que ya llegó.',
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo guardar el proveedor.') };
  }
}

/** Revisar ahora el correo de quien pregunta (Gmail y Outlook, el que tenga). */
export async function checkMailNow(): Promise<PayablesActionResult> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const { data, error } = await db.from('integrations').select('provider').eq('user_id', user.id);
    if (error) throw error;
    const providers = [
      ...new Set(
        ((data ?? []) as Array<{ provider: string }>)
          .map((r) => r.provider)
          .filter((p): p is 'google' | 'microsoft' => p === 'google' || p === 'microsoft'),
      ),
    ];
    if (!providers.length)
      return {
        ok: false,
        error: 'No tienes el correo conectado. Conéctalo en Datos y conexiones.',
      };
    const integrations = createIntegrationsClient(db, user.id as UUID, logger);
    const r = await pollSupplierInvoiceMail(
      db,
      { integrations, signal: undefined },
      {
        today: bogotaToday(),
        userId: user.id,
        days: 14,
        providers,
      },
    );
    revalidatePath(PATH);
    if (r.errors.length && !r.examined) return { ok: false, error: r.errors[0] as string };
    return {
      ok: true,
      note: r.created
        ? `Encontré ${plural(r.created, 'factura nueva', 'facturas nuevas')} en el correo.`
        : r.examined
          ? 'Revisé los adjuntos nuevos: ninguna factura que no tuviera ya.'
          : 'No hay adjuntos de factura electrónica nuevos en el correo de los últimos 14 días.',
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No pude revisar el correo.') };
  }
}
