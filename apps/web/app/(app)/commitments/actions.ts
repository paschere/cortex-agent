'use server';

import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type CommitmentKind,
  type Recurrence,
  acknowledgeNotices,
  bogotaToday,
  confirmExtracted,
  createCommitment,
  dropCommitment,
  getCommitment,
  markMet,
  recordCalendarError,
  rejectExtracted,
  rescheduleCommitment,
  syncCommitmentToCalendar,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import type { ActionResult } from './_components/types';

const PATH = '/commitments';

function describe(err: unknown, fallback: string): string {
  if (err instanceof NotFoundError) return 'Ese compromiso ya no existe.';
  if (err instanceof ValidationError) return err.message;
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 200 ? message : fallback;
}

/**
 * Push the calendar towards the commitment, and never let Google decide whether
 * the person's action succeeded.
 *
 * Marking something as met is a fact about the world; the calendar event is a
 * reflection of it. If Google is unreachable, the fact stands and the failure
 * is recorded on the row so the screen can say so — the next watcher run picks
 * it up. Wrapping this any tighter would mean a Calendar outage rejecting a
 * button press.
 */
async function nudgeCalendar(organizationId: string, commitmentId: string): Promise<void> {
  try {
    const db = getOrgScopedClient(organizationId);
    const row = await getCommitment(db, commitmentId);
    if (!row?.owner_user_id) return;
    const ctx = buildToolContext({
      organizationId,
      userId: row.owner_user_id,
      agentId: row.owner_user_id,
      surface: 'web',
    });
    try {
      await syncCommitmentToCalendar(ctx, row, bogotaToday());
    } catch (err) {
      await recordCalendarError(ctx, commitmentId, (err as Error).message);
    }
  } catch {
    // Nothing here may fail the action that called it.
  }
}

export async function recordCommitment(input: {
  title: string;
  dueOn: string;
  kind: CommitmentKind;
  detail?: string;
  counterparty?: string;
  amountCop?: number | null;
  noticeDays?: number | null;
  ownerUserId?: string | null;
  escalateToUserId?: string | null;
  recurrence?: Recurrence;
}): Promise<ActionResult> {
  const user = await requireSession();
  if (!input.title.trim()) return { ok: false, error: 'Ponle un nombre primero.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn)) {
    return { ok: false, error: 'Falta la fecha de vencimiento.' };
  }

  try {
    const db = getOrgScopedClient(user.organization.id);
    const row = await createCommitment(db, {
      title: input.title,
      detail: input.detail ?? null,
      kind: input.kind,
      dueOn: input.dueOn,
      noticeDays: input.noticeDays ?? null,
      counterparty: input.counterparty ?? null,
      amountCop: input.amountCop ?? null,
      ownerUserId: input.ownerUserId ?? user.id,
      escalateToUserId: input.escalateToUserId ?? null,
      recurrence: input.recurrence ?? 'none',
      // The person in front of the screen is the source. There is no field on
      // this form that lets somebody claim a date came from somewhere else.
      source: { kind: 'manual', userId: user.id },
      createdBy: user.id,
    });
    await nudgeCalendar(user.organization.id, row.id);
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo registrar el compromiso.') };
  }
}

export async function fulfilCommitment(id: string, note?: string): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    await markMet(db, { id, userId: user.id, note: note ?? null });
    await nudgeCalendar(user.organization.id, id);
    revalidatePath(PATH);
    revalidatePath(`${PATH}/${id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo marcar como cumplido.') };
  }
}

export async function discardCommitment(id: string, reason: string): Promise<ActionResult> {
  const user = await requireSession();
  if (!reason.trim()) return { ok: false, error: 'Dinos por qué ya no aplica.' };
  try {
    const db = getOrgScopedClient(user.organization.id);
    await dropCommitment(db, { id, reason, userId: user.id });
    await nudgeCalendar(user.organization.id, id);
    revalidatePath(PATH);
    revalidatePath(`${PATH}/${id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo descartar.') };
  }
}

/**
 * The one action the whole module is built around: a person vouches for an
 * extracted date, and it starts being watched under their name.
 */
export async function confirmCommitment(
  id: string,
  correctedDueOn?: string,
): Promise<ActionResult> {
  const user = await requireSession();
  if (correctedDueOn && !/^\d{4}-\d{2}-\d{2}$/.test(correctedDueOn)) {
    return { ok: false, error: 'Esa fecha no sirve; usa el selector.' };
  }
  try {
    const db = getOrgScopedClient(user.organization.id);
    await confirmExtracted(db, { id, userId: user.id, dueOn: correctedDueOn });
    await nudgeCalendar(user.organization.id, id);
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo confirmar.') };
  }
}

export async function rejectCommitment(id: string, reason?: string): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    await rejectExtracted(db, { id, userId: user.id, reason });
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo descartar la propuesta.') };
  }
}

export async function moveDueDate(id: string, dueOn: string): Promise<ActionResult> {
  const user = await requireSession();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return { ok: false, error: 'Fecha inválida.' };
  try {
    const db = getOrgScopedClient(user.organization.id);
    await rescheduleCommitment(db, { id, dueOn });
    await nudgeCalendar(user.organization.id, id);
    revalidatePath(PATH);
    revalidatePath(`${PATH}/${id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo cambiar la fecha.') };
  }
}

/** "Ya lo vi": stops the escalation without pretending the thing is done. */
export async function acknowledgeCommitment(id: string): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    await acknowledgeNotices(db, { commitmentId: id, userId: user.id });
    revalidatePath(PATH);
    revalidatePath(`${PATH}/${id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo marcar como visto.') };
  }
}
