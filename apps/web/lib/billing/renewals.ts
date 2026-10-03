import 'server-only';
import {
  BILLING_SUBSCRIPTION_COLUMNS,
  type BillingSubscriptionRow,
  type ReminderKind,
  billingAccess,
  listPlans,
  reminderDue,
  storedStatusFor,
  toBillingSubscription,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { pool } from '../auth';
import { sendEmail } from '../email';
import { appBaseUrl } from '../email-templates/layout';
import { getOrgScopedClient, getSupabaseServiceClient } from '../supabase/service';
import { workspaceHref } from '../workspace-context';
import { billingDate } from './billing-shape';

/**
 * EL BARRIDO DIARIO DEL COBRO (`billing/renewals`).
 *
 * Wompi no tiene suscripciones: cada mes es un pago nuevo. Así que lo que
 * otras pasarelas hacen solas, aquí lo hace este barrido una vez al día:
 *
 *   1. Escribe el estado EFECTIVO en la columna (`trialing` → `grace` cuando
 *      venció la prueba, `active` → `past_due` → `grace`), para que listados y
 *      consola lo lean sin recalcular. La puerta NO depende de esto: el estado
 *      se calcula con las fechas en cada lectura (subscription.ts).
 *   2. Manda UN recordatorio por umbral a quienes son dueños de la empresa: la
 *      prueba termina en 3 días / 1 día, el plan se renueva en 5 / 1, el pago
 *      está pendiente, el espacio quedó en solo lectura. `last_reminder_key`
 *      impide repetirlo.
 *
 * Nunca borra nada. Sólo empresas con fila de cobro: las anteriores al cobro no
 * tienen fila y no aparecen aquí.
 *
 * LA ÚNICA LECTURA SIN ALCANCE es la lista de empresas con fila de cobro (una
 * columna, `organization_id`); cada empresa se trabaja después con su propio
 * manejador con alcance. Está en tenancy-guard.test.ts con esa razón.
 */

const COPY: Record<
  ReminderKind,
  (input: { planName: string; days: number | null; endsAt: string | null }) => {
    subject: string;
    lead: string;
  }
> = {
  trial_ending: ({ planName, days }) => ({
    subject: `Tu prueba de Cortex termina en ${days === 1 ? '1 día' : `${days} días`}`,
    lead: `La prueba del plan ${planName} termina en ${days === 1 ? '1 día' : `${days} días`}. Si pagas antes, el mes pagado empieza cuando termine la prueba: no pierdes ni un día. Si no, el espacio queda en solo lectura con todos tus datos.`,
  }),
  renewal_due: ({ planName, days, endsAt }) => ({
    subject: `Tu plan ${planName} se renueva en ${days === 1 ? '1 día' : `${days} días`}`,
    lead: `Tu plan ${planName} está pagado hasta el ${billingDate(endsAt)}. Paga el próximo mes desde Plan y consumo (PSE, tarjeta, Nequi o Bancolombia).`,
  }),
  past_due: ({ planName, days }) => ({
    subject: `El pago de tu plan ${planName} está pendiente`,
    lead: `El período del plan ${planName} se venció sin pago. Todo sigue funcionando ${days === 1 ? '1 día' : `${days ?? 0} días`} más; después el espacio queda en solo lectura, con todos los datos.`,
  }),
  read_only: ({ planName }) => ({
    subject: 'Tu espacio de Cortex está en solo lectura',
    lead: `El plan ${planName} no tiene un pago vigente, así que Cortex dejó de empezar trabajo nuevo. Nada se borró: todo se sigue leyendo y exportando, y al pagar vuelve todo de inmediato.`,
  }),
};

async function ownerEmails(organizationId: string): Promise<string[]> {
  const { rows } = await pool.query<{ email: string }>(
    `select u.email from public.ba_member m
       join public.ba_user u on u.id = m."userId"
      where m."organizationId" = $1 and m.role = 'owner'`,
    [organizationId],
  );
  return rows.map((r) => r.email).filter(Boolean);
}

export interface RenewalSweepResult {
  scanned: number;
  statusUpdated: number;
  reminded: number;
  failed: number;
}

export async function runBillingRenewals(now: Date = new Date()): Promise<RenewalSweepResult> {
  const { data, error } = await getSupabaseServiceClient()
    .from('billing_subscriptions')
    .select('organization_id')
    .limit(5000);
  if (error) throw new Error(`billing_subscriptions: ${error.message}`);
  const ids = ((data ?? []) as Array<{ organization_id: string }>).map((r) => r.organization_id);
  const result: RenewalSweepResult = {
    scanned: ids.length,
    statusUpdated: 0,
    reminded: 0,
    failed: 0,
  };

  for (const organizationId of ids) {
    try {
      const db = getOrgScopedClient(organizationId);
      const { data: row, error: readError } = await db
        .from('billing_subscriptions')
        .select(BILLING_SUBSCRIPTION_COLUMNS)
        .maybeSingle();
      if (readError) throw new Error(readError.message);
      if (!row) continue;
      const sub = toBillingSubscription(row as unknown as BillingSubscriptionRow);
      const access = billingAccess(sub, now);
      const effective = storedStatusFor(access);
      const patch: Record<string, unknown> = {};
      if (effective && effective !== sub.status) patch.status = effective;

      const due = reminderDue(sub, now);
      if (due) {
        const owners = await ownerEmails(organizationId);
        const plans = await listPlans(db);
        const planName = plans.find((p) => p.code === sub.planCode)?.name ?? sub.planCode;
        const copy = COPY[due.kind]({
          planName,
          days: due.daysLeft,
          endsAt: access.endsAt ?? sub.currentPeriodEnd,
        });
        const link = `${appBaseUrl()}${workspaceHref(organizationId, '/plan')}`;
        if (owners.length > 0) {
          await sendEmail({
            to: owners,
            subject: copy.subject,
            text: `${copy.lead}\n\nVer el plan y pagar: ${link}\n`,
          });
        }
        patch.last_reminder_key = due.key;
        result.reminded++;
      }

      if (Object.keys(patch).length > 0) {
        patch.updated_at = now.toISOString();
        const { error: writeError } = await db.from('billing_subscriptions').update(patch);
        if (writeError) throw new Error(writeError.message);
        if (patch.status) {
          result.statusUpdated++;
          const legacy =
            access.access === 'read_only'
              ? access.status === 'canceled'
                ? 'canceled'
                : 'past_due'
              : access.status === 'past_due'
                ? 'past_due'
                : 'active';
          const { error: legacyError } = await db
            .from('organization_subscriptions')
            .update({ status: legacy, updated_at: now.toISOString() });
          if (legacyError) throw new Error(legacyError.message);
        }
      }
    } catch (err) {
      result.failed++;
      logger.error('billing: barrido falló para una empresa', {
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info('billing: barrido diario', { ...result });
  return result;
}
