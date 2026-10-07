import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { notify } from '@/lib/notifications/notify';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type PurchaseCursor,
  accountingNoticeFor,
  accountingTableSpec,
  bogotaToday,
  claimAccountingConnection,
  getAccountingProvider,
  importAccountingProducts,
  importAccountingPurchases,
  markAccountingRun,
  nextPurchaseCursor,
  openAccountingSession,
  planPurchaseSync,
  providerName,
  runAccountingSync,
  syncLedger,
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
        // 0183: los productos también entran al inventario, con existencias.
        importProducts: importAccountingProducts,
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

  // 0172: lo que acaba de llegar del programa (facturas, recibos) entra al
  // libro de plata en la misma corrida. Su propio paso: si falla, la
  // sincronización del programa ya quedó y el libro se pone al día mañana.
  if ('status' in outcome && outcome.status !== 'error')
    await step.run('sync-ledger', async () => {
      try {
        const result = await syncLedger(db, organizationId, { deadline: Date.now() + 2 * 60_000 });
        return { status: result.status, counts: result.counts };
      } catch (err) {
        logger.warn({ err, organizationId }, 'ledger sync after accounting failed');
        return { status: 'error' as const };
      }
    });

  // 0181: las compras (facturas de proveedor) que el programa expone entran a
  // cuentas por pagar, con dedupe contra las que llegaron por correo o por la
  // Bandeja. Siigo carga todo el historial en páginas reanudables; los otros
  // programas conservan la ventana móvil de 90 días. Sólo lectura.
  let purchasesPartial = false;
  if ('status' in outcome && outcome.status !== 'error')
    purchasesPartial = await step.run('supplier-invoices', async () => {
      try {
        const { data: conn, error } = await db
          .from('accounting_connections')
          .select('provider, cursors')
          .eq('id', connectionId)
          .maybeSingle();
        if (error) throw error;
        const system = (conn as { provider?: string } | null)?.provider;
        if (!system) return false;
        const session = await openAccountingSession(db, connectionId);
        if (!session.listPurchases) return false;
        const today = bogotaToday();
        const cursors = ((conn as { cursors?: Record<string, unknown> }).cursors ?? {}) as Record<
          string,
          unknown
        > & { purchases?: PurchaseCursor };
        const previous = cursors.purchases;
        const provider = getAccountingProvider(system);
        if (!provider) return false;
        const plan = planPurchaseSync(provider.id, previous, new Date());
        const firstPage = plan.page;
        let page = firstPage;
        let hasMore = false;
        let seen = 0;
        let created = 0;
        let paid = 0;
        let importErrors = 0;
        for (; page < firstPage + 10; page++) {
          const r = await session.listPurchases(plan.since, page);
          seen += r.records.length;
          const imported = await importAccountingPurchases(db, r.records, { system, today });
          created += imported.created;
          paid += imported.paid;
          importErrors += imported.errors.length;
          if (imported.errors.length > 0)
            throw new Error(`${imported.errors.length} compra(s) no se pudieron guardar.`);
          hasMore = r.hasMore;
          if (!hasMore) break;
        }
        const partial = hasMore;
        const nextPurchaseState = nextPurchaseCursor(
          previous,
          plan,
          partial ? page : null,
          new Date(),
        );
        const { error: updateError } = await db
          .from('accounting_connections')
          .update({
            cursors: { ...cursors, purchases: nextPurchaseState },
            ...(partial ? { last_status: 'partial', next_run_at: new Date().toISOString() } : {}),
          })
          .eq('id', connectionId);
        if (updateError) throw updateError;
        logger.info(
          { organizationId, system, mode: plan.mode, seen, created, paid, importErrors, partial },
          'accounting purchases synced',
        );
        return partial;
      } catch (err) {
        logger.warn({ err, organizationId }, 'accounting purchases into payables failed');
        await db
          .from('accounting_connections')
          .update({
            last_status: 'error',
            last_error:
              err instanceof Error
                ? `No pude traer las compras: ${err.message}`.slice(0, 500)
                : 'No pude traer las compras.',
          })
          .eq('id', connectionId);
        return false;
      }
    });

  // 0179: lo que llegó (clientes, facturas, recibos) se cuelga de cada
  // cliente en su propio trabajo, y si falta un cliente se crea desde aquí.
  if ('status' in outcome && outcome.status === 'ok')
    await step.sendEvent('link-clients', {
      name: 'clients/link-workspace' as const,
      data: { organizationId },
    });

  // Una carga a medias sigue enseguida, sin esperar al próximo barrido.
  if ('status' in outcome && outcome.status === 'partial')
    await step.sendEvent('continue', {
      name: 'accounting/run' as const,
      data: { organizationId, connectionId },
    });
  else if (purchasesPartial)
    await step.sendEvent('continue-purchases', {
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
