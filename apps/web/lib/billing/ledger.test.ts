import { billingAccess, createOrgScopedClient, toBillingSubscription } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  type Tables,
  createFakeSupabase,
} from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import {
  applyPaymentEvent,
  cancelBilling,
  newPaymentReference,
  startTrial,
  writeSubscription,
} from './ledger';
import type { PaymentEvent } from './provider';

/**
 * El libro del cobro contra el PostgREST falso, con DOS empresas: un aviso de
 * la referencia de Acme nunca toca a Globex, el mismo aviso dos veces activa
 * un solo mes, y un monto distinto no activa nada.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';
const NOW = new Date('2026-10-03T15:00:00Z');

function tables(): Tables {
  return {
    organization_subscriptions: [
      { organization_id: ACME, plan_code: 'enterprise', status: 'active' },
      { organization_id: GLOBEX, plan_code: 'enterprise', status: 'active' },
    ],
    billing_subscriptions: [],
    billing_events: [],
    billing_payments: [
      {
        id: 'pay-acme',
        organization_id: ACME,
        plan_code: 'team',
        reference: 'CTX-ACME-1',
        amount_cop: 150000,
        currency: 'COP',
        seats: 5,
        months: 1,
        status: 'pending',
        provider: 'wompi',
        created_at: NOW.toISOString(),
      },
    ],
  };
}

function event(over: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    eventId: 'event:abc',
    type: 'transaction.updated',
    reference: 'CTX-ACME-1',
    providerTxId: 'tx-1',
    status: 'approved',
    amountCents: 15_000_000,
    currency: 'COP',
    paymentMethod: 'PSE',
    environment: 'test',
    rawHash: 'h',
    ...over,
  };
}

function sub(t: Tables, org: string) {
  const row = (t.billing_subscriptions ?? []).find((r) => r.organization_id === org);
  return row ? toBillingSubscription(row as never) : null;
}

describe('applyPaymentEvent', () => {
  it('activa un mes, cambia el plan del cupo y no toca a la otra empresa', async () => {
    const t = tables();
    const { client } = createFakeSupabase(t);
    const db = createOrgScopedClient(client, ACME);
    expect(await applyPaymentEvent(db, ACME, event(), 'wompi', NOW)).toBe('activated');

    const acme = sub(t, ACME);
    expect(acme?.status).toBe('active');
    expect(acme?.planCode).toBe('team');
    expect(billingAccess(acme, NOW).access).toBe('full');
    expect(t.organization_subscriptions?.find((r) => r.organization_id === ACME)?.plan_code).toBe(
      'team',
    );
    expect(sub(t, GLOBEX)).toBeNull();
    expect(t.organization_subscriptions?.find((r) => r.organization_id === GLOBEX)?.plan_code).toBe(
      'enterprise',
    );
    const paid = t.billing_payments?.[0];
    expect(paid?.status).toBe('approved');
    expect(paid?.provider_tx_id).toBe('tx-1');
    expect(paid?.period_end).toBe(acme?.currentPeriodEnd);
  });

  it('el mismo aviso dos veces activa un solo mes', async () => {
    const t = tables();
    const db = createOrgScopedClient(createFakeSupabase(t).client, ACME);
    await applyPaymentEvent(db, ACME, event(), 'wompi', NOW);
    const firstEnd = sub(t, ACME)?.currentPeriodEnd;
    expect(await applyPaymentEvent(db, ACME, event(), 'wompi', NOW)).toBe('duplicate');
    // Otro aviso del mismo pago (p. ej. el regreso del pagador) tampoco suma.
    expect(
      await applyPaymentEvent(db, ACME, event({ eventId: 'tx:tx-1:APPROVED' }), 'wompi', NOW),
    ).toBe('already_approved');
    expect(sub(t, ACME)?.currentPeriodEnd).toBe(firstEnd);
    expect(t.billing_events).toHaveLength(2);
  });

  it('un monto distinto no activa nada', async () => {
    const t = tables();
    const db = createOrgScopedClient(createFakeSupabase(t).client, ACME);
    expect(await applyPaymentEvent(db, ACME, event({ amountCents: 100 }), 'wompi', NOW)).toBe(
      'amount_mismatch',
    );
    expect(sub(t, ACME)).toBeNull();
    expect(t.billing_payments?.[0]?.status).toBe('error');
  });

  it('un rechazo tardío no deshace un pago aprobado', async () => {
    const t = tables();
    const db = createOrgScopedClient(createFakeSupabase(t).client, ACME);
    await applyPaymentEvent(db, ACME, event(), 'wompi', NOW);
    await applyPaymentEvent(
      db,
      ACME,
      event({ eventId: 'event:late', status: 'declined' }),
      'wompi',
      NOW,
    );
    expect(t.billing_payments?.[0]?.status).toBe('approved');
  });

  it('una referencia de otra empresa es desconocida para esta', async () => {
    const t = tables();
    const db = createOrgScopedClient(createFakeSupabase(t).client, GLOBEX);
    expect(await applyPaymentEvent(db, GLOBEX, event(), 'wompi', NOW)).toBe('unknown_reference');
    expect(t.billing_payments?.[0]?.status).toBe('pending');
  });
});

describe('prueba y cancelación', () => {
  it('startTrial es idempotente y pone el plan de la prueba en el cupo', async () => {
    const t = tables();
    const db = createOrgScopedClient(createFakeSupabase(t).client, ACME);
    expect(
      await startTrial(db, { organizationId: ACME, planCode: 'business', days: 14, now: NOW }),
    ).toEqual({ started: true });
    expect(
      await startTrial(db, { organizationId: ACME, planCode: 'team', days: 14, now: NOW }),
    ).toEqual({ started: false });
    expect(sub(t, ACME)?.status).toBe('trialing');
    expect(t.organization_subscriptions?.find((r) => r.organization_id === ACME)?.plan_code).toBe(
      'business',
    );
  });

  it('una prueba vencida deja el estado viejo en past_due, nunca borra', async () => {
    const t = tables();
    const db = createOrgScopedClient(createFakeSupabase(t).client, ACME);
    await startTrial(db, { organizationId: ACME, planCode: 'team', days: 1, now: NOW });
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    const current = sub(t, ACME);
    if (!current) throw new Error('sin fila');
    await writeSubscription(db, { ...current, status: 'grace' }, later);
    expect(t.organization_subscriptions?.find((r) => r.organization_id === ACME)?.status).toBe(
      'past_due',
    );
    expect(t.billing_payments).toHaveLength(1);
  });

  it('cancelar sin fila no hace nada', async () => {
    const t = tables();
    const db = createOrgScopedClient(createFakeSupabase(t).client, GLOBEX);
    expect(await cancelBilling(db, NOW)).toBeNull();
  });
});

describe('newPaymentReference', () => {
  it('tiene forma fija y no se repite', () => {
    const a = newPaymentReference();
    const b = newPaymentReference();
    expect(a).toMatch(/^CTX-[A-Z2-9]{8}-[A-Z2-9]{8}$/);
    expect(a).not.toBe(b);
  });
});
