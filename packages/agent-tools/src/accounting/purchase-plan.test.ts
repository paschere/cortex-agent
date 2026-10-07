import { describe, expect, it } from 'vitest';
import { nextPurchaseCursor, planPurchaseSync } from './purchase-plan';

describe('historial de compras de Siigo', () => {
  const now = new Date('2026-10-06T12:00:00Z');

  it('empieza sin corte de fecha y reanuda después de diez páginas', () => {
    const initial = planPurchaseSync('siigo', undefined, now);
    expect(initial).toEqual({ mode: 'initial', since: '', page: 1 });
    const cursor = nextPurchaseCursor(undefined, initial, 11, now);
    expect(planPurchaseSync('siigo', cursor, new Date('2026-10-07T12:00:00Z'))).toEqual({
      mode: 'initial',
      since: '',
      page: 11,
    });
    expect(nextPurchaseCursor(cursor, cursor.resume ?? initial, null, now)).toMatchObject({
      since: now.toISOString(),
      full_at: now.toISOString(),
    });
  });

  it('revisa cambios recientes y repasa todo el historial al mes', () => {
    const previous = { since: '2026-10-01T00:00:00Z', full_at: '2026-10-01T00:00:00Z' };
    expect(planPurchaseSync('siigo', previous, now)).toEqual({
      mode: 'rolling',
      since: '2026-07-08',
      page: 1,
    });
    expect(planPurchaseSync('siigo', previous, new Date('2026-11-01T12:00:00Z'))).toEqual({
      mode: 'sweep',
      since: '',
      page: 1,
    });
    expect(planPurchaseSync('alegra', undefined, now).mode).toBe('rolling');
  });
});
