'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  acceptMemoryProposal,
  assertCanWriteToSpace,
  rejectMemoryProposal,
} from '@cortex/agent-tools';
import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * Aceptar o descartar un recuerdo propuesto (migración 0157), desde la tarjeta
 * del chat o desde Brain Knowledge. Quién puede aceptar lo decide
 * `acceptMemoryProposal` con `assertCanWriteToSpace`: permiso de aportar en el
 * espacio de destino, la misma regla que subir un documento ahí. Descartar
 * pide lo mismo — si no puedes escribir en el espacio, tampoco decides qué no
 * entra.
 */

export type MemoryDecision = { ok: true; message: string } | { ok: false; error: string };

function describe(err: unknown, fallback: string): string {
  if (
    err instanceof ValidationError ||
    err instanceof NotFoundError ||
    err instanceof ForbiddenError
  )
    return err.message;
  return fallback;
}

async function nameOf(db: ReturnType<typeof getOrgScopedClient>, id: string): Promise<string> {
  const { data, error } = await db.from('users').select('name, email').eq('id', id).maybeSingle();
  if (error || !data) return 'alguien del equipo';
  const row = data as { name?: string | null; email?: string | null };
  return row.name?.trim() || row.email || 'alguien del equipo';
}

export async function acceptMemoryProposalAction(id: string): Promise<MemoryDecision> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const { data, error } = await db
      .from('memory_proposals')
      .select('proposed_by')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundError('Esa propuesta ya no existe.');
    const saved = await acceptMemoryProposal(db, {
      id,
      reviewerId: user.id,
      reviewerName: user.name || user.email,
      proposerName: await nameOf(db, String((data as { proposed_by: string }).proposed_by)),
    });
    revalidatePath('/kb');
    return { ok: true, message: `Guardado en «${saved.spaceName}». Cortex ya lo tiene en cuenta.` };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar el recuerdo.') };
  }
}

export async function rejectMemoryProposalAction(id: string): Promise<MemoryDecision> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const { data, error } = await db
      .from('memory_proposals')
      .select('target_space_id')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundError('Esa propuesta ya no existe.');
    const spaceId = (data as { target_space_id: string | null }).target_space_id;
    if (spaceId) {
      await assertCanWriteToSpace(db, user.id, spaceId);
    } else if (user.role !== 'org_admin') {
      throw new ForbiddenError('Sólo un administrador decide sobre este recuerdo.');
    }
    await rejectMemoryProposal(db, { id, reviewerId: user.id });
    revalidatePath('/kb');
    return { ok: true, message: 'Descartado. No se guardó.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo descartar.') };
  }
}
