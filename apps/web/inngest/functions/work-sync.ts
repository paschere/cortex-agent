import { createHash } from 'node:crypto';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { notify } from '@/lib/notifications/notify';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { bogotaToday, getWorkItemsByIds, syncWork, workDirectory } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * EL REGISTRO DE TRABAJO, AL DÍA: la sincronización diaria y el aviso de
 * trabajo reasignado (migración 0174).
 *
 * Qué se lee y cómo está en packages/agent-tools/src/work/sync.ts (`syncWork`,
 * incremental e idempotente). Aquí sólo se orquesta, con la misma forma que
 * commitments-watch y goals-watch: un cron reparte por empresa y cada empresa
 * corre en su propio trabajo, así que un fallo queda contenido y se reintenta
 * sólo esa empresa.
 *
 * 06:45 de Bogotá todos los días: después de que el vigilante de compromisos
 * (06:00) refresca sus estados, para que lo vencido de hoy entre como vencido.
 * Colombia no cambia la hora: 11:45 UTC son las 06:45 todo el año. Además,
 * `work.query` sincroniza antes de contestar si el registro lleva más de seis
 * horas sin refrescarse, así que una empresa nunca depende sólo de este cron.
 *
 * `work/assigned` avisa en la campana a quien le pasaron trabajo con
 * `work.assign`. Nombra los títulos del trabajo y quién lo pasó; nada más.
 */
export const WORK_SYNC_CRON = '45 11 * * *';

/** Las fuentes de las que sale trabajo: si una empresa no tiene ninguna, no hay nada que sincronizar. */
const SOURCE_TABLES = ['work_settings', 'management_cases', 'commitments', 'actions'] as const;

export const workSyncDispatchJob: JobHandler = async ({ step }) => {
  const today = bogotaToday();
  // Sin alcance, y sólo aquí: «qué empresas tienen trabajo que leer» cruza la
  // instalación. Se lee sólo organization_id; cada id viaja en su evento.
  const workspaces = await step.run('find-workspaces', async (): Promise<string[]> => {
    const raw = getSupabaseServiceClient();
    const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const reads = await Promise.all([
      ...SOURCE_TABLES.map((table) => raw.from(table).select('organization_id').limit(50_000)),
      raw
        .from('mcp_pending_actions')
        .select('organization_id')
        .gte('created_at', since)
        .limit(50_000),
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
      'work-sync-per-workspace',
      workspaces.map((organizationId) => ({
        name: 'work/sync.workspace' as const,
        data: { organizationId, today },
      })),
    );
  }
  return { dispatched: workspaces.length, today };
};

export const workSyncDispatch = inngest.createFunction(
  { id: 'work-sync-dispatch' },
  { cron: WORK_SYNC_CRON },
  async (ctx) => workSyncDispatchJob(ctx as unknown as JobContext),
);

export const workSyncWorkspaceJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  if (!organizationId) return { skipped: 'no workspace on the event' };
  const result = await step.run('sync', async () => {
    const r = await syncWork(getOrgScopedClient(organizationId), organizationId);
    return { sources: r.sources, warnings: r.warnings, at: r.at };
  });
  logger.info({ organizationId, ...result }, 'work registry sync finished');
  return { organizationId, ...result };
};

export const workSyncWorkspace = inngest.createFunction(
  { id: 'work-sync-workspace', concurrency: { limit: 5 } },
  { event: 'work/sync.workspace' },
  async (ctx) => workSyncWorkspaceJob(ctx as unknown as JobContext),
);

export const workAssignedJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  const assigneeId = event.data.assigneeId as string | undefined;
  const assignedBy = (event.data.assignedBy as string | undefined) ?? null;
  const itemIds = Array.isArray(event.data.itemIds)
    ? (event.data.itemIds as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (!organizationId || !assigneeId || itemIds.length === 0)
    return { skipped: 'incomplete event' };

  const sent = await step.run('notify', async () => {
    const db = getOrgScopedClient(organizationId);
    const [items, people] = await Promise.all([getWorkItemsByIds(db, itemIds), workDirectory(db)]);
    // Sólo lo que de verdad quedó a su nombre: si alguien lo volvió a pasar
    // entre el encargo y este aviso, no se le avisa de algo que ya no es suyo.
    const mine = items.filter((i) => i.assigneeId === assigneeId);
    if (!mine.length) return { notified: false };
    const by = people.find((p) => p.id === assignedBy);
    const byName = by ? by.name?.trim() || by.email : null;
    const [first] = mine;
    const title =
      mine.length === 1 && first
        ? `Te pasaron «${first.title.slice(0, 110)}»`
        : `Te pasaron ${mine.length} tareas`;
    const list = mine
      .slice(0, 5)
      .map((i) => `«${i.title.slice(0, 90)}»`)
      .join(', ');
    const body = [
      byName ? `Te lo pasó ${byName}.` : null,
      mine.length > 1 ? `${list}${mine.length > 5 ? ' y más' : ''}.` : null,
      'Lo ves todo en «Mi semana».',
    ]
      .filter(Boolean)
      .join(' ');
    const key = createHash('sha256')
      .update(`${assigneeId}|${[...itemIds].sort().join(',')}|${event.data.at ?? ''}`)
      .digest('hex')
      .slice(0, 32);
    const id = await notify(db, {
      userId: assigneeId,
      kind: 'work_assigned',
      title,
      body,
      // «Mi semana»: lo que la espera, con lo recién pasado entre lo abierto.
      href: '/team/yo',
      dedupeKey: `work-assigned:${key}`,
    });
    return { notified: Boolean(id) };
  });
  return { organizationId, ...sent };
};

export const workAssigned = inngest.createFunction(
  { id: 'work-assigned', concurrency: { limit: 5 } },
  { event: 'work/assigned' },
  async (ctx) => workAssignedJob(ctx as unknown as JobContext),
);
