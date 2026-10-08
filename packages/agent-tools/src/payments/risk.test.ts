import { describe, expect, it } from 'vitest';
import { OVERDUE_STAGES, dedupePaymentCommitments, overdueStage } from './risk';

describe('los escalones de mora que merecen aviso', () => {
  it('avisa al cruzar cada escalón, no todos los días', () => {
    expect(overdueStage(0)).toBeNull();
    expect(overdueStage(1)).toBe(1);
    expect(overdueStage(29)).toBe(1);
    expect(overdueStage(30)).toBe(30);
    expect(overdueStage(59)).toBe(30);
    expect(overdueStage(60)).toBe(60);
    expect(overdueStage(400)).toBe(90);
  });

  it('los escalones coinciden con el CHECK de la 0159', () => {
    expect([...OVERDUE_STAGES]).toEqual([1, 30, 60, 90]);
  });
});

describe('los pagos comprometidos que suman en plata en riesgo', () => {
  it('el mismo pago extraído dos veces cuenta una sola vez', () => {
    const out = dedupePaymentCommitments([
      { title: 'Pago arriendo oficina', amount_cop: 3_000_000, due_on: '2026-10-05' },
      { title: ' pago  Arriendo oficina ', amount_cop: '3000000', due_on: '2026-10-05' },
      { title: 'Pago arriendo oficina', amount_cop: 3_000_000, due_on: '2026-11-05' },
    ]);
    expect(out.rows).toHaveLength(2);
    expect(out.duplicates).toBe(1);
  });

  it('un valor negativo, cero o ilegible ni suma ni resta', () => {
    const out = dedupePaymentCommitments([
      { title: 'a', amount_cop: -500_000, due_on: '2026-10-05' },
      { title: 'b', amount_cop: 0, due_on: '2026-10-05' },
      { title: 'c', amount_cop: 'abc', due_on: '2026-10-05' },
      { title: 'd', amount_cop: null, due_on: '2026-10-05' },
      { title: 'e', amount_cop: 800_000, due_on: '2026-10-05' },
    ]);
    expect(out.rows).toEqual([{ amount: 800_000, due_on: '2026-10-05' }]);
  });

  it('sin título no se puede asegurar que sea el mismo pago: no se funde', () => {
    const out = dedupePaymentCommitments([
      { amount_cop: 100_000, due_on: '2026-10-05' },
      { amount_cop: 100_000, due_on: '2026-10-05' },
    ]);
    expect(out.rows).toHaveLength(2);
  });
});
