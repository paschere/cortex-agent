'use server';

import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { growthUpdateSignal, runTool } from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import type { ActionResult, SignalStatus } from './_components/types';

/**
 * Every write on this page goes through `runTool` rather than straight to the
 * table, for one reason: Cortex already moves these signals from chat, and the
 * two surfaces must not drift. Same tool, same validation, same four states,
 * and the same audit row naming the person who did it.
 */

const PATH = '/prospects';

const STATUSES: SignalStatus[] = ['new', 'qualified', 'rejected', 'contacted'];

/** Cortex is the agent every tool call on this page is attributed to. */
async function cortexContext(userId: UUID, organizationId: string, signal?: AbortSignal) {
  const db = getOrgScopedClient(organizationId);
  const { data } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
  if (!data?.id) return null;
  return buildToolContext({ userId, agentId: data.id as UUID, organizationId, signal });
}

/** Turns any thrown tool error into a sentence a salesperson can act on. */
function describe(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : '';
  if (/not found/i.test(message)) return 'Ese prospecto ya no existe.';
  return message && message.length < 160 ? message : fallback;
}

const NO_AGENT =
  'Cortex todavía no está configurado en este espacio de trabajo, así que no se puede registrar nada.';

/**
 * Move a prospect between the four states. The caller updates its own UI first
 * and rolls back on `{ ok: false }`.
 */
export async function setProspectStatus(
  signalId: string,
  status: SignalStatus,
): Promise<ActionResult<{ reviewerName: string; reviewedAt: string }>> {
  const user = await requireSession();
  if (!STATUSES.includes(status)) return { ok: false, error: 'Ese no es un estado válido.' };

  const ctx = await cortexContext(user.id, user.organization.id);
  if (!ctx) return { ok: false, error: NO_AGENT };

  try {
    // The tool stamps reviewed_by/reviewed_at from ctx.userId, so the person
    // named on the card is the person whose session made the request.
    await runTool(growthUpdateSignal, { signalId, status }, ctx, { confirmed: true });
  } catch (err) {
    return {
      ok: false,
      error: describe(err, 'El cambio no se guardó. Inténtalo de nuevo en un momento.'),
    };
  }

  revalidatePath(PATH);
  return {
    ok: true,
    reviewerName: user.name ?? user.email,
    reviewedAt: new Date().toISOString(),
  };
}
