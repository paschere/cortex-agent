/**
 * El vocabulario de pagos que el navegador necesita.
 *
 * Vive aquí y no se importa de `@cortex/agent-tools` por la razón que
 * `lib/clients-shape.ts` deja escrita: ese barril alcanza `node:dns/promises` y
 * rompe el bundle del cliente en cuanto un componente `'use client'` lo toca.
 * Son cuatro mapas de etiquetas; la lógica —el signo, el emparejamiento, la
 * cartera— no está aquí ni debe estarlo.
 *
 * Los tonos siguen la semántica de `lib/status-chip.ts`: ámbar significa "una
 * persona tiene que mirar esto", que es exactamente lo que una disputa es.
 */

import type { StatusTone } from '@/lib/status-chip';

export type PaymentState = 'reported' | 'confirmed' | 'disputed' | 'discarded';
export type PaymentKind = 'payment' | 'reversal' | 'adjustment';

export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  reported: 'Reportado',
  confirmed: 'Confirmado',
  disputed: 'En disputa',
  discarded: 'Descartado',
};

export const PAYMENT_STATE_TONE: Record<PaymentState, StatusTone> = {
  reported: 'primary',
  confirmed: 'emerald',
  disputed: 'amber',
  discarded: 'neutral',
};

export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = {
  payment: 'Abono',
  reversal: 'Anulación',
  adjustment: 'Ajuste',
};

/** Lo que cada estado significa para las cifras, dicho sin rodeos. */
export const PAYMENT_STATE_NOTE: Record<PaymentState, string> = {
  reported: 'Lo dice una fuente. Cuenta en la cartera.',
  confirmed: 'Dos fuentes independientes coinciden. Cuenta, y vale más.',
  disputed: 'Dos fuentes dicen cosas distintas. No está en ninguna cifra.',
  discarded: 'Una persona dijo que no era real. No cuenta.',
};

export const CURRENCIES = ['COP', 'USD', 'EUR'] as const;
