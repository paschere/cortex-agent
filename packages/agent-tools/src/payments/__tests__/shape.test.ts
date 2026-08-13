import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MissingPaymentSourceError,
  currencyBucket,
  movementsAgree,
  paymentSourceColumns,
  requireCurrency,
  signedAmount,
  sourceIdentity,
  sourceRank,
  weightedAgeDays,
} from '../shape';

const STORE = new URL('../store.ts', import.meta.url);

describe('el signo de un movimiento', () => {
  it('lo pone la clase y no el importe', () => {
    expect(signedAmount('payment', 4_200_000)).toBe(4_200_000);
    expect(signedAmount('adjustment', 1_000)).toBe(1_000);
    expect(signedAmount('reversal', 4_200_000)).toBe(-4_200_000);
  });
});

describe('la moneda', () => {
  it('es obligatoria y no tiene valor por defecto', () => {
    expect(requireCurrency('cop')).toBe('COP');
    expect(() => requireCurrency(null)).toThrow(/moneda/i);
    expect(() => requireCurrency('$')).toThrow(/moneda/i);
    expect(() => requireCurrency('pesos')).toThrow(/moneda/i);
  });

  it('entra en la clave de todo grupo, para que nada se sume entre monedas', () => {
    expect(currencyBucket('coltrans', 'COP')).not.toBe(currencyBucket('coltrans', 'USD'));
    expect(currencyBucket('coltrans', null)).toBe('coltrans#sin-moneda');
  });
});

describe('la procedencia', () => {
  it('exige de cada fuente exactamente lo que la 0098 exige', () => {
    expect(paymentSourceColumns({ kind: 'manual', userId: 'user-ana' }).source_user_id).toBe(
      'user-ana',
    );
    expect(() => paymentSourceColumns({ kind: 'manual', userId: '' })).toThrow(
      MissingPaymentSourceError,
    );
    expect(() => paymentSourceColumns({ kind: 'system', system: 'siigo', readAt: '' })).toThrow(
      MissingPaymentSourceError,
    );
    // Una cita de cinco caracteres no es una cita: el mismo suelo de ocho que
    // pusieron la 0069 y la 0076.
    expect(() =>
      paymentSourceColumns({ kind: 'document', documentId: 'doc-1', quote: 'n/a' }),
    ).toThrow(MissingPaymentSourceError);
  });

  it('cuenta como una sola fuente al mismo sistema hablando dos veces', () => {
    const siigo = { source_kind: 'system', source_user_id: null, source_document_id: null };
    expect(sourceIdentity({ ...siigo, source_system: 'siigo' })).toBe(
      sourceIdentity({ ...siigo, source_system: 'Siigo' }),
    );
    expect(sourceIdentity({ ...siigo, source_system: 'siigo' })).not.toBe(
      sourceIdentity({ ...siigo, source_system: 'bancolombia' }),
    );
  });
});

describe('la jerarquía de fuentes', () => {
  it('ordena banco > sistema contable > comprobante > manual', () => {
    expect(sourceRank('system', 'bancolombia-extracto')).toBeGreaterThan(
      sourceRank('system', 'siigo'),
    );
    expect(sourceRank('system', 'siigo')).toBeGreaterThan(sourceRank('document', null));
    expect(sourceRank('document', null)).toBeGreaterThan(sourceRank('manual', null));
  });

  it('NO APARECE EN NINGUNA ESCRITURA. Ordenar no es decidir.', () => {
    // Este test es el que impide que la regla 3 se pierda dentro de seis meses.
    // En el momento en que el rango entre en el camino de escritura, un extracto
    // que malinterpreta una reversión sobreescribe al contable en silencio, y
    // nadie audita un número que ya parece plausible.
    const store = readFileSync(STORE, 'utf8');
    expect(store).not.toContain('sourceRank(');
  });
});

describe('cuándo dos fuentes hablan del mismo dinero', () => {
  const base = {
    kind: 'payment' as const,
    amount: 4_200_000,
    currency: 'COP',
    paidOn: '2026-07-03',
  };

  it('acepta unos días de diferencia en la fecha', () => {
    expect(movementsAgree(base, { ...base, paidOn: '2026-07-05' })).toBe(true);
    expect(movementsAgree(base, { ...base, paidOn: '2026-07-20' })).toBe(false);
  });

  it('no acepta ninguna en el importe: el dinero se compara al céntimo', () => {
    expect(movementsAgree(base, { ...base, amount: 4_200_000.004 })).toBe(true);
    expect(movementsAgree(base, { ...base, amount: 4_200_001 })).toBe(false);
  });

  it('no cruza monedas ni clases de movimiento', () => {
    expect(movementsAgree(base, { ...base, currency: 'USD' })).toBe(false);
    expect(movementsAgree(base, { ...base, kind: 'reversal' })).toBe(false);
  });
});

describe('la edad de una cartera', () => {
  it('pondera por dinero, no por número de facturas', () => {
    const age = weightedAgeDays(
      [
        { balance: 100_000, since: '2026-08-10' },
        { balance: 900_000, since: '2026-07-14' },
      ],
      '2026-08-13',
    );
    expect(age).toBe(27);
  });

  it('ignora lo que no tiene fecha y lo que ya no debe nada', () => {
    expect(weightedAgeDays([{ balance: 500, since: null }], '2026-08-13')).toBeNull();
    expect(weightedAgeDays([{ balance: 0, since: '2026-01-01' }], '2026-08-13')).toBeNull();
  });
});
