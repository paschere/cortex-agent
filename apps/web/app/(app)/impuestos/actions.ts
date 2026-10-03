'use server';

import type { TaxMarkInput, TaxProfileFormInput } from '@/components/tax/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  bogotaToday,
  markTaxObligation,
  saveTaxProfile,
  syncTaxCalendar,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE CAMBIA DESDE /impuestos. Cada export es un endpoint que cualquiera
 * con sesión puede llamar, así que el permiso lo vuelve a revisar el store:
 * el perfil, sólo quien administra o es dueño (`saveTaxProfile`); marcar, el
 * responsable de los impuestos o quien administra (`markTaxObligation`).
 */

function message(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : '';
  return text && text.length < 300 ? text : fallback;
}

export async function saveTaxProfileAction(
  input: TaxProfileFormInput,
): Promise<{ ok: boolean; note: string }> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    const profile = await saveTaxProfile(db, input, { userId: user.id });
    const sync = await syncTaxCalendar(db, { userId: user.id, today: bogotaToday(), profile });
    await writeAuditEvent({
      db,
      userId: user.id,
      toolId: 'tax.configure',
      input: { ...input },
      status: 'ok',
      latencyMs: 0,
      metadata: { via: 'impuestos' },
    }).catch(() => undefined);
    revalidatePath('/impuestos');
    revalidatePath('/commitments');
    const changed = sync.inserted + sync.updated + sync.removed;
    return {
      ok: true,
      note: changed
        ? `Guardado. Recalculé ${changed === 1 ? '1 fecha' : `${changed} fechas`}.`
        : 'Guardado. Las fechas no cambiaron.',
    };
  } catch (err) {
    logger.error('tax: no se pudo guardar el perfil tributario', { err });
    return { ok: false, note: message(err, 'No pude guardar el perfil. Intenta de nuevo.') };
  }
}

export async function markTaxObligationAction(
  input: TaxMarkInput,
): Promise<{ ok: boolean; note: string }> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    const { obligation, commitmentNote } = await markTaxObligation(db, {
      id: input.id,
      status: input.status,
      note: input.note ?? null,
      evidenceDocumentId: input.evidenceDocumentId ?? null,
      evidenceUrl: input.evidenceUrl ?? null,
      userId: user.id,
    });
    await writeAuditEvent({
      db,
      userId: user.id,
      toolId: 'tax.mark',
      input: { ...input },
      status: 'ok',
      latencyMs: 0,
      metadata: { via: 'impuestos' },
    }).catch(() => undefined);
    revalidatePath('/impuestos');
    revalidatePath('/commitments');
    return { ok: true, note: commitmentNote ?? `Marcada: ${obligation.title}.` };
  } catch (err) {
    logger.error('tax: no se pudo marcar la obligación', { err });
    return { ok: false, note: message(err, 'No pude guardar. Intenta de nuevo.') };
  }
}
