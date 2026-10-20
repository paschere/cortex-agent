'use server';

import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  accountingInvoiceDraftApprove,
  accountingInvoiceDraftDiscard,
  isCompanyManager,
  runTool,
  toolErrorMessage,
  updateInvoiceDraft,
  updateOutboxPayload,
} from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE HACE DESDE «PREFACTURAS POR REVISAR».
 *
 * Editar es una escritura interna de quien administra. Aprobar y descartar
 * pasan por las MISMAS herramientas que usa el chat (`runTool`): misma
 * validación, misma idempotencia y fila de auditoría a nombre de quien pulsó.
 * El botón de la pantalla ES la aprobación (`confirmed`); los dos botones de
 * aprobar dicen con todas sus letras si la factura se envía a la DIAN.
 */

const PATH = '/prefacturas';

export type DraftActionResult = { ok: true; note: string } | { ok: false; error: string };

async function manager() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  if (!(await isCompanyManager(db, user.id)))
    throw new Error('Sólo quien administra la empresa revisa las prefacturas.');
  const { data } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
  if (!data?.id) throw new Error('Cortex todavía no está configurado en este espacio de trabajo.');
  const ctx = await buildToolContext({
    userId: user.id,
    agentId: data.id as UUID,
    organizationId: user.organization.id,
  });
  return { db, ctx };
}

export async function saveDraftAction(id: string, edit: unknown): Promise<DraftActionResult> {
  try {
    const { db } = await manager();
    await updateInvoiceDraft(db, id, edit);
    revalidatePath(PATH);
    return { ok: true, note: 'Cambios guardados.' };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}

export async function saveOutboxDraftAction(id: string, edit: unknown): Promise<DraftActionResult> {
  try {
    const { db } = await manager();
    await updateOutboxPayload(db, id, edit);
    revalidatePath(PATH);
    return { ok: true, note: 'Cambios guardados.' };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}

export async function approveDraftAction(id: string, sendToDian: boolean): Promise<DraftActionResult> {
  try {
    const { ctx } = await manager();
    const out = await runTool(accountingInvoiceDraftApprove, { id, sendToDian }, ctx, { confirmed: true });
    revalidatePath(PATH);
    return { ok: true, note: out.markdown.replace(/\*\*/g, '') };
  } catch (err) {
    revalidatePath(PATH);
    return { ok: false, error: toolErrorMessage(err) };
  }
}

export async function discardDraftAction(id: string): Promise<DraftActionResult> {
  try {
    const { ctx } = await manager();
    const out = await runTool(accountingInvoiceDraftDiscard, { id }, ctx, { confirmed: true });
    revalidatePath(PATH);
    return { ok: true, note: out.markdown };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}
