'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  decideLearningProposal,
  recordSignal,
  revokeAdjustment,
  runLearningPass,
} from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';
import type { ActionResult } from './_components/types';

const PATH = '/learning';

function describe(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 160 ? message : fallback;
}

/**
 * Read the last two weeks of captured turns and decide again.
 *
 * There is a nightly cron doing the same thing (`inngest/functions/learning-
 * pass.ts`). This button exists anyway, and not only for impatience: the single
 * most useful thing a person can do with this page is undo an adjustment and
 * then watch whether it comes back — and being able to force the decision is
 * what makes that a two-minute experiment rather than a two-day one.
 */
export async function refreshLearning(): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    await runLearningPass(db, { organizationId: user.organization.id });
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo revisar el aprendizaje.') };
  }
}

/**
 * The undo.
 *
 * Deliberately available to anybody in the workspace, not only an admin. What
 * is being undone is a preference about which of two already-relevant passages
 * gets quoted first; the person best placed to notice it is wrong is whoever is
 * getting the wrong answers, and putting an approval step in front of that
 * would mean bad adjustments survive because reversing them is a favour to ask.
 */
export async function undoAdjustment(id: string, reason?: string): Promise<ActionResult> {
  const user = await requireSession();
  if (!id) return { ok: false, error: 'Falta decir cuál.' };
  try {
    const db = getOrgScopedClient(user.organization.id);
    const undone = await revokeAdjustment(db, user.organization.id, {
      id,
      userId: user.id,
      ...(reason ? { reason } : {}),
    });
    revalidatePath(PATH);
    return undone ? { ok: true } : { ok: false, error: 'Ese ajuste ya no estaba activo.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo deshacer.') };
  }
}

/**
 * Somebody decides on a proposal.
 *
 * Neither answer changes anything Cortex knows. "Me hago cargo" is a note that
 * a person is going to go and fix the document; "descartar" is a note that
 * there was nothing to fix. The module never edits the corpus on either path —
 * that is the entire reason proposals are a separate table from adjustments.
 */
export async function decideProposal(
  id: string,
  decision: 'accepted' | 'dismissed',
  note?: string,
): Promise<ActionResult> {
  const user = await requireSession();
  if (!id) return { ok: false, error: 'Falta decir cuál.' };
  try {
    const db = getOrgScopedClient(user.organization.id);
    const decided = await decideLearningProposal(db, {
      id,
      userId: user.id,
      status: decision,
      ...(note ? { note } : {}),
    });
    revalidatePath(PATH);
    return decided ? { ok: true } : { ok: false, error: 'Alguien ya lo había decidido.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar la decisión.') };
  }
}

/**
 * Somebody copied a passage out of a retrieval.
 *
 * The one signal that has to be told rather than derived, and the cheapest
 * honest positive there is: copying a fragment is somebody taking it away to
 * use, which no amount of reading the logs can infer. Deduplicated by the hour
 * so holding the button down cannot manufacture evidence — and even if it
 * could, an hour of clicking would be one person on one day, which the gates in
 * `learning/derive.ts` refuse on their own.
 */
export async function noteFragmentCopied(
  documentId: string,
  chunkIndex: number,
): Promise<ActionResult> {
  const user = await requireSession();
  if (!documentId || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return { ok: false, error: 'Falta decir qué fragmento.' };
  }
  const now = new Date();
  const db = getOrgScopedClient(user.organization.id);
  // Never throws, and never revalidates: this happens while somebody is reading
  // the bench, and it must not redraw the page under them.
  await recordSignal(db, user.organization.id, {
    kind: 'fragment_copied',
    polarity: 1,
    weight: 2,
    documentId,
    chunkIndex,
    actorUserId: user.id,
    detail: {
      kind: 'fragment_copied',
      note: 'Alguien copió este fragmento desde el banco de pruebas.',
    },
    dedupeKey: `fragment_copied:${user.id}:${documentId}:${chunkIndex}:${now.toISOString().slice(0, 13)}`,
    observedAt: now.toISOString(),
  });
  return { ok: true };
}
