import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import type { Operation } from '@cortex/agent-tools';
import {
  bogotaToday,
  readManagement,
  readOperationEvents,
  readOperations,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { OperationWorkspace } from './workspace';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export default async function Page({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const params = await searchParams;
  const [board, cycles, goals] = await Promise.all([
    readManagement(db),
    readOperations(db),
    db.from('goals').select('id,label').eq('state', 'active').limit(101),
  ]);
  let selected =
    cycles.operations.find((o) => !['completed', 'cancelled'].includes(o.state)) ?? null;
  if (params.id) {
    if (!z.string().uuid().safeParse(params.id).success) notFound();
    const result = await db
      .from('management_operations')
      .select('id,data,state,revision,created_at,updated_at')
      .eq('id', params.id)
      .maybeSingle();
    if (result.error) throw new Error('No se pudo leer el ciclo.');
    if (!result.data) notFound();
    selected = result.data as Operation;
  }
  const history = selected
    ? await readOperationEvents(db, selected.id)
    : { events: [], truncated: false };
  return (
    <OperationWorkspace
      {...board}
      operation={selected}
      operations={cycles.operations}
      events={history.events}
      goals={goals.error ? [] : (goals.data ?? [])}
      today={bogotaToday()}
      userId={user.id}
      isAdmin={user.role === 'org_admin'}
      partial={
        cycles.truncated ||
        history.truncated ||
        board.truncated ||
        !!goals.error ||
        (goals.data?.length ?? 0) > 100
      }
    />
  );
}
