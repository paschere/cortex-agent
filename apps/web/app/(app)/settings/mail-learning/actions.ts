'use server';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { ensurePersonalSpace } from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
export async function reviewLearning(input: unknown) {
  const user = await requireSession();
  try {
    const data = z
      .object({
        id: z.string().uuid(),
        decision: z.enum(['approved', 'case_only', 'discarded']),
        note: z.string().trim().min(10).max(1500),
        content: z.string().max(5000),
        title: z.string().trim().min(3).max(160),
        spaceId: z.string().uuid().nullable(),
      })
      .parse(input);
    const db = getOrgScopedClient(user.organization.id);
    const spaceId =
      data.decision === 'approved'
        ? (data.spaceId ?? (await ensurePersonalSpace(db, user.id)).id)
        : null;
    const r = await db.rpc('mail_review_learning', {
      p_user_id: user.id,
      p_id: data.id,
      p_decision: data.decision,
      p_note: data.note,
      p_content: data.content,
      p_title: data.title,
      p_space_id: spaceId,
    });
    if (r.error)
      return {
        ok: false as const,
        error: r.error.code === 'P0001' ? r.error.message : 'No se pudo guardar la revisión.',
      };
    revalidatePath('/settings/mail-learning');
    revalidatePath('/kb');
    return { ok: true as const, documentId: r.data as string | null };
  } catch {
    return {
      ok: false as const,
      error: 'Revisa el contenido, el destino y el criterio (mínimo 10 caracteres).',
    };
  }
}
