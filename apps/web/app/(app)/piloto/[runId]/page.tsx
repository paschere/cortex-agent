import { RunDetail } from '@/components/autopilot/RunDetail';
import { buildRunView } from '@/lib/autopilot/screen';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { qualifiedToolLabel } from '@/lib/tool-taxonomy';
import { getAutopilotRun, isCompanyManager, listAutopilotItems } from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { AUTOPILOT_ACTIONS } from '../autopilot-actions';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * «LO QUE HICE HOY»: una corrida del piloto, cosa por cosa — por qué, qué se
 * hizo, cómo se verificó, cómo deshacerlo, y lo que espera decisión con su
 * botón. La corrida se lee con el handle de la empresa: una de otra no existe.
 */
export default async function PilotoRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!UUID_RE.test(runId)) notFound();
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const run = await getAutopilotRun(db, runId);
  if (!run) notFound();
  const [items, canDecide] = await Promise.all([
    listAutopilotItems(db, run.id),
    isCompanyManager(db, user.id),
  ]);
  const mandateIds = [...new Set(items.map((i) => i.mandate_id).filter(Boolean))] as string[];
  const mandateNames = new Map<string, string>();
  if (mandateIds.length) {
    const { data, error } = await db.from('mandates').select('id, label').in('id', mandateIds);
    if (!error)
      for (const m of (data ?? []) as Array<{ id: string; label: string }>)
        mandateNames.set(m.id, m.label);
  }
  return (
    <RunDetail
      run={buildRunView(run, items, (id) => qualifiedToolLabel(id), mandateNames)}
      actions={AUTOPILOT_ACTIONS}
      canDecide={canDecide}
    />
  );
}
