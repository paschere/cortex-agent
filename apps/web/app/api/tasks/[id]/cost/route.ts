import { TASK_COLUMNS, taskFromRow } from '@/lib/background-tasks/repository';
import { canSeeTask } from '@/lib/background-tasks/scope';
import { taskViewerFor } from '@/lib/background-tasks/viewer';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { costLine, sumUsage } from '@/lib/usage-cost';
import { loadUsageRows, loadUsdCopRate } from '@/lib/usage-cost-store';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lo que costó una tarea (0228): el consumo registrado de cada una de sus
 * tandas, con precio en pesos. Lo ve quien puede ver la tarea. Una tarea
 * anterior a la 0228 no tiene consumo registrado: devuelve `null` y la pantalla
 * muestra los tokens que la tarea sí guardaba, sin precio.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  const db = getOrgScopedClient(user.organization.id);
  const { data, error } = await db
    .from('background_tasks')
    .select(TASK_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  const task = taskFromRow(data as Record<string, unknown>);
  const viewer = await taskViewerFor(user);
  if (!canSeeTask(viewer, task))
    return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  try {
    const [{ rows }, { rate }] = await Promise.all([
      loadUsageRows(db, { taskId: id }),
      loadUsdCopRate(db),
    ]);
    if (!rows.length)
      return NextResponse.json({
        cost: null,
        tokens: task.tokensIn + task.tokensOut,
      });
    const t = sumUsage(rows);
    return NextResponse.json({
      cost: { usd: t.usd, tokens: t.tokens, turns: t.turns, rate, line: costLine(t, rate) },
      tokens: t.tokens,
    });
  } catch {
    return NextResponse.json({ cost: null, tokens: task.tokensIn + task.tokensOut });
  }
}
