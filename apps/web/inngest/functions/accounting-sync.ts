import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { notify } from '@/lib/notifications/notify';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  accountingNoticeFor,
  accountingTableSpec,
  claimAccountingConnection,
  getAccountingProvider,
  markAccountingRun,
  openAccountingSession,
  providerName,
  runAccountingSync,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * PROGRAMAS CONTABLES QUE LLENAN TABLAS Y CARTERA (migración 0165).
 *
 * Cada 15 minutos: qué conexiones tocan (`next_run_at` vencido; cada una tiene
 * su intervalo, 60 minutos por defecto). Cada una corre en su propio evento y
 * en su espacio:
 *
 *   toma → abre la sesión con la llave cifrada → trae (accounting/sync.ts) →
 *   anota → campana.
 *
 * Una corrida tiene ocho minutos: el puente de pg-boss corta a los 800 s y
 * Siigo deja ~85 peticiones por minuto (Alegra ~130, QuickBooks ~400). La primera carga de una empresa grande
 * no cabe; el motor anota dónde iba, la conexión queda «partial» y se vuelve a
 * encolar enseguida, hasta terminar.
 *
 * La campana suena para quien la conectó: al terminar la primera carga, cuando
 * entran facturas o pagos nuevos, y la primera vez que algo falla (no cada
 * hora con el mismo error). Reutiliza la clase de aviso `table_sync` (0161).
 */

const DISPATCH_CRON = '*/15 * * * *';
const RUN_BUDGET_MS = 8 * 60_000;

export const accountingDispatchJob: JobHandler = async ({ step }) => {
  // Sin alcance, y sólo aquí: «qué conexiones tocan» abarca la instalación. El
  // handle sin alcance selecciona (id, organization_id) y nada más; cada
  // conexión viaja en su evento con su espacio.
  const due = await step.run('find-due', async () => {
    const { data, error } = await getSupabaseServiceClient()
      .from('accounting_connections')
      .select('id, organization_id')
      .eq('enabled', true)
      .lte('next_run_at', new Date().toISOString())
      .limit(200);
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; organization_id: string }>;
  });
  if (due.length)
    await step.sendEvent(
      'run-each',
      due.map((c) => ({
        name: 'accounting/run' as const,
        data: { organizationId: c.organization_id, connectionId: c.id },
      })),
    );
  return { dispatched: due.length };
};

export const accountingDispatch = inngest.createFunction(
  { id: 'accounting-dispatch' },
  { cron: DISPATCH_CRON },
  async (ctx) => accountingDispatchJob(ctx as unknown as JobContext),
);

export const accountingRunJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  const connectionId = event.data.connectionId as string | undefined;
  if (!organizationId || !connectionId) return { skipped: 'faltan datos en el evento' };
  const db = getOrgScopedClient(organizationId);

  const outcome = await step.run('sync', async () => {
    const conn = await claimAccountingConnection(db, connectionId);
    if (!conn) return { skipped: 'no tocaba, o la tomó otra corrida' as const };
    const name = providerName(conn.provider);
    let result: Awaited<ReturnType<typeof runAccountingSync>>;
    try {
      const session = await openAccountingSession(db, conn.id);
      result = await runAccountingSync(db, conn, {
        session,
        deadline: Date.now() + RUN_BUDGET_MS,
      });
    } catch (err) {
      result = {
        result: {
          status: 'error',
          error: err instanceof Error ? err.message : `No se pudo sincronizar ${name}.`,
        },
        newLabels: {},
        completedInitial: false,
      };
    }
    await markAccountingRun(db, conn, result.result);

    const provider = getAccountingProvider(conn.provider);
    const tables = conn.entities.map(
      (e) => accountingTableSpec(provider ?? { id: conn.provider, name }, e).name,
    );
    const notice =
      result.result.status === 'error'
        ? conn.last_status === 'error'
          ? null
          : {
              title: `No pude traer los datos de ${name}`,
              body: `${result.result.error} Lo vuelvo a intentar solo.`,
            }
        : conn.notify
          ? accountingNoticeFor(name, result, conn.interval_minutes, tables)
          : null;
    if (notice)
      await notify(db, {
        userId: conn.created_by,
        kind: 'table_sync',
        title: notice.title,
        body: notice.body,
        href: result.result.status === 'error' ? '/integrations#programas-contables' : '/trackers',
      }).catch((err) => logger.warn({ err, organizationId }, 'accounting notice failed'));

    return {
      status: result.result.status,
      error: result.result.status === 'error' ? result.result.error : null,
    };
  });

  // Una carga a medias sigue enseguida, sin esperar al próximo barrido.
  if ('status' in outcome && outcome.status === 'partial')
    await step.sendEvent('continue', {
      name: 'accounting/run' as const,
      data: { organizationId, connectionId },
    });
  return outcome;
};

export const accountingRun = inngest.createFunction(
  {
    id: 'accounting-run',
    // Una corrida por conexión a la vez; la toma ya lo garantiza, esto evita
    // que Inngest despierte dos para nada.
    concurrency: [{ key: 'event.data.connectionId', limit: 1 }],
  },
  { event: 'accounting/run' },
  async (ctx) => accountingRunJob(ctx as unknown as JobContext),
);
