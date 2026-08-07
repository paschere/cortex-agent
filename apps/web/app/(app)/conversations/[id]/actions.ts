'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { MAX_PREPENDED_FRAGMENTS, getVisibleSpace, saveOverrides } from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';
import type { AdjustView } from './_components/context/types';

/**
 * Changing what Cortex gets handed in ONE conversation.
 *
 * THE SCOPE IS THE POINT AND IT IS ENFORCED HERE. Every write names exactly one
 * conversation. There is no agent-wide and no workspace-wide variant of this
 * action, deliberately — see the header of
 * `packages/agent-tools/src/turn-context/settings.ts` for the argument, which
 * comes down to: these knobs are touched mid-diagnosis, and an adjustment made
 * in that state must not be able to change what anybody else's assistant does.
 *
 * WHO MAY. Only the person whose conversation it is. This is deliberately
 * NARROWER than reading: an org admin can open somebody else's transcript and
 * see why it answered as it did (that power already exists and is announced on
 * screen), but changing how another person's assistant behaves, from a
 * diagnostics panel, without them knowing, is a different thing entirely. If an
 * admin wants a change for everyone it belongs in the agent's own
 * configuration, where it is visible as a decision.
 */

export type SimpleResult = { ok: true } | { ok: false; error: string };

export async function saveTurnContextAdjustments(
  conversationId: string,
  adjust: AdjustView,
): Promise<SimpleResult> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const { data: conv } = await db
    .from('conversations')
    .select('id, user_id')
    .eq('id', conversationId)
    .maybeSingle();

  // "Not found" rather than "forbidden", matching the rest of the product: a
  // wrong-id probe and a somebody-else's-conversation probe stay
  // indistinguishable.
  if (!conv || (conv.user_id as string) !== user.id) {
    return { ok: false, error: 'Esa conversación ya no existe.' };
  }

  if (
    adjust.fragmentLimit !== null &&
    (!Number.isInteger(adjust.fragmentLimit) ||
      adjust.fragmentLimit < 0 ||
      adjust.fragmentLimit > MAX_PREPENDED_FRAGMENTS)
  ) {
    return { ok: false, error: `Elige entre 0 y ${MAX_PREPENDED_FRAGMENTS} fragmentos.` };
  }

  // Every space id is re-checked against what THIS person can see. The database
  // would intersect it anyway on the way to retrieval, so this cannot widen
  // anything either way — it exists so that a bad id fails here, visibly, at
  // the moment somebody sets it, instead of silently narrowing retrieval to
  // nothing three turns later.
  if (adjust.spaceIds && adjust.spaceIds.length > 0) {
    for (const spaceId of adjust.spaceIds) {
      try {
        await getVisibleSpace(db, user.id, spaceId);
      } catch {
        return { ok: false, error: 'Uno de los espacios que elegiste ya no existe.' };
      }
    }
  }

  try {
    await saveOverrides(db, {
      conversationId,
      userId: user.id,
      overrides: {
        fragmentLimit: adjust.fragmentLimit,
        spaceIds: adjust.spaceIds,
        mutedFamilies: adjust.mutedFamilies,
      },
    });
  } catch {
    return { ok: false, error: 'No se pudo guardar el ajuste. Inténtalo otra vez.' };
  }

  revalidatePath(`/conversations/${conversationId}`);
  return { ok: true };
}
