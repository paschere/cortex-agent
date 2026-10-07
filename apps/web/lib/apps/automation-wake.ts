import { enqueueJob } from '@/lib/jobs';

/**
 * El despertador del punto de emisión (packages/agent-tools/src/apps/automations/emit.ts):
 * apenas una escritura deja una corrida en cola, esto encola `apps/automation.run`
 * para que corra enseguida y no espere al barrido del minuto. Si encolar falla,
 * el barrido la recoge: la corrida ya está guardada.
 */
export async function wakeAutomationRuns(
  runs: Array<{ id: string; organizationId: string }>,
): Promise<void> {
  await Promise.all(
    runs.map((r) =>
      enqueueJob('apps/automation.run', { runId: r.id, organizationId: r.organizationId }),
    ),
  );
}
