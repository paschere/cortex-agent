'use server';

import type { CloseActionResult } from '@/components/close/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type WritebackKind,
  type WritebackPreview,
  assignCloseTask,
  closePeriod,
  discardWriteback,
  executeWriteback,
  isClosePeriod,
  markCloseTask,
  openOverrideWindow,
  prepareWriteback,
  reopenPeriod,
  resetAccountMapRow,
  restoreWriteback,
  saveAccountMapRow,
  toolErrorMessage,
  writeAuditEvent,
} from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE DECIDE DESDE /cierre (0192).
 *
 * Cada export de un archivo 'use server' es un endpoint que cualquiera con
 * sesión puede llamar, así que cada uno vuelve a mirar quién es: cerrar,
 * reabrir, abrir una ventana de cambios y cambiar el plan de cuentas lo hace un
 * administrador o dueño (lo revisa el módulo, close/store.ts y lock.ts). Registrar en
 * el programa contable lo aprueba la persona que pulsa, con la vista previa
 * delante, y queda en la auditoría como confirmado; el mes del documento no
 * puede estar cerrado (lo revisa executeWriteback).
 */

const PATH = '/cierre';
const UUID_RE = /^[0-9a-f-]{36}$/i;
const KINDS: readonly WritebackKind[] = ['compra', 'recibo', 'pago_proveedor'];
const TOOL_OF: Record<WritebackKind, string> = {
  compra: 'accounting.write_purchase',
  recibo: 'accounting.write_receipt',
  pago_proveedor: 'accounting.write_supplier_payment',
};

async function scoped() {
  const user = await requireSession();
  return { user, db: getOrgScopedClient(user.organization.id) };
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: toolErrorMessage(err) };
}

function cleanPeriod(period: unknown): string {
  if (!isClosePeriod(period)) throw new Error('El mes va como AAAA-MM.');
  return period;
}

function cleanKind(kind: unknown): WritebackKind {
  if (!KINDS.includes(kind as WritebackKind)) throw new Error('Tipo de registro no válido.');
  return kind as WritebackKind;
}

function cleanId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('Identificador no válido.');
  return id;
}

export async function markTaskAction(
  period: string,
  key: string,
  status: 'pendiente' | 'hecha' | 'no_aplica',
  evidence: string,
): Promise<CloseActionResult> {
  try {
    const { user, db } = await scoped();
    if (!['pendiente', 'hecha', 'no_aplica'].includes(status)) throw new Error('Estado no válido.');
    const view = await markCloseTask(db, {
      period: cleanPeriod(period),
      key: String(key).slice(0, 40),
      status,
      evidence: String(evidence ?? '').slice(0, 2000),
      userId: user.id,
    });
    revalidatePath(PATH);
    return { ok: true, note: `${view.headline} (${view.progress.done}/${view.progress.total}).` };
  } catch (err) {
    return fail(err);
  }
}

export async function assignTaskAction(
  period: string,
  key: string,
  ownerId: string | null,
): Promise<CloseActionResult> {
  try {
    const { user, db } = await scoped();
    await assignCloseTask(db, {
      period: cleanPeriod(period),
      key: String(key).slice(0, 40),
      ownerId: ownerId ? cleanId(ownerId) : null,
      userId: user.id,
    });
    revalidatePath(PATH);
    return { ok: true, note: ownerId ? 'Responsable asignado.' : 'Sin responsable.' };
  } catch (err) {
    return fail(err);
  }
}

export async function closePeriodAction(period: string, note: string): Promise<CloseActionResult> {
  try {
    const { user, db } = await scoped();
    const r = await closePeriod(db, {
      period: cleanPeriod(period),
      userId: user.id,
      note: String(note ?? '').slice(0, 500),
    });
    revalidatePath(PATH);
    return {
      ok: true,
      note: r.closed
        ? `Cerré ${r.view.label}. Los cambios de Cortex con fecha de ese mes quedan bloqueados.`
        : `${r.view.label} ya estaba cerrado.`,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function reopenPeriodAction(
  period: string,
  reason: string,
): Promise<CloseActionResult> {
  try {
    const { user, db } = await scoped();
    const view = await reopenPeriod(db, {
      period: cleanPeriod(period),
      userId: user.id,
      reason: String(reason ?? ''),
    });
    revalidatePath(PATH);
    return { ok: true, note: `Reabrí ${view.label}.` };
  } catch (err) {
    return fail(err);
  }
}

export async function openOverrideAction(
  period: string,
  reason: string,
): Promise<CloseActionResult> {
  try {
    const { user, db } = await scoped();
    const row = await openOverrideWindow(db, {
      period: cleanPeriod(period),
      userId: user.id,
      reason: String(reason ?? ''),
    });
    revalidatePath(PATH);
    return {
      ok: true,
      note: `Cambios permitidos hasta las ${new Date(row.override_until ?? Date.now()).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })}. Quedó anotado.`,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function previewWritebackAction(
  kind: WritebackKind,
  sourceId: string,
): Promise<{ ok: true; preview: WritebackPreview } | { ok: false; error: string }> {
  try {
    const { db } = await scoped();
    const p = await prepareWriteback(db, cleanKind(kind), cleanId(sourceId));
    return { ok: true, preview: p.preview };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Registrar lo elegido, uno por uno: cada uno con su toma, su llave de
 * idempotencia y su línea de auditoría. Hasta 25 por vez.
 */
export async function registerWritebacksAction(
  items: Array<{ kind: WritebackKind; sourceId: string }>,
  retryUncertain: boolean,
): Promise<
  | { ok: true; note: string; results: Array<{ sourceId: string; ok: boolean; message: string }> }
  | { ok: false; error: string }
> {
  try {
    const { user, db } = await scoped();
    const list = (Array.isArray(items) ? items : [])
      .slice(0, 25)
      .map((i) => ({ kind: cleanKind(i?.kind), sourceId: cleanId(i?.sourceId) }));
    if (!list.length) return { ok: false, error: 'Elige al menos uno.' };
    const results: Array<{ sourceId: string; ok: boolean; message: string }> = [];
    for (const item of list) {
      const started = performance.now();
      try {
        const out = await executeWriteback(
          { db, organizationId: user.organization.id, userId: user.id },
          item.kind,
          item.sourceId,
          { retryUncertain: Boolean(retryUncertain) },
        );
        results.push({
          sourceId: item.sourceId,
          ok: true,
          message: out.markdown.replace(/\*\*/g, ''),
        });
        await writeAuditEvent({
          db,
          userId: user.id as UUID,
          toolId: TOOL_OF[item.kind],
          input: item,
          status: 'ok',
          latencyMs: Math.round(performance.now() - started),
          surface: 'web',
          decision: 'confirmed',
          metadata: { provider: out.provider, providerId: out.providerId, outcome: out.status },
        });
      } catch (err) {
        results.push({ sourceId: item.sourceId, ok: false, message: toolErrorMessage(err) });
        await writeAuditEvent({
          db,
          userId: user.id as UUID,
          toolId: TOOL_OF[item.kind],
          input: item,
          status: 'error',
          latencyMs: Math.round(performance.now() - started),
          surface: 'web',
          decision: 'confirmed',
          metadata: { error: toolErrorMessage(err).slice(0, 300) },
        });
      }
    }
    revalidatePath(PATH);
    const okCount = results.filter((r) => r.ok).length;
    return {
      ok: true,
      note:
        okCount === results.length
          ? `Registré ${okCount === 1 ? 'uno' : okCount}.`
          : `Registré ${okCount} de ${results.length}; mira el detalle de los que no.`,
      results,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function discardWritebackAction(
  kind: WritebackKind,
  sourceId: string,
  reason: string,
): Promise<CloseActionResult> {
  try {
    const { user, db } = await scoped();
    await discardWriteback(db, {
      kind: cleanKind(kind),
      sourceId: cleanId(sourceId),
      reason: String(reason ?? ''),
      userId: user.id,
    });
    revalidatePath(PATH);
    return { ok: true, note: 'Fuera de la cola: se registra a mano en el programa.' };
  } catch (err) {
    return fail(err);
  }
}

export async function restoreWritebackAction(
  kind: WritebackKind,
  sourceId: string,
): Promise<CloseActionResult> {
  try {
    const { db } = await scoped();
    await restoreWriteback(db, { kind: cleanKind(kind), sourceId: cleanId(sourceId) });
    revalidatePath(PATH);
    return { ok: true, note: 'De vuelta en la cola.' };
  } catch (err) {
    return fail(err);
  }
}

export async function saveMappingAction(row: {
  scope: 'categoria' | 'proveedor' | 'rol';
  key: string;
  accountCode: string;
  accountName: string;
  costCenter: string;
  refs: { siigo?: string; alegra?: string; quickbooks?: string };
}): Promise<CloseActionResult> {
  try {
    const { user, db } = await scoped();
    await saveAccountMapRow(
      db,
      {
        scope: row.scope,
        key: String(row.key ?? ''),
        accountCode: String(row.accountCode ?? '').replace(/[.\s]/g, ''),
        accountName: row.accountName,
        costCenter: row.costCenter,
        providerRefs: row.refs ?? {},
      },
      { userId: user.id },
    );
    revalidatePath(PATH);
    return { ok: true, note: 'Cuenta guardada.' };
  } catch (err) {
    return fail(err);
  }
}

export async function resetMappingAction(
  scope: 'categoria' | 'proveedor' | 'rol',
  key: string,
): Promise<CloseActionResult> {
  try {
    const { user, db } = await scoped();
    if (!['categoria', 'proveedor', 'rol'].includes(scope)) throw new Error('Tipo no válido.');
    await resetAccountMapRow(db, { scope, key: String(key ?? '') }, { userId: user.id });
    revalidatePath(PATH);
    return { ok: true, note: 'Vuelve al defecto de Cortex.' };
  } catch (err) {
    return fail(err);
  }
}
