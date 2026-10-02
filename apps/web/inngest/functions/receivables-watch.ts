import { sendEmail } from '@/lib/email';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { notify } from '@/lib/notifications/notify';
import {
  type CrossedInvoice,
  money,
  renderReceivablesNoticeEmail,
} from '@/lib/receivables-notice-email';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  RECOVERY_WINDOW_DAYS,
  bogotaToday,
  claimReceivableNotice,
  emailsFor,
  moneyAtRisk,
  noticeColumn,
  orgAdmins,
  overdueReceivableInvoices,
  overdueStage,
  recordBalanceDrops,
  syncLedger,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * LA CARTERA AVISA SOLA (migración 0159).
 *
 * Cada mañana, por espacio: qué facturas por cobrar confirmadas cruzaron hoy
 * un escalón de mora —vencida, 30, 60, 90 días—, un correo a quienes
 * administran el espacio con esas facturas y el total vencido, y el mismo
 * aviso en la campana. Si ninguna cruzó nada, silencio: el correo diario con
 * la misma lista enseña a no abrirlo.
 *
 * IDEMPOTENCIA. Igual que los vencimientos: el índice único de
 * `receivable_notices` decide, no este código. Se reclama (factura, escalón)
 * ANTES de mandar; si el correo no sale, se sueltan los reclamos para que el
 * día siguiente lo intente otra vez.
 *
 * 07:00 en Bogotá (12:00 UTC, Colombia no cambia de hora): una hora después de
 * los vencimientos, para no llegar pegados, y antes de que empiece el día.
 */

const WATCH_CRON = '0 12 * * *';

function addDaysTo(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const receivablesWatchDispatchJob: JobHandler = async ({ step }) => {
  // Sin alcance, y sólo aquí: «qué espacios tienen cartera» abarca la
  // instalación entera y un cron no tiene sesión. Cada id viaja en su propio
  // evento y todo lo de abajo se lee con el handle de ESE espacio.
  const workspaces = await step.run('find-workspaces', async (): Promise<string[]> => {
    const { data, error } = await getSupabaseServiceClient()
      .from('document_extractions')
      .select('organization_id')
      .eq('review_state', 'confirmed')
      .eq('doc_type', 'invoice')
      .eq('financial_role', 'receivable')
      .limit(20_000);
    if (error) throw error;
    // 0165/0166: también los espacios cuya cartera viene de un programa
    // contable, y los que tuvieron avisos de esas facturas hace poco aunque ya
    // estén pagadas: la caída de saldo a cero es justo la que hay que anotar.
    // 0172: también los espacios con plata en el libro o pagos recientes, para
    // que el libro de plata se ponga al día cada mañana aunque no tengan
    // cartera (un extracto importado, pagos anotados a mano).
    const [accounting, noticed, ledger, reported] = await Promise.all([
      getSupabaseServiceClient()
        .from('accounting_invoices')
        .select('organization_id')
        .gt('balance', 0)
        .eq('annulled', false)
        .limit(20_000),
      getSupabaseServiceClient()
        .from('receivable_notices')
        .select('organization_id')
        .not('accounting_invoice_id', 'is', null)
        .gte('sent_on', addDaysTo(bogotaToday(), -(RECOVERY_WINDOW_DAYS + 1)))
        .limit(20_000),
      getSupabaseServiceClient().from('ledger_accounts').select('organization_id').limit(20_000),
      getSupabaseServiceClient()
        .from('payment_reports')
        .select('organization_id')
        .gte('created_at', `${addDaysTo(bogotaToday(), -35)}T00:00:00Z`)
        .limit(20_000),
    ]);
    if (accounting.error) throw accounting.error;
    if (noticed.error) throw noticed.error;
    if (ledger.error) throw ledger.error;
    if (reported.error) throw reported.error;
    return [
      ...new Set(
        [
          ...((data ?? []) as Array<{ organization_id: string | null }>),
          ...((accounting.data ?? []) as Array<{ organization_id: string | null }>),
          ...((noticed.data ?? []) as Array<{ organization_id: string | null }>),
          ...((ledger.data ?? []) as Array<{ organization_id: string | null }>),
          ...((reported.data ?? []) as Array<{ organization_id: string | null }>),
        ]
          .map((r) => r.organization_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
  });
  if (workspaces.length > 0) {
    await step.sendEvent(
      'watch-per-workspace',
      workspaces.map((organizationId) => ({
        name: 'receivables/watch.workspace' as const,
        data: { organizationId },
      })),
    );
  }
  return { dispatched: workspaces.length };
};

export const receivablesWatchDispatch = inngest.createFunction(
  { id: 'receivables-watch-dispatch' },
  { cron: WATCH_CRON },
  async (ctx) => receivablesWatchDispatchJob(ctx as unknown as JobContext),
);

export const receivablesWatchWorkspaceJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  if (!organizationId) return { skipped: 'no workspace on the event' };
  const today = bogotaToday();

  // 0166: ANTES de reclamar avisos nuevos, anotar cuánto bajó el saldo de las
  // facturas de programa contable ya avisadas (plata recuperada). Su propio
  // paso: si falla, los avisos de hoy salen igual.
  await step.run('record-balance-drops', async () => {
    try {
      return await recordBalanceDrops(getOrgScopedClient(organizationId), { today });
    } catch (err) {
      logger.warn({ err, organizationId }, 'receivable balance drops not recorded');
      return { recorded: 0 };
    }
  });

  // 0172: el libro de plata al día —facturas, pagos, documentos y categorías,
  // con el modelo para lo que ninguna regla reconoce (con tope)—. Su propio
  // paso: si falla, los avisos de hoy salen igual.
  await step.run('sync-ledger', async () => {
    try {
      const result = await syncLedger(getOrgScopedClient(organizationId), organizationId, {
        today,
      });
      return { status: result.status, counts: result.counts, errors: result.errors };
    } catch (err) {
      logger.warn({ err, organizationId }, 'ledger sync failed');
      return { status: 'error' as const };
    }
  });

  return step.run('notice-crossed-invoices', async () => {
    const db = getOrgScopedClient(organizationId);
    const overdue = await overdueReceivableInvoices(db, { today });
    const claimed: Array<{
      invoice: (typeof overdue)[number];
      stage: NonNullable<ReturnType<typeof overdueStage>>;
    }> = [];
    for (const invoice of overdue) {
      const stage = overdueStage(invoice.daysOverdue);
      if (!stage) continue;
      if (
        await claimReceivableNotice(db, {
          invoiceId: invoice.id,
          stage,
          sentOn: today,
          source: invoice.source,
          balance: invoice.balance,
          currency: invoice.currency,
        })
      )
        claimed.push({ invoice, stage });
    }
    if (!claimed.length) return { crossed: 0 };

    const release = async () => {
      for (const c of claimed)
        await db
          .from('receivable_notices')
          .delete()
          .eq(noticeColumn(c.invoice.source), c.invoice.id)
          .eq('stage', c.stage)
          .eq('sent_on', today);
    };

    const admins = await orgAdmins(db);
    if (!admins.length) {
      await release();
      return { crossed: claimed.length, delivered: false, reason: 'sin administradores' };
    }

    const clientIds = [
      ...new Set(claimed.map((c) => c.invoice.clientId).filter(Boolean)),
    ] as string[];
    const names = new Map<string, string>();
    if (clientIds.length) {
      const { data, error } = await db.from('clients').select('id, name').in('id', clientIds);
      if (!error)
        for (const row of (data ?? []) as Array<{ id: string; name: string }>)
          names.set(row.id, row.name);
    }
    const crossed: CrossedInvoice[] = claimed
      .map((c) => ({
        ...c.invoice,
        stage: c.stage,
        clientName: c.invoice.clientId ? (names.get(c.invoice.clientId) ?? null) : null,
      }))
      .sort((a, b) => b.stage - a.stage || b.balance - a.balance);

    const [risk, org, emails] = await Promise.all([
      moneyAtRisk(db, { today }),
      getSupabaseServiceClient()
        .from('ba_organization')
        .select('name')
        .eq('id', organizationId)
        .maybeSingle(),
      emailsFor(db, admins),
    ]);
    const mail = renderReceivablesNoticeEmail({
      organizationName: (org.data as { name?: string } | null)?.name ?? 'tu empresa',
      crossed,
      risk,
    });

    const to = [...emails.values()];
    const outcome = to.length
      ? await sendEmail({ to, subject: mail.subject, text: mail.text, html: mail.html })
      : { sent: false, reason: 'sin correos' };

    // La campana va siempre, haya salido el correo o no: es el otro canal.
    const top = crossed[0];
    for (const userId of admins) {
      await notify(db, {
        userId,
        kind: 'receivables_overdue',
        title:
          crossed.length === 1 && top
            ? `La factura de ${top.clientName ?? top.counterparty ?? 'un cliente'} lleva ${top.daysOverdue} días de mora`
            : `${crossed.length} facturas cruzaron un plazo de mora`,
        body: `Cartera vencida: ${money(risk.cop.receivablesOverdue, 'COP')} en ${risk.cop.overdueInvoices} facturas.`,
        href: '/payments',
        dedupeKey: `receivables:${today}`,
      }).catch((err) => logger.warn({ err, organizationId }, 'receivables notify failed'));
    }

    if (!outcome.sent) {
      await release();
      logger.warn(
        { organizationId, reason: outcome.reason },
        'receivables email not sent; will retry',
      );
    }
    return { crossed: crossed.length, delivered: outcome.sent };
  });
};

export const receivablesWatchWorkspace = inngest.createFunction(
  { id: 'receivables-watch-workspace' },
  { event: 'receivables/watch.workspace' },
  async (ctx) => receivablesWatchWorkspaceJob(ctx as unknown as JobContext),
);
