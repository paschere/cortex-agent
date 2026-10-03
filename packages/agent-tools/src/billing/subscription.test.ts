import { describe, expect, it } from 'vitest';
import {
  type BillingSubscription,
  PAST_DUE_DAYS,
  addBillingMonths,
  applyApprovedPayment,
  billingAccess,
  cancelSubscription,
  reminderDue,
  resumeSubscription,
  toBillingSubscription,
  trialSubscription,
} from './subscription';

/**
 * Cada prueba es una frase que el producto dice en voz alta: «sin fila no
 * cambia nada», «la prueba dura 14 días», «al vencer queda en solo lectura y no
 * se borra nada», «pagar durante la prueba no te quita días», «cancelar no corta
 * lo pagado».
 */

const NOW = new Date('2026-10-03T15:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function sub(over: Partial<BillingSubscription> = {}): BillingSubscription {
  return {
    organizationId: 'org-1',
    planCode: 'team',
    status: 'active',
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    provider: 'wompi',
    lastReminderKey: null,
    ...over,
  };
}

describe('billingAccess', () => {
  it('sin fila es legacy y nunca se bloquea', () => {
    const access = billingAccess(null, NOW);
    expect(access).toMatchObject({ status: 'legacy', access: 'full', reason: 'legacy' });
  });

  it('una prueba en curso da acceso completo y cuenta los días hacia arriba', () => {
    const trial = trialSubscription('org-1', 'team', 14, NOW);
    expect(trial.trialEndsAt).toBe(day(14).toISOString());
    const access = billingAccess(trial, NOW);
    expect(access).toMatchObject({ status: 'trialing', access: 'full', daysLeft: 14 });
    // Faltando 2 horas para el fin todavía es «1 día».
    expect(billingAccess(trial, new Date(day(14).getTime() - 7_200_000)).daysLeft).toBe(1);
  });

  it('al vencer la prueba sin pago queda en solo lectura (no se borra nada)', () => {
    const trial = trialSubscription('org-1', 'team', 14, NOW);
    const access = billingAccess(trial, day(14));
    expect(access).toMatchObject({ status: 'grace', access: 'read_only', reason: 'trial_ended' });
  });

  it('un período pagado vigente gana aunque el estado guardado sea viejo', () => {
    const stale = sub({ status: 'grace', currentPeriodEnd: day(10).toISOString() });
    expect(billingAccess(stale, NOW)).toMatchObject({ status: 'active', access: 'full' });
  });

  it('período vencido: margen de mora con todo funcionando, luego solo lectura', () => {
    const lapsed = sub({ currentPeriodEnd: day(-1).toISOString() });
    const pastDue = billingAccess(lapsed, NOW);
    expect(pastDue).toMatchObject({ status: 'past_due', access: 'full', reason: 'past_due' });
    expect(pastDue.daysLeft).toBe(PAST_DUE_DAYS - 1);
    expect(billingAccess(lapsed, day(PAST_DUE_DAYS))).toMatchObject({
      status: 'grace',
      access: 'read_only',
      reason: 'unpaid',
    });
  });

  it('activa sin fechas (acordada por fuera) no se bloquea', () => {
    expect(billingAccess(sub({ provider: 'manual' }), NOW)).toMatchObject({
      access: 'full',
      reason: 'manual',
    });
  });

  it('cancelar no corta lo pagado: sigue hasta el fin y luego solo lectura', () => {
    const paid = sub({ currentPeriodEnd: day(8).toISOString() });
    const canceled = cancelSubscription(paid, NOW);
    expect(billingAccess(canceled, NOW)).toMatchObject({
      status: 'canceled',
      access: 'full',
      reason: 'canceling',
      daysLeft: 8,
    });
    expect(billingAccess(canceled, day(8))).toMatchObject({
      status: 'canceled',
      access: 'read_only',
    });
  });

  it('cancelar una prueba la deja correr hasta su fin', () => {
    const canceled = cancelSubscription(trialSubscription('org-1', 'team', 14, NOW), NOW);
    expect(billingAccess(canceled, day(3))).toMatchObject({ access: 'full', reason: 'canceling' });
    expect(billingAccess(canceled, day(15))).toMatchObject({ access: 'read_only' });
  });

  it('reanudar deshace la cancelación mientras corre lo pagado', () => {
    const canceled = cancelSubscription(sub({ currentPeriodEnd: day(8).toISOString() }), NOW);
    const resumed = resumeSubscription(canceled, NOW);
    expect(resumed.cancelAtPeriodEnd).toBe(false);
    expect(billingAccess(resumed, NOW)).toMatchObject({ status: 'active', reason: 'paid' });
    const trial = resumeSubscription(
      cancelSubscription(trialSubscription('org-1', 'team', 14, NOW), NOW),
      NOW,
    );
    expect(trial.status).toBe('trialing');
  });
});

describe('applyApprovedPayment', () => {
  it('pagar durante la prueba no quita días: el período empieza al final de la prueba', () => {
    const trial = trialSubscription('org-1', 'team', 14, NOW);
    const paid = applyApprovedPayment(trial, {
      organizationId: 'org-1',
      planCode: 'team',
      months: 1,
      provider: 'wompi',
      now: NOW,
    });
    expect(paid.status).toBe('active');
    expect(paid.currentPeriodStart).toBe(day(14).toISOString());
    expect(paid.currentPeriodEnd).toBe(addBillingMonths(day(14), 1).toISOString());
  });

  it('renovar antes de tiempo suma al final del período vigente', () => {
    const active = sub({
      currentPeriodStart: day(-25).toISOString(),
      currentPeriodEnd: day(5).toISOString(),
    });
    const renewed = applyApprovedPayment(active, {
      organizationId: 'org-1',
      planCode: 'team',
      months: 1,
      provider: 'wompi',
      now: NOW,
    });
    expect(renewed.currentPeriodEnd).toBe(addBillingMonths(day(5), 1).toISOString());
  });

  it('pagar estando en solo lectura reactiva desde ahora', () => {
    const lapsed = sub({ status: 'grace', currentPeriodEnd: day(-30).toISOString() });
    const paid = applyApprovedPayment(lapsed, {
      organizationId: 'org-1',
      planCode: 'business',
      months: 1,
      provider: 'wompi',
      now: NOW,
    });
    expect(paid.currentPeriodStart).toBe(NOW.toISOString());
    expect(paid.planCode).toBe('business');
    expect(billingAccess(paid, NOW).access).toBe('full');
  });

  it('cambiar de plan con período vigente empieza ahora (sin prorrateo)', () => {
    const active = sub({ currentPeriodEnd: day(20).toISOString() });
    const changed = applyApprovedPayment(active, {
      organizationId: 'org-1',
      planCode: 'business',
      months: 1,
      provider: 'wompi',
      now: NOW,
    });
    expect(changed.currentPeriodStart).toBe(NOW.toISOString());
  });

  it('pagar quita la cancelación pendiente', () => {
    const canceled = cancelSubscription(sub({ currentPeriodEnd: day(3).toISOString() }), NOW);
    const paid = applyApprovedPayment(canceled, {
      organizationId: 'org-1',
      planCode: 'team',
      months: 1,
      provider: 'wompi',
      now: NOW,
    });
    expect(paid.cancelAtPeriodEnd).toBe(false);
    expect(paid.status).toBe('active');
  });
});

describe('addBillingMonths', () => {
  it('no se salta febrero', () => {
    expect(addBillingMonths(new Date('2026-01-31T12:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T12:00:00.000Z',
    );
    expect(addBillingMonths(new Date('2028-01-31T12:00:00Z'), 1).toISOString()).toBe(
      '2028-02-29T12:00:00.000Z',
    );
    expect(addBillingMonths(new Date('2026-11-15T00:00:00Z'), 2).toISOString()).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });
});

describe('reminderDue', () => {
  it('avisa a 3 y a 1 día del fin de la prueba, una vez cada uno', () => {
    const trial = trialSubscription('org-1', 'team', 14, NOW);
    expect(reminderDue(trial, day(5))).toBeNull();
    const three = reminderDue(trial, day(11));
    expect(three?.kind).toBe('trial_ending');
    const after = { ...trial, lastReminderKey: three?.key ?? null };
    expect(reminderDue(after, day(11.5))).toBeNull();
    const one = reminderDue(after, day(13.2));
    expect(one?.key).not.toBe(three?.key);
    // El de 1 día ya salió: no se retrocede al de 3.
    expect(reminderDue({ ...trial, lastReminderKey: one?.key ?? null }, day(13.5))).toBeNull();
  });

  it('avisa de la renovación, de la mora y de la solo lectura', () => {
    const active = sub({ currentPeriodEnd: day(4).toISOString() });
    expect(reminderDue(active, NOW)?.kind).toBe('renewal_due');
    expect(reminderDue(active, day(5))?.kind).toBe('past_due');
    expect(reminderDue(active, day(4 + PAST_DUE_DAYS + 1))?.kind).toBe('read_only');
  });

  it('sin fila o cancelada y vencida no manda nada', () => {
    expect(reminderDue(null, NOW)).toBeNull();
    const canceled = cancelSubscription(sub({ currentPeriodEnd: day(-1).toISOString() }), NOW);
    expect(reminderDue(canceled, NOW)).toBeNull();
  });
});

describe('toBillingSubscription', () => {
  it('lee la fila y trata un estado desconocido como activo', () => {
    const parsed = toBillingSubscription({
      organization_id: 'o',
      plan_code: 'team',
      status: 'raro',
      trial_ends_at: null,
      current_period_start: null,
      current_period_end: null,
      cancel_at_period_end: null,
      canceled_at: null,
      provider: 'otro',
      last_reminder_key: null,
    });
    expect(parsed.status).toBe('active');
    expect(parsed.provider).toBeNull();
    expect(parsed.cancelAtPeriodEnd).toBe(false);
  });
});
