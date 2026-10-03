import {
  type BillingSubscription,
  type BillingSubscriptionRow,
  type Plan,
  applyApprovedPayment,
  billingAccess,
  cancelSubscription,
  fromBillingSubscription,
  listPlans,
  monthlyChargeCop,
  readBillingSubscription,
  readSeatBasis,
  readWorkspacePlan,
  resumeSubscription,
  trialSubscription,
  usagePeriod,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentEvent } from './provider';

/**
 * EL LIBRO DEL COBRO: pagos, avisos y el estado de la empresa.
 *
 * Todo aquí recibe el manejador CON ALCANCE de UNA empresa
 * (`getOrgScopedClient`), así que no puede escribir en otra. La única lectura
 * sin alcance del cobro —«¿de qué empresa es esta referencia?» cuando llega un
 * aviso sin sesión— vive aparte, en `webhook.ts`, y está en la lista de
 * tenancy-guard.test.ts con su razón.
 *
 * Sin `server-only` para poder probarlo contra el PostgREST falso; quien lo usa
 * desde rutas y acciones ya es servidor.
 */

/** Las columnas de un pago que se leen en /plan y al aplicar avisos. */
export const PAYMENT_COLUMNS =
  'id, organization_id, plan_code, reference, amount_cop, currency, seats, months, status, provider, provider_tx_id, payment_method, checkout_url, period_start, period_end, status_note, paid_at, created_at';

export interface PaymentRow {
  id: string;
  organization_id: string;
  plan_code: string;
  reference: string;
  amount_cop: number;
  currency: string;
  seats: number | null;
  months: number;
  status: 'pending' | 'approved' | 'declined' | 'voided' | 'error' | 'expired';
  provider: string;
  provider_tx_id: string | null;
  payment_method: string | null;
  checkout_url: string | null;
  period_start: string | null;
  period_end: string | null;
  status_note: string | null;
  paid_at: string | null;
  created_at: string;
}

/** Referencia única: legible al dictarla por teléfono, imposible de adivinar. */
export function newPaymentReference(random: () => Uint8Array = defaultRandom): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = random();
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  return `CTX-${out.slice(0, 8)}-${out.slice(8)}`;
}

function defaultRandom(): Uint8Array {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Un plan se puede pagar solo si es autoservicio y tiene precio por persona. */
export function isPurchasable(plan: Plan): boolean {
  return plan.selfServe && plan.priceCopPerSeat > 0 && plan.retainerCop == null;
}

/** Escribe la fila de cobro y alinea el plan del cupo (organization_subscriptions). */
export async function writeSubscription(
  db: SupabaseClient,
  sub: BillingSubscription,
  now: Date = new Date(),
): Promise<void> {
  const row: Partial<BillingSubscriptionRow> & { updated_at: string } = {
    ...fromBillingSubscription(sub),
    updated_at: now.toISOString(),
  };
  const { error } = await db
    .from('billing_subscriptions')
    .upsert(row, { onConflict: 'organization_id' });
  if (error) throw new Error(`billing_subscriptions: ${error.message}`);

  // El plan del cupo sigue a lo pagado o probado. El estado de 0085 sólo
  // conoce active / past_due / canceled: se traduce, nunca se inventa.
  const access = billingAccess(sub, now);
  const legacyStatus =
    access.access === 'read_only'
      ? access.status === 'canceled'
        ? 'canceled'
        : 'past_due'
      : access.status === 'past_due'
        ? 'past_due'
        : 'active';
  const { error: planError } = await db
    .from('organization_subscriptions')
    .upsert(
      { plan_code: sub.planCode, status: legacyStatus, updated_at: now.toISOString() },
      { onConflict: 'organization_id' },
    );
  if (planError) throw new Error(`organization_subscriptions: ${planError.message}`);
}

/**
 * La prueba de una empresa nueva. Idempotente: si ya tiene fila de cobro (otra
 * pestaña ganó la carrera, o ya pagó), no toca nada.
 */
export async function startTrial(
  db: SupabaseClient,
  input: { organizationId: string; planCode: string; days: number; now?: Date },
): Promise<{ started: boolean }> {
  const existing = await readBillingSubscription(db);
  if (existing) return { started: false };
  const now = input.now ?? new Date();
  await writeSubscription(
    db,
    trialSubscription(input.organizationId, input.planCode, input.days, now),
    now,
  );
  return { started: true };
}

export async function listPayments(db: SupabaseClient, limit = 24): Promise<PaymentRow[]> {
  const { data, error } = await db
    .from('billing_payments')
    .select(PAYMENT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`billing_payments: ${error.message}`);
  return (data ?? []) as unknown as PaymentRow[];
}

export interface CheckoutQuote {
  plan: Plan;
  seats: number;
  amountCop: number;
}

/** Cuánto cuesta un mes de este plan para esta empresa, con su base de asientos. */
export async function quotePlan(
  db: SupabaseClient,
  planCode: string,
  now: Date = new Date(),
): Promise<CheckoutQuote | null> {
  const plans = await listPlans(db);
  const plan = plans.find((p) => p.code === planCode);
  if (!plan || !isPurchasable(plan)) return null;
  const { contractedSeats } = await readWorkspacePlan(db);
  const seats = await readSeatBasis(db, plan, contractedSeats, usagePeriod(now));
  return { plan, seats: seats.billable, amountCop: monthlyChargeCop(plan, seats) };
}

/** Anota el intento de pago antes de mandar a nadie a la pasarela. */
export async function createPendingPayment(
  db: SupabaseClient,
  input: {
    reference: string;
    quote: CheckoutQuote;
    provider: 'wompi';
    createdBy: string | null;
  },
): Promise<void> {
  const { error } = await db.from('billing_payments').insert({
    reference: input.reference,
    plan_code: input.quote.plan.code,
    amount_cop: input.quote.amountCop,
    currency: 'COP',
    seats: input.quote.seats,
    months: 1,
    status: 'pending',
    provider: input.provider,
    created_by: input.createdBy,
  });
  if (error) throw new Error(`billing_payments: ${error.message}`);
}

export async function attachCheckoutUrl(
  db: SupabaseClient,
  reference: string,
  url: string,
): Promise<void> {
  const { error } = await db
    .from('billing_payments')
    .update({ checkout_url: url, updated_at: new Date().toISOString() })
    .eq('reference', reference);
  if (error) throw new Error(`billing_payments: ${error.message}`);
}

export type EventOutcome =
  | 'duplicate'
  | 'unknown_reference'
  | 'amount_mismatch'
  | 'activated'
  | 'already_approved'
  | 'updated';

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return Boolean(
    error && (error.code === '23505' || /duplicate key|unique/i.test(error.message ?? '')),
  );
}

/**
 * Aplica un aviso de la pasarela a UNA empresa. Idempotente por `eventId`.
 *
 * Reglas, en orden:
 *   1. El aviso se anota primero en `billing_events`; si ya estaba (índice
 *      único), no se hace nada más. Un reintento de Wompi o el regreso del
 *      pagador que llega después del aviso son el mismo hecho.
 *   2. Un pago aprobado nunca retrocede: un DECLINED tardío no lo deshace.
 *   3. Aprobado con monto o moneda distintos a lo anotado → `error`, sin
 *      activar nada. La firma de integridad hace esto casi imposible, pero un
 *      cobro de $1 que activa un mes de Empresa es exactamente lo que nadie
 *      ve hasta la conciliación.
 *   4. Aprobado de verdad → el período se calcula con
 *      `applyApprovedPayment` y se escriben pago, cobro y plan.
 */
export async function applyPaymentEvent(
  db: SupabaseClient,
  organizationId: string,
  event: PaymentEvent,
  provider: 'wompi',
  now: Date = new Date(),
): Promise<EventOutcome> {
  const { data: payment, error: readError } = await db
    .from('billing_payments')
    .select(PAYMENT_COLUMNS)
    .eq('reference', event.reference)
    .maybeSingle();
  if (readError) throw new Error(`billing_payments: ${readError.message}`);
  if (!payment) return 'unknown_reference';
  const row = payment as unknown as PaymentRow;

  const { data: seen, error: seenError } = await db
    .from('billing_events')
    .select('id')
    .eq('provider', provider)
    .eq('event_id', event.eventId)
    .maybeSingle();
  if (seenError) throw new Error(`billing_events: ${seenError.message}`);
  if (seen) return 'duplicate';
  const { error: logError } = await db.from('billing_events').insert({
    provider,
    event_id: event.eventId,
    event_type: event.type,
    payment_id: row.id,
    status: event.status,
    received_at: now.toISOString(),
  });
  if (isUniqueViolation(logError)) return 'duplicate';
  if (logError) throw new Error(`billing_events: ${logError.message}`);

  if (row.status === 'approved') return 'already_approved';

  const base = {
    provider_tx_id: event.providerTxId,
    payment_method: event.paymentMethod,
    raw_event_hash: event.rawHash,
    updated_at: now.toISOString(),
  };

  if (event.status !== 'approved') {
    const { error } = await db
      .from('billing_payments')
      .update({ ...base, status: event.status })
      .eq('id', row.id)
      .neq('status', 'approved');
    if (error) throw new Error(`billing_payments: ${error.message}`);
    return 'updated';
  }

  if (event.currency !== 'COP' || event.amountCents !== row.amount_cop * 100) {
    const { error } = await db
      .from('billing_payments')
      .update({
        ...base,
        status: 'error',
        status_note: `La pasarela aprobó ${event.amountCents / 100} ${event.currency}; se esperaban ${row.amount_cop} COP. No se activó nada.`,
      })
      .eq('id', row.id)
      .neq('status', 'approved');
    if (error) throw new Error(`billing_payments: ${error.message}`);
    return 'amount_mismatch';
  }

  // Marcar aprobado SÓLO si todavía no lo estaba: si dos avisos distintos del
  // mismo pago llegan a la vez, uno solo extiende el período.
  const { data: claimed, error: claimError } = await db
    .from('billing_payments')
    .update({ ...base, status: 'approved', paid_at: now.toISOString() })
    .eq('id', row.id)
    .neq('status', 'approved')
    .select('id');
  if (claimError) throw new Error(`billing_payments: ${claimError.message}`);
  if (!Array.isArray(claimed) || claimed.length === 0) return 'already_approved';

  const current = await readBillingSubscription(db);
  const next = applyApprovedPayment(current, {
    organizationId,
    planCode: row.plan_code,
    months: row.months,
    provider,
    now,
  });
  await writeSubscription(db, next, now);
  const { error: periodError } = await db
    .from('billing_payments')
    .update({ period_start: next.currentPeriodStart, period_end: next.currentPeriodEnd })
    .eq('id', row.id);
  if (periodError) throw new Error(`billing_payments: ${periodError.message}`);
  return 'activated';
}

/** Cancelar al final de lo pagado. Nunca borra ni corta antes. */
export async function cancelBilling(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<BillingSubscription | null> {
  const current = await readBillingSubscription(db);
  if (!current) return null;
  const next = cancelSubscription(current, now);
  await writeSubscription(db, next, now);
  return next;
}

export async function resumeBilling(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<BillingSubscription | null> {
  const current = await readBillingSubscription(db);
  if (!current) return null;
  const next = resumeSubscription(current, now);
  if (next === current) return current;
  await writeSubscription(db, next, now);
  return next;
}
