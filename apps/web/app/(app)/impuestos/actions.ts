'use server';

import type { TaxMarkInput, TaxProfileFormInput } from '@/components/tax/types';
import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  annulTaxDraft,
  bogotaToday,
  buildDraftFromData,
  draftTargetFor,
  getTaxObligation,
  liveDraftFor,
  markDraftPresented,
  markDraftReviewed,
  markTaxObligation,
  readTaxProfile,
  runTool,
  saveTaxDraft,
  saveTaxProfile,
  setSupplierWithholdingConcept,
  syncTaxCalendar,
  taxCertificates,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { type UUID, logger } from '@cortex/core';
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

// ---------------------------------------------------------------------------
// Borradores (0197). Las cifras se vuelven a armar AQUÍ, en el servidor, con
// los datos de la empresa: nunca se guarda lo que mande el navegador.
// ---------------------------------------------------------------------------

async function draftContext(obligationId: string) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [obligation, profile] = await Promise.all([
    getTaxObligation(db, obligationId),
    readTaxProfile(db),
  ]);
  if (!obligation || !profile) throw new Error('Esa obligación ya no está en el calendario.');
  const target = draftTargetFor(obligation);
  if (!target) throw new Error('Esa obligación no tiene borrador.');
  return { user, db, obligation, profile, target };
}

async function freshFigures(ctx: Awaited<ReturnType<typeof draftContext>>) {
  return buildDraftFromData(ctx.db, {
    profile: ctx.profile,
    target: ctx.target,
    today: bogotaToday(),
    viewerId: ctx.user.id,
  });
}

function done(obligationId: string) {
  revalidatePath('/impuestos');
  revalidatePath(`/impuestos/borrador/${obligationId}`);
}

export async function saveTaxDraftAction(
  obligationId: string,
  note: string | null,
): Promise<{ ok: boolean; note: string }> {
  try {
    const ctx = await draftContext(obligationId);
    const figures = await freshFigures(ctx);
    await saveTaxDraft(ctx.db, {
      obligation: ctx.obligation,
      figures,
      userId: ctx.user.id,
      notes: note,
    });
    done(obligationId);
    return { ok: true, note: 'Borrador guardado con las cifras de ahora.' };
  } catch (err) {
    logger.error('tax: no se pudo guardar el borrador', { err });
    return { ok: false, note: message(err, 'No pude guardar el borrador.') };
  }
}

export async function reviewTaxDraftAction(
  obligationId: string,
  note: string | null,
  expectedResult: number,
): Promise<{ ok: boolean; note: string }> {
  try {
    const ctx = await draftContext(obligationId);
    const live = await liveDraftFor(ctx.db, obligationId);
    let figures = null;
    if (!live || live.status === 'borrador') {
      figures = await freshFigures(ctx);
      // Lo que se congela es lo que el contador vio: si cambió mientras tanto, que recargue.
      if (Math.abs(figures.result.amount - expectedResult) > 0.5)
        return {
          ok: false,
          note: 'Las cifras cambiaron desde que abriste el borrador (entró o cambió una factura). Recarga la página, revísalo y vuelve a marcarlo.',
        };
    }
    await markDraftReviewed(ctx.db, {
      obligation: ctx.obligation,
      figures,
      userId: ctx.user.id,
      notes: note,
    });
    done(obligationId);
    return {
      ok: true,
      note: 'Marcado como revisado por el contador. Las cifras quedaron congeladas.',
    };
  } catch (err) {
    logger.error('tax: no se pudo marcar revisado', { err });
    return { ok: false, note: message(err, 'No pude marcarlo.') };
  }
}

export async function presentTaxDraftAction(
  obligationId: string,
  input: { evidenceDocumentId: string | null; evidenceUrl: string | null; note: string | null },
): Promise<{ ok: boolean; note: string }> {
  try {
    const ctx = await draftContext(obligationId);
    let live = await liveDraftFor(ctx.db, obligationId);
    if (!live)
      live = await saveTaxDraft(ctx.db, {
        obligation: ctx.obligation,
        figures: await freshFigures(ctx),
        userId: ctx.user.id,
        notes: input.note,
      });
    const r = await markDraftPresented(ctx.db, {
      draftId: live.id,
      userId: ctx.user.id,
      evidenceDocumentId: input.evidenceDocumentId,
      evidenceUrl: input.evidenceUrl,
      note: input.note,
    });
    await writeAuditEvent({
      db: ctx.db,
      userId: ctx.user.id,
      toolId: 'tax.mark',
      input: { obligationId, draftId: live.id, status: 'presentada' },
      status: 'ok',
      latencyMs: 0,
      metadata: { via: 'impuestos/borrador' },
    }).catch(() => undefined);
    done(obligationId);
    revalidatePath('/commitments');
    return { ok: true, note: r.obligationNote ?? 'Marcado como presentado.' };
  } catch (err) {
    logger.error('tax: no se pudo marcar presentado', { err });
    return { ok: false, note: message(err, 'No pude marcarlo.') };
  }
}

export async function annulTaxDraftAction(
  obligationId: string,
  note: string | null,
): Promise<{ ok: boolean; note: string }> {
  try {
    const ctx = await draftContext(obligationId);
    const live = await liveDraftFor(ctx.db, obligationId);
    if (!live) return { ok: false, note: 'No hay borrador guardado que anular.' };
    await annulTaxDraft(ctx.db, { draftId: live.id, userId: ctx.user.id, note });
    done(obligationId);
    return { ok: true, note: 'Anulado. Al recargar se arma uno nuevo con los datos de ahora.' };
  } catch (err) {
    logger.error('tax: no se pudo anular el borrador', { err });
    return { ok: false, note: message(err, 'No pude anularlo.') };
  }
}

// ---------------------------------------------------------------------------
// Certificados de retención (0197)
// ---------------------------------------------------------------------------

export async function sendCertificatesAction(
  scope: { kind: 'renta' | 'iva' | 'ica'; year: number; period: number | null },
  suppliers: string[],
): Promise<{ ok: boolean; note: string }> {
  const input = { ...scope, suppliers };
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const { data, error } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
  if (error || !data?.id) return { ok: false, note: 'Cortex no está configurado en este espacio.' };
  // El clic con su confirmación ES la aprobación: la misma herramienta del
  // chat, para que el correo, la auditoría y los permisos sean los mismos.
  const ctx = buildToolContext({
    userId: user.id as UUID,
    agentId: data.id as UUID,
    organizationId: user.organization.id,
  });
  try {
    const out = (await runTool(
      taxCertificates,
      {
        kind: input.kind,
        year: input.year,
        period: input.kind === 'iva' ? input.period : null,
        suppliers: input.suppliers.length ? input.suppliers : null,
      },
      ctx,
      { confirmed: true },
    )) as { sent: number; guidance: string };
    revalidatePath('/impuestos/certificados');
    return { ok: out.sent > 0, note: out.guidance };
  } catch (err) {
    logger.error('tax: no se pudieron mandar los certificados', { err });
    return { ok: false, note: message(err, 'No pude mandarlos.') };
  }
}

export async function setSupplierConceptAction(
  supplierId: string,
  concept: string | null,
): Promise<{ ok: boolean; note: string }> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    await setSupplierWithholdingConcept(db, { supplierId, concept, userId: user.id });
    revalidatePath('/impuestos/certificados');
    return { ok: true, note: 'Concepto guardado.' };
  } catch (err) {
    logger.error('tax: no se pudo guardar el concepto', { err });
    return { ok: false, note: message(err, 'No pude guardarlo.') };
  }
}
