import { canSeeTask } from '@/lib/background-tasks/scope';
import { taskViewerFor } from '@/lib/background-tasks/viewer';
import { appBaseUrl } from '@/lib/email-templates';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { canShareTask } from '@/lib/task-share/shape';
import { createShare, listShares, loadTaskById } from '@/lib/task-share/store';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ID = /^[0-9a-f-]{36}$/i;

const Body = z.object({
  days: z.number().int().min(1).max(30).optional(),
  hidePersonal: z.boolean().optional(),
  includeShots: z.boolean().optional(),
});

async function authorize(id: string) {
  const user = await requireSession();
  if (!ID.test(id))
    return { error: NextResponse.json({ error: 'No encontrada' }, { status: 404 }) };
  const db = getOrgScopedClient(user.organization.id);
  const task = await loadTaskById(db, id);
  const viewer = await taskViewerFor(user);
  // Quien no ve la tarea ni se entera de que existe.
  if (!task || !canSeeTask(viewer, task)) {
    return { error: NextResponse.json({ error: 'No encontrada' }, { status: 404 }) };
  }
  if (!canShareTask(viewer, task)) {
    return {
      error: NextResponse.json(
        { error: 'Sólo la dueña de la tarea o quien administra puede compartirla.' },
        { status: 403 },
      ),
    };
  }
  return { user, db, task, viewer };
}

/** Los enlaces de esta tarea (sin el token: de él sólo queda el hash). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await authorize((await params).id);
  if ('error' in a) return a.error;
  return NextResponse.json({ shares: await listShares(a.db, a.task.id) });
}

/** Crear el enlace. El token en claro sale UNA vez, en esta respuesta. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await authorize((await params).id);
  if ('error' in a) return a.error;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Opciones no válidas.' }, { status: 400 });
  const result = await createShare(a.db, {
    organizationId: a.user.organization.id,
    companyName: a.user.organization.name,
    task: a.task,
    actorId: a.user.id,
    ...parsed.data,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    url: `${process.env.APP_BASE_URL ? appBaseUrl() : new URL(req.url).origin}/r/${result.token}`,
    share: result.share,
  });
}
