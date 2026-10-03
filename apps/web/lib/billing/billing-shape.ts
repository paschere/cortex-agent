/**
 * Las palabras del cobro, para las pantallas.
 *
 * Copias de los tipos de `@cortex/agent-tools` (billing/subscription.ts) por la
 * misma razón que lib/plan-shape.ts: un componente `'use client'` no puede
 * importar el barril del paquete. Sin directiva y sin imports.
 */

export type BillingStatusView =
  | 'legacy'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'grace'
  | 'canceled';

export interface BillingAccessView {
  status: BillingStatusView;
  access: 'full' | 'read_only';
  reason: string;
  endsAt: string | null;
  daysLeft: number | null;
}

export const BILLING_STATUS_LABEL: Record<BillingStatusView, string> = {
  legacy: 'Acordado contigo',
  trialing: 'En prueba',
  active: 'Al día',
  past_due: 'Pago pendiente',
  grace: 'Solo lectura',
  canceled: 'Cancelado',
};

export const BILLING_STATUS_TONE: Record<
  BillingStatusView,
  'neutral' | 'primary' | 'emerald' | 'amber' | 'rose'
> = {
  legacy: 'neutral',
  trialing: 'primary',
  active: 'emerald',
  past_due: 'amber',
  grace: 'rose',
  canceled: 'amber',
};

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending: 'Sin terminar',
  approved: 'Pagado',
  declined: 'Rechazado',
  voided: 'Anulado',
  error: 'Con error',
  expired: 'Vencido',
};

export const PAYMENT_STATUS_TONE: Record<string, 'neutral' | 'emerald' | 'amber' | 'rose'> = {
  pending: 'neutral',
  approved: 'emerald',
  declined: 'rose',
  voided: 'neutral',
  error: 'rose',
  expired: 'neutral',
};

/** Lo que se le dice al equipo cuando Cortex no empieza trabajo por el cobro. */
export const READ_ONLY_MESSAGE =
  'Tu espacio está en solo lectura: la prueba terminó o el plan está sin pagar. Todo lo que ya está adentro se sigue leyendo y exportando; para que Cortex vuelva a responder y a trabajar, quien administra el espacio puede pagar en Plan y consumo.';

function days(n: number | null): string {
  if (n === null) return '';
  return n === 1 ? '1 día' : `${n} días`;
}

/** Fecha corta en español, fija a Bogotá. */
export function billingDate(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Bogota',
  }).format(new Date(iso));
}

/**
 * La frase de arriba: qué pasa y qué hacer, en una línea. null cuando no hay
 * nada que decir (legacy, al día con más de una semana por delante).
 */
export function billingHeadline(
  view: BillingAccessView,
  planName: string,
): { tone: 'primary' | 'amber' | 'rose'; text: string } | null {
  switch (view.status) {
    case 'trialing':
      return {
        tone: view.daysLeft !== null && view.daysLeft <= 3 ? 'amber' : 'primary',
        text: `Prueba del plan ${planName}: te quedan ${days(view.daysLeft)}. Paga cuando quieras y no pierdes ni un día.`,
      };
    case 'past_due':
      return {
        tone: 'amber',
        text: `El pago del plan ${planName} está pendiente. Todo sigue funcionando ${days(view.daysLeft)} más; después el espacio queda en solo lectura.`,
      };
    case 'grace':
      return { tone: 'rose', text: READ_ONLY_MESSAGE };
    case 'canceled':
      return view.access === 'full'
        ? {
            tone: 'amber',
            text: `Cancelaste el plan ${planName}. Todo funciona hasta el ${billingDate(view.endsAt)}; después queda en solo lectura con todos tus datos.`,
          }
        : { tone: 'rose', text: READ_ONLY_MESSAGE };
    case 'active':
      return view.daysLeft !== null && view.daysLeft <= 5
        ? {
            tone: 'amber',
            text: `Tu plan ${planName} se renueva en ${days(view.daysLeft)}. Paga el próximo mes en Plan y consumo.`,
          }
        : null;
    default:
      return null;
  }
}
