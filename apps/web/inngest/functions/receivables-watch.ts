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
  bogotaToday,
  claimReceivableNotice,
  emailsFor,
  moneyAtRisk,
  orgAdmins,
  overdueReceivableInvoices,
  overdueStage,
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
    return [
      ...new Set(
        ((data ?? []) as Array<{ organization_id: string | null }>)
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
      if (await claimReceivableNotice(db, { invoiceId: invoice.id, stage, sentOn: today }))
        claimed.push({ invoice, stage });
    }
    if (!claimed.length) return { crossed: 0 };

    const release = async () => {
      for (const c of claimed)
        await db
          .from('receivable_notices')
          .delete()
          .eq('extraction_id', c.invoice.id)
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
