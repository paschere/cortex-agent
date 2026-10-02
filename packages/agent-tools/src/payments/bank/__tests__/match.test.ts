import { describe, expect, it } from 'vitest';
import {
  type CreditToMatch,
  type MatchClient,
  type MatchInvoice,
  invoiceRefIn,
  matchCredit,
  matchCredits,
  nameScore,
  nitMatches,
  nitsIn,
} from '../match';

/**
 * El emparejador del extracto. Lo que se protege, sobre todo, es la asimetría:
 * confirmar solo SÓLO lo inequívoco (valor exacto + número de factura o NIT, y
 * una sola candidata), y mandar todo lo demás a «por revisar» con sus razones.
 */

function invoice(over: Partial<MatchInvoice> = {}): MatchInvoice {
  return {
    kind: 'document',
    id: 'inv-1',
    docNumber: 'FV-1043',
    clientId: 'cli-coltrans',
    clientName: 'Coltrans S.A.S.',
    nit: '900123456',
    currency: 'COP',
    total: 4_200_000,
    balance: 4_200_000,
    issuedOn: '2026-08-10',
    dueOn: '2026-09-09',
    ...over,
  };
}

function credit(over: Partial<CreditToMatch> = {}): CreditToMatch {
  return {
    amount: 4_200_000,
    currency: 'COP',
    date: '2026-09-05',
    description: 'PAGO PSE',
    ...over,
  };
}

const clients: MatchClient[] = [
  { id: 'cli-coltrans', name: 'Coltrans S.A.S.', nit: '900123456' },
  { id: 'cli-andina', name: 'Distribuidora Andina Ltda', nit: '800555111' },
];

describe('piezas', () => {
  it('el número de la factura, entero o sólo sus cifras', () => {
    expect(invoiceRefIn('PAGO FV-1043 COLTRANS', 'FV-1043')).toBe('full');
    expect(invoiceRefIn('PAGOFV1043', 'FV 1043')).toBe('full');
    expect(invoiceRefIn('PAGO FACTURA 1043', 'FV-1043')).toBe('partial');
    expect(invoiceRefIn('PAGO FACTURA 01043', 'FV-1043')).toBe('partial');
    expect(invoiceRefIn('PAGO 22', 'FV-22')).toBeNull();
    expect(invoiceRefIn('REF 5512 PAGO', '5512')).toBe('full');
    expect(invoiceRefIn('REF 55120 PAGO', '5512')).toBeNull();
    expect(invoiceRefIn('PAGO', null)).toBeNull();
  });

  it('NITs con puntos, con guion, y con o sin dígito de verificación', () => {
    expect(nitsIn('TRANSF 900.123.456-7 COLTRANS')).toContain('9001234567');
    expect(nitsIn('NIT 900123456')).toContain('900123456');
    // 900123456 → DV 8.
    expect(nitMatches('9001234568', '900123456')).toBe(true);
    expect(nitMatches('900123456', '9001234568')).toBe(true);
    expect(nitMatches('9001234561', '900123456')).toBe(false);
    expect(nitMatches('900123456', '900123456')).toBe(true);
    expect(nitMatches('123', '123')).toBe(false);
  });

  it('el nombre, aunque el banco lo recorte', () => {
    expect(nameScore('TRANSF COLTRANS', 'Coltrans S.A.S.')).toBe(1);
    expect(nameScore('PAGO DISTRIB ANDINA', 'Distribuidora Andina Ltda')).toBe(1);
    expect(nameScore('PAGO PSE BANCOLOMBIA', 'Coltrans S.A.S.')).toBe(0);
    expect(nameScore('PAGO DE LA', 'De La Sas')).toBe(0);
  });
});

describe('se confirma solo', () => {
  it('valor exacto + número de factura', () => {
    const m = matchCredit(credit({ description: 'PAGO PSE FV-1043' }), {
      invoices: [invoice(), invoice({ id: 'inv-2', docNumber: 'FV-1044', balance: 900_000 })],
    });
    expect(m.status).toBe('matched');
    expect(m.best?.invoice.id).toBe('inv-1');
    expect(m.reason).toMatch(/exactamente el saldo/);
  });

  it('valor exacto + NIT de quien paga, y deja el cliente identificado', () => {
    const m = matchCredit(credit({ description: 'TRANSF 900.123.456-8' }), {
      invoices: [invoice()],
      clients,
    });
    expect(m.status).toBe('matched');
    expect(m.clientId).toBe('cli-coltrans');
  });

  it('el NIT puede venir en su propia columna', () => {
    const m = matchCredit(credit({ nit: '900123456' }), { invoices: [invoice()], clients });
    expect(m.status).toBe('matched');
  });
});

describe('va a «por revisar»', () => {
  it('valor exacto sin ninguna referencia', () => {
    const m = matchCredit(credit(), { invoices: [invoice()] });
    expect(m.status).toBe('suggested');
    expect(m.suggestions).toHaveLength(1);
  });

  it('dos facturas del mismo cliente por el mismo valor', () => {
    const m = matchCredit(credit({ nit: '900123456' }), {
      invoices: [invoice(), invoice({ id: 'inv-2', docNumber: 'FV-1050' })],
      clients,
    });
    expect(m.status).toBe('suggested');
    expect(m.reason).toMatch(/2 facturas/);
  });

  it('la glosa nombra OTRA factura distinta de la que cuadra por NIT', () => {
    const m = matchCredit(credit({ nit: '900123456', description: 'PAGO FV-1050' }), {
      invoices: [invoice(), invoice({ id: 'inv-2', docNumber: 'FV-1050', balance: 1_000_000 })],
      clients,
    });
    expect(m.status).toBe('suggested');
  });

  it('el pago con retenciones (96 %) y el nombre del cliente', () => {
    const m = matchCredit(credit({ amount: 4_032_000, description: 'TRANSF COLTRANS' }), {
      invoices: [invoice()],
    });
    expect(m.status).toBe('suggested');
    expect(m.best?.amountFit).toBe('retention');
    expect(m.best?.reasons.join(' ')).toMatch(/retenciones/);
    expect(m.best?.reasons.join(' ')).toMatch(/Coltrans/);
  });

  it('el número de la factura con un valor que no cuadra', () => {
    const m = matchCredit(credit({ amount: 1_000_000, description: 'ABONO FV-1043' }), {
      invoices: [invoice()],
    });
    expect(m.status).toBe('suggested');
    expect(m.best?.amountFit).toBe('partial');
  });
});

describe('no se sugiere', () => {
  it('un abono anterior a la factura no la paga', () => {
    const m = matchCredit(credit({ date: '2026-08-01', description: 'FV-1043' }), {
      invoices: [invoice()],
    });
    expect(m.status).toBe('unmatched');
  });

  it('las monedas no se cruzan', () => {
    const m = matchCredit(credit({ currency: 'USD', description: 'FV-1043' }), {
      invoices: [invoice()],
    });
    expect(m.status).toBe('unmatched');
  });

  it('un valor sin ninguna otra señal', () => {
    const m = matchCredit(credit({ amount: 77_000 }), { invoices: [invoice()] });
    expect(m.status).toBe('unmatched');
    expect(m.reason).toMatch(/No encontré/);
  });

  it('un cliente conocido sin factura que cuadre lo dice', () => {
    const m = matchCredit(credit({ amount: 77_000, nit: '800555111' }), {
      invoices: [invoice()],
      clients,
    });
    expect(m.status).toBe('unmatched');
    expect(m.clientId).toBe('cli-andina');
    expect(m.reason).toMatch(/cliente conocido/);
  });
});

describe('el extracto entero', () => {
  it('dos abonos que se confirmarían solos contra la misma factura quedan los dos por revisar', () => {
    const results = matchCredits(
      [credit({ description: 'PAGO FV-1043' }), credit({ description: 'FV-1043 PSE' })],
      { invoices: [invoice()] },
    );
    expect(results.map((r) => r.status)).toEqual(['suggested', 'suggested']);
    expect(results[0]?.reason).toMatch(/misma factura/);
  });

  it('abonos a facturas distintas se confirman cada uno', () => {
    const results = matchCredits(
      [
        credit({ description: 'PAGO FV-1043' }),
        credit({ amount: 900_000, description: 'PAGO FV-1044' }),
      ],
      { invoices: [invoice(), invoice({ id: 'inv-2', docNumber: 'FV-1044', balance: 900_000 })] },
    );
    expect(results.map((r) => [r.status, r.best?.invoice.id])).toEqual([
      ['matched', 'inv-1'],
      ['matched', 'inv-2'],
    ]);
  });
});
