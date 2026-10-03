import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { describeLinkRun, linkClientRecords } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * COLGAR DE CADA CLIENTE LO QUE YA ESTABA GUARDADO (0179).
 *
 * Qué se vincula y qué sólo se propone está en
 * packages/agent-tools/src/clients/links.ts (reglas puras y probadas). Aquí se
 * orquesta con la forma de siempre: un cron reparte por empresa y cada empresa
 * corre en su propio trabajo, con un handle fijado a ella.
 *
 * Una vez al día, 06:30 de Bogotá (11:30 UTC; Colombia no cambia la hora),
 * antes de que alguien abra la lista. Además, cada sincronización contable que
 * termina bien pide una corrida para su empresa (accounting-sync.ts): una
 * factura nueva de un cliente nuevo aparece en su ficha la misma hora.
 *
 * Idempotente: sólo llena columnas vacías y nunca repite una propuesta, así
 * que correrlo dos veces seguidas no cambia nada la segunda.
 */
export const CLIENTS_LINK_CRON = '30 11 * * *';

export const clientsLinkDispatchJob: JobHandler = async ({ step }) => {
  // Sin alcance, y sólo aquí: «qué empresas tienen clientes o programa
  // contable» cruza la instalación. Se lee sólo organization_id.
  const workspaces = await step.run('find-workspaces', async (): Promise<string[]> => {
    const raw = getSupabaseServiceClient();
    const reads = await Promise.all([
      raw.from('clients').select('organization_id').limit(50_000),
      raw.from('accounting_connections').select('organization_id').limit(5_000),
    ]);
    const seen = new Set<string>();
    for (const { data, error } of reads) {
      if (error) throw error;
      for (const row of (data ?? []) as Array<{ organization_id: string | null }>)
        if (row.organization_id) seen.add(row.organization_id);
    }
    return [...seen];
  });
  if (workspaces.length > 0) {
    await step.sendEvent(
      'clients-link-per-workspace',
      workspaces.map((organizationId) => ({
        name: 'clients/link-workspace' as const,
        data: { organizationId },
      })),
    );
  }
  return { dispatched: workspaces.length };
};

export const clientsLinkDispatch = inngest.createFunction(
  { id: 'clients-link-dispatch' },
  { cron: CLIENTS_LINK_CRON },
  async (ctx) => clientsLinkDispatchJob(ctx as unknown as JobContext),
);

export const clientsLinkWorkspaceJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  if (!organizationId) return { skipped: 'no workspace on the event' };
  return step.run('link', async () => {
    const db = getOrgScopedClient(organizationId);
    const report = await linkClientRecords(db, {});
    if (report.failed.length) {
      logger.warn({ organizationId, failed: report.failed }, 'clients link: secciones sin leer');
    }
    return { ...report, summary: describeLinkRun(report) };
  });
};

export const clientsLinkWorkspace = inngest.createFunction(
  {
    id: 'clients-link-workspace',
    // Una corrida por empresa a la vez: dos barridos simultáneos no rompen
    // nada (los índices únicos mandan), pero harían el trabajo dos veces.
    concurrency: [{ key: 'event.data.organizationId', limit: 1 }],
  },
  { event: 'clients/link-workspace' },
  async (ctx) => clientsLinkWorkspaceJob(ctx as unknown as JobContext),
);
