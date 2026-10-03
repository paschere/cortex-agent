/**
 * EL ESTADO COMERCIAL DE UNA EMPRESA: PRUEBA, AL DÍA, EN MORA, SOLO LECTURA.
 *
 * Todo aquí es PURO, como plans.ts: recibe la fila y el reloj y devuelve una
 * decisión. La decisión de dejar a una empresa en solo lectura es la que un
 * cliente va a discutir, así que tiene que poder reproducirse con cuatro fechas
 * en una pantalla. `subscription.test.ts` recorre cada frontera.
 *
 * ===========================================================================
 * SIN FILA, NADA CAMBIA
 * ===========================================================================
 * `billing_subscriptions` (0187) sólo tiene fila para la empresa que empezó una
 * prueba con el registro abierto o que pagó dentro del producto. Las que ya
 * existían (0114: `enterprise`, acordado por fuera) no tienen fila, y
 * `billingAccess(null)` responde `legacy` con acceso completo. No hay ningún
 * camino que convierta «no hay fila» en un bloqueo.
 *
 * ===========================================================================
 * EL ESTADO SE CALCULA CON LAS FECHAS, NO SE ESPERA AL BARRIDO
 * ===========================================================================
 * La columna `status` guarda el último estado ESCRITO. Lo que manda es
 * `billingAccess`, que mira las fechas: una prueba que vence a medianoche queda
 * en solo lectura a medianoche, no cuando pase el barrido diario. El barrido
 * (`billing/renewals`) sólo escribe el estado efectivo para que los listados lo
 * lean sin recalcular, y manda los recordatorios.
 *
 * ===========================================================================
 * SOLO LECTURA NO ES BORRAR
 * ===========================================================================
 * `read_only` detiene lo que Cortex EMPIEZA (respuestas, herramientas, rutinas
 * que pasan por la puerta del medidor). Todo lo que está adentro se sigue
 * leyendo y exportando, y al pagar vuelve todo de inmediato. Nada en este
 * módulo, ni en el barrido, borra una fila.
 */

export const BILLING_STATUSES = ['trialing', 'active', 'past_due', 'grace', 'canceled'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

/** Días con todo funcionando después de vencer un período sin pagar. */
export const PAST_DUE_DAYS = 5;

/** Días de prueba si nadie configuró TRIAL_DAYS. */
export const DEFAULT_TRIAL_DAYS = 14;

const DAY_MS = 86_400_000;

export interface BillingSubscription {
  organizationId: string;
  planCode: string;
  status: BillingStatus;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  provider: 'wompi' | 'manual' | null;
  lastReminderKey: string | null;
}

export type BillingAccessLevel = 'full' | 'read_only';

/** Por qué una empresa está donde está. Una palabra para el código, no para la gente. */
export type BillingReason =
  | 'legacy'
  | 'trial'
  | 'paid'
  | 'manual'
  | 'past_due'
  | 'trial_ended'
  | 'unpaid'
  | 'canceling'
  | 'canceled';

export interface BillingAccess {
  /** `legacy` = sin fila: empresa anterior al cobro, nunca se bloquea. */
  status: BillingStatus | 'legacy';
  access: BillingAccessLevel;
  reason: BillingReason;
  /** Cuándo termina el estado actual (fin de prueba, de período o de margen). */
  endsAt: string | null;
  /** Días completos que faltan para `endsAt`, hacia arriba. null sin fecha. */
  daysLeft: number | null;
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Días que faltan, redondeando hacia arriba: «vence mañana a las 3» es 1. */
export function daysUntil(endIso: string | null, now: Date): number | null {
  const end = ms(endIso);
  if (end === null) return null;
  return Math.max(0, Math.ceil((end - now.getTime()) / DAY_MS));
}

function result(
  status: BillingAccess['status'],
  access: BillingAccessLevel,
  reason: BillingReason,
  endsAt: string | null,
  now: Date,
): BillingAccess {
  return { status, access, reason, endsAt, daysLeft: daysUntil(endsAt, now) };
}

/**
 * Lo que una empresa puede hacer HOY según su fila de cobro.
 *
 * Orden de las preguntas, y por qué:
 *   1. Sin fila → legacy, acceso completo.
 *   2. ¿Hay algo pagado que siga corriendo? Gana siempre: quien pagó durante la
 *      prueba o durante la mora no puede quedar bloqueado por un estado viejo.
 *   3. ¿Prueba en curso? Acceso completo hasta `trial_ends_at`.
 *   4. ¿Cancelada? Al terminar lo pagado (o la prueba), solo lectura.
 *   5. Período vencido: margen de PAST_DUE_DAYS con todo funcionando, después
 *      solo lectura.
 */
export function billingAccess(
  sub: BillingSubscription | null,
  now: Date = new Date(),
  pastDueDays: number = PAST_DUE_DAYS,
): BillingAccess {
  if (!sub) return result('legacy', 'full', 'legacy', null, now);

  const t = now.getTime();
  const periodEnd = ms(sub.currentPeriodEnd);
  const trialEnd = ms(sub.trialEndsAt);
  const canceling = sub.cancelAtPeriodEnd || sub.status === 'canceled';

  if (periodEnd !== null && t < periodEnd) {
    return canceling
      ? result('canceled', 'full', 'canceling', sub.currentPeriodEnd, now)
      : result('active', 'full', 'paid', sub.currentPeriodEnd, now);
  }

  if (sub.status === 'trialing' || (canceling && periodEnd === null && trialEnd !== null)) {
    if (trialEnd !== null && t < trialEnd) {
      return canceling
        ? result('canceled', 'full', 'canceling', sub.trialEndsAt, now)
        : result('trialing', 'full', 'trial', sub.trialEndsAt, now);
    }
    return canceling
      ? result('canceled', 'read_only', 'canceled', null, now)
      : result('grace', 'read_only', 'trial_ended', null, now);
  }

  if (canceling) return result('canceled', 'read_only', 'canceled', null, now);

  if (periodEnd === null) {
    // Activa sin fechas = acordada por fuera (manual). No se le inventa un fin.
    if (sub.status === 'active' || sub.status === 'past_due') {
      return result('active', 'full', 'manual', null, now);
    }
    return result('grace', 'read_only', 'unpaid', null, now);
  }

  const marginEnd = periodEnd + Math.max(0, pastDueDays) * DAY_MS;
  if (t < marginEnd) {
    return result('past_due', 'full', 'past_due', new Date(marginEnd).toISOString(), now);
  }
  return result('grace', 'read_only', 'unpaid', null, now);
}

export function isReadOnly(access: BillingAccess): boolean {
  return access.access === 'read_only';
}

/**
 * Suma meses de calendario sin saltarse el mes corto: 31 de enero + 1 mes es el
 * 28 (o 29) de febrero, no el 3 de marzo. Una factura que se corre tres días
 * cada vez que pasa por febrero termina cobrando un mes de más al año.
 */
export function addBillingMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** La fila de una prueba nueva. */
export function trialSubscription(
  organizationId: string,
  planCode: string,
  trialDays: number,
  now: Date = new Date(),
): BillingSubscription {
  const days = Math.max(1, Math.floor(trialDays));
  return {
    organizationId,
    planCode,
    status: 'trialing',
    trialEndsAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    provider: null,
    lastReminderKey: null,
  };
}

/**
 * Lo que queda después de un pago aprobado.
 *
 * Dónde empieza el período pagado:
 *   - Mismo plan con período vigente → al final de ese período (renovación
 *     anticipada: no se pierde ni un día).
 *   - Pagó durante la prueba → al final de la prueba (no se le cobra por los
 *     días que ya eran gratis).
 *   - Cualquier otro caso, incluido cambiar de plan → ahora. Sin prorrateo: ver
 *     la nota de /plan, que lo dice antes de pagar.
 */
export function applyApprovedPayment(
  sub: BillingSubscription | null,
  input: {
    organizationId: string;
    planCode: string;
    months: number;
    provider: 'wompi' | 'manual';
    now?: Date;
  },
): BillingSubscription {
  const now = input.now ?? new Date();
  const t = now.getTime();
  const periodEnd = ms(sub?.currentPeriodEnd ?? null);
  const trialEnd = ms(sub?.trialEndsAt ?? null);

  let start = t;
  if (sub && sub.planCode === input.planCode && periodEnd !== null && periodEnd > t) {
    start = periodEnd;
  } else if (sub && sub.status === 'trialing' && trialEnd !== null && trialEnd > t) {
    start = trialEnd;
  }
  const startDate = new Date(start);
  return {
    organizationId: input.organizationId,
    planCode: input.planCode,
    status: 'active',
    trialEndsAt: sub?.trialEndsAt ?? null,
    currentPeriodStart:
      sub && sub.planCode === input.planCode && start === periodEnd && sub.currentPeriodStart
        ? sub.currentPeriodStart
        : startDate.toISOString(),
    currentPeriodEnd: addBillingMonths(
      startDate,
      Math.max(1, Math.floor(input.months)),
    ).toISOString(),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    provider: input.provider,
    lastReminderKey: null,
  };
}

/**
 * Cancelar: nunca corta lo pagado. Sigue con todo hasta el final del período (o
 * de la prueba) y después queda en solo lectura, con los datos intactos.
 */
export function cancelSubscription(
  sub: BillingSubscription,
  now: Date = new Date(),
): BillingSubscription {
  return {
    ...sub,
    status: 'canceled',
    cancelAtPeriodEnd: true,
    canceledAt: now.toISOString(),
  };
}

/** Deshacer la cancelación mientras lo pagado sigue corriendo. */
export function resumeSubscription(
  sub: BillingSubscription,
  now: Date = new Date(),
): BillingSubscription {
  const access = billingAccess(sub, now);
  if (access.reason !== 'canceling') return sub;
  const trialRunning = sub.currentPeriodEnd === null && sub.trialEndsAt !== null;
  return {
    ...sub,
    status: trialRunning ? 'trialing' : 'active',
    cancelAtPeriodEnd: false,
    canceledAt: null,
  };
}

/** El estado que el barrido escribe en la columna, a partir del efectivo. */
export function storedStatusFor(access: BillingAccess): BillingStatus | null {
  return access.status === 'legacy' ? null : access.status;
}

/** Días antes del fin de la prueba / del período en que se avisa. */
export const TRIAL_REMINDER_DAYS = [3, 1] as const;
export const RENEWAL_REMINDER_DAYS = [5, 1] as const;

export type ReminderKind = 'trial_ending' | 'renewal_due' | 'past_due' | 'read_only';

/**
 * ¿Toca avisar hoy? Devuelve la llave del aviso (para no repetirlo) o null.
 *
 * La llave lleva la fecha de fin: renovar cambia la fecha, así que el aviso del
 * período siguiente es otra llave y vuelve a salir. Se avisa en el primer
 * umbral alcanzado y no se retrocede: quien no vio el de 3 días no recibe dos
 * correos el mismo día.
 */
export function reminderDue(
  sub: BillingSubscription | null,
  now: Date = new Date(),
): { kind: ReminderKind; key: string; daysLeft: number | null } | null {
  if (!sub) return null;
  const access = billingAccess(sub, now);
  const last = sub.lastReminderKey;
  const pick = (kind: ReminderKind, key: string, daysLeft: number | null) =>
    key === last ? null : { kind, key, daysLeft };

  if (access.reason === 'trial' && access.daysLeft !== null) {
    const threshold = [...TRIAL_REMINDER_DAYS]
      .sort((a, b) => a - b)
      .find((d) => access.daysLeft !== null && access.daysLeft <= d);
    if (threshold === undefined) return null;
    const key = `trial:${sub.trialEndsAt?.slice(0, 10)}:${threshold}`;
    // Ya se mandó uno más cercano (llave de umbral menor): no retroceder.
    if (last?.startsWith(`trial:${sub.trialEndsAt?.slice(0, 10)}:`)) {
      const sent = Number(last.split(':')[2]);
      if (Number.isFinite(sent) && sent <= threshold) return null;
    }
    return pick('trial_ending', key, access.daysLeft);
  }
  if (access.reason === 'paid' && access.daysLeft !== null) {
    const threshold = [...RENEWAL_REMINDER_DAYS]
      .sort((a, b) => a - b)
      .find((d) => access.daysLeft !== null && access.daysLeft <= d);
    if (threshold === undefined) return null;
    const end = sub.currentPeriodEnd?.slice(0, 10);
    if (last?.startsWith(`period:${end}:`)) {
      const sent = Number(last.split(':')[2]);
      if (Number.isFinite(sent) && sent <= threshold) return null;
    }
    return pick('renewal_due', `period:${end}:${threshold}`, access.daysLeft);
  }
  if (access.reason === 'past_due') {
    return pick('past_due', `past_due:${sub.currentPeriodEnd?.slice(0, 10)}`, access.daysLeft);
  }
  if (access.access === 'read_only' && access.reason !== 'canceled') {
    const anchor = (sub.currentPeriodEnd ?? sub.trialEndsAt ?? '').slice(0, 10);
    return pick('read_only', `read_only:${anchor}`, null);
  }
  return null;
}

/** Fila de la base, tal como llega de PostgREST. */
export interface BillingSubscriptionRow {
  organization_id: string;
  plan_code: string;
  status: string;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  canceled_at: string | null;
  provider: string | null;
  last_reminder_key: string | null;
}

export const BILLING_SUBSCRIPTION_COLUMNS =
  'organization_id, plan_code, status, trial_ends_at, current_period_start, current_period_end, cancel_at_period_end, canceled_at, provider, last_reminder_key';

export function toBillingSubscription(row: BillingSubscriptionRow): BillingSubscription {
  const status = (BILLING_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as BillingStatus)
    : 'active';
  return {
    organizationId: row.organization_id,
    planCode: row.plan_code,
    status,
    trialEndsAt: row.trial_ends_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    canceledAt: row.canceled_at,
    provider: row.provider === 'wompi' || row.provider === 'manual' ? row.provider : null,
    lastReminderKey: row.last_reminder_key,
  };
}

export function fromBillingSubscription(sub: BillingSubscription): BillingSubscriptionRow {
  return {
    organization_id: sub.organizationId,
    plan_code: sub.planCode,
    status: sub.status,
    trial_ends_at: sub.trialEndsAt,
    current_period_start: sub.currentPeriodStart,
    current_period_end: sub.currentPeriodEnd,
    cancel_at_period_end: sub.cancelAtPeriodEnd,
    canceled_at: sub.canceledAt,
    provider: sub.provider,
    last_reminder_key: sub.lastReminderKey,
  };
}
