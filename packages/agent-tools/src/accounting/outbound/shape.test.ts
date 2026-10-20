import { describe, expect, it } from 'vitest';
import {
  type OpenInvoice,
  allocatePayment,
  buildCustomerPayload,
  creditNoteProblems,
  customerProblems,
  findCity,
  guessPersonType,
  outboxIdempotencyKey,
  receiptProblems,
  resolveTaxId,
  sameNit,
  splitPersonName,
} from './shape';

describe('NIT y dígito de verificación', () => {
  it('calcula el DV de NIT conocidos (el de la DIAN y uno calculado a mano)', () => {
    expect(resolveTaxId('800197268')).toMatchObject({ digits: '800197268', dv: '4' });
    expect(resolveTaxId('830.025.281')).toMatchObject({ digits: '830025281', dv: '2', formatted: '830.025.281-2' });
  });
  it('acepta el NIT con su DV y lo separa', () => {
    expect(resolveTaxId('800.197.268-4')).toMatchObject({ digits: '800197268', dv: '4' });
  });
  it('un DV que no cuadra se rechaza con un mensaje en español', () => {
    const r = resolveTaxId('800.197.268-9');
    expect('error' in r && r.error).toMatch(/no cuadra/);
  });
  it('algo que no es un NIT', () => {
    expect('error' in resolveTaxId('abc')).toBe(true);
    expect('error' in resolveTaxId('12')).toBe(true);
  });
  it('empresa o persona por el número', () => {
    expect(guessPersonType('900123456')).toBe('Company');
    expect(guessPersonType('800197268')).toBe('Company');
    expect(guessPersonType('79123456')).toBe('Person');
  });
  it('sameNit con y sin dígito de verificación', () => {
    expect(sameNit('800197268', '8001972684')).toBe(true);
    expect(sameNit('800197268', '8001972685')).toBe(false);
    expect(sameNit('800197268', '800197268')).toBe(true);
    expect(sameNit('', '1')).toBe(false);
  });
});

describe('ciudades', () => {
  it('por nombre con y sin tilde, y por código DANE', () => {
    expect(findCity('Bogotá')).toMatchObject({ stateCode: '11', cityCode: '11001' });
    expect(findCity('bogota d.c.')).toMatchObject({ cityCode: '11001' });
    expect(findCity('Medellín, Antioquia')).toMatchObject({ stateCode: '05', cityCode: '05001' });
    expect(findCity('76001')).toMatchObject({ name: 'Cali', stateCode: '76' });
  });
  it('una ciudad desconocida no se inventa', () => {
    expect(findCity('Villa Imaginaria')).toBeNull();
    expect(findCity('')).toBeNull();
  });
});

describe('cliente', () => {
  it('empresa: NIT con DV calculado, razón social como una sola cadena', () => {
    const { payload, problems } = buildCustomerPayload({
      taxId: '900.123.456',
      name: '  Avianca   Cargo SAS ',
      email: 'Pagos@Avianca.com',
      phone: '(601) 555-1234',
      address: 'Calle 26 # 59-15',
      city: 'Bogotá',
      regime: 'responsable_iva',
    });
    expect(problems).toEqual([]);
    expect(payload).toMatchObject({
      taxId: '900123456',
      idType: '31',
      personType: 'Company',
      name: 'Avianca Cargo SAS',
      email: 'pagos@avianca.com',
      phone: '6015551234',
      vatResponsible: true,
    });
    expect(payload?.dv).toMatch(/^\d$/);
    expect(customerProblems(payload as NonNullable<typeof payload>)).toEqual([]);
  });
  it('persona: cédula sin DV', () => {
    const { payload } = buildCustomerPayload({ taxId: '79123456', name: 'Marcos Castillo' });
    expect(payload).toMatchObject({ idType: '13', personType: 'Person', dv: null });
  });
  it('forzar el tipo de persona', () => {
    const { payload } = buildCustomerPayload({ taxId: '79123456', name: 'Taller', personType: 'company' });
    expect(payload).toMatchObject({ personType: 'Company', idType: '31' });
  });
  it('NIT inválido: no hay borrador', () => {
    const r = buildCustomerPayload({ taxId: 'xx', name: 'A' });
    expect(r.payload).toBeNull();
    expect(r.problems[0]).toMatch(/NIT/);
  });
  it('lo que falta se ve antes de aprobar', () => {
    const { payload, problems } = buildCustomerPayload({ taxId: '900123456', name: 'X', email: 'mal', city: 'Nowhere' });
    expect(problems.join(' ')).toMatch(/correo/);
    expect(problems.join(' ')).toMatch(/ciudad/);
    expect(customerProblems(payload as NonNullable<typeof payload>).join(' ')).toMatch(/dirección.*ciudad.*teléfono/s);
  });
  it('separa nombres y apellidos de una persona', () => {
    expect(splitPersonName('Marcos')).toEqual(['Marcos']);
    expect(splitPersonName('Marcos Castillo')).toEqual(['Marcos', 'Castillo']);
    expect(splitPersonName('Ana María Pérez')).toEqual(['Ana', 'María Pérez']);
    expect(splitPersonName('Ana María Pérez Gómez')).toEqual(['Ana María', 'Pérez Gómez']);
  });
});

const inv = (number: string, balance: number, dueOn: string | null, issuedOn: string | null = '2026-09-01'): OpenInvoice => ({
  number,
  externalId: `id-${number}`,
  balance,
  dueOn,
  issuedOn,
});

describe('cruzar un pago contra facturas', () => {
  it('la que vence primero primero, sin pasarse del saldo', () => {
    const r = allocatePayment(1_500_000, [
      inv('FV-1-70', 1_000_000, '2026-10-30'),
      inv('FV-1-68', 700_000, '2026-10-01'),
      inv('FV-1-69', 400_000, '2026-10-15'),
    ]);
    expect(r.applications.map((a) => [a.invoiceNumber, a.amount])).toEqual([
      ['FV-1-68', 700_000],
      ['FV-1-69', 400_000],
      ['FV-1-70', 400_000],
    ]);
    expect(r.unapplied).toBe(0);
  });
  it('lo que sobra queda sin aplicar (anticipo)', () => {
    const r = allocatePayment(2_000_000, [inv('FV-1-1', 500_000, '2026-10-01')]);
    expect(r.applications).toHaveLength(1);
    expect(r.unapplied).toBe(1_500_000);
  });
  it('un pago menor que la primera factura la abona parcialmente', () => {
    const r = allocatePayment(100_000, [inv('FV-1-1', 500_000, '2026-10-01'), inv('FV-1-2', 500_000, '2026-10-02')]);
    expect(r.applications).toEqual([
      { invoiceNumber: 'FV-1-1', invoiceExternalId: 'id-FV-1-1', invoiceDate: '2026-09-01', amount: 100_000 },
    ]);
  });
  it('ignora facturas sin saldo y es estable en empates', () => {
    const r = allocatePayment(300, [
      inv('FV-1-10', 0, '2026-01-01'),
      inv('FV-1-9', 200, '2026-10-01', '2026-09-02'),
      inv('FV-1-8', 200, '2026-10-01', '2026-09-02'),
    ]);
    expect(r.applications.map((a) => a.invoiceNumber)).toEqual(['FV-1-8', 'FV-1-9']);
    expect(r.applications.reduce((s, a) => s + a.amount, 0)).toBe(300);
  });
  it('redondea a centavos y no pierde plata', () => {
    const r = allocatePayment(100.1, [inv('A-1-1', 33.34, '2026-10-01'), inv('A-1-2', 66.77, '2026-10-02')]);
    expect(r.applications.reduce((s, a) => s + a.amount, 0) + r.unapplied).toBeCloseTo(100.1, 2);
  });
  it('sin facturas con saldo: sin aplicaciones', () => {
    expect(allocatePayment(10, []).applications).toEqual([]);
  });
});

describe('problemas de recibo y nota crédito', () => {
  const base = {
    customerTaxId: '900123456',
    customerName: 'A',
    date: '2026-10-19',
    amount: 100,
    applications: [{ invoiceNumber: 'FV-1-1', invoiceExternalId: 'x', invoiceDate: null, amount: 100 }],
    bankAccount: null,
    reference: null,
  };
  it('un recibo completo no tiene problemas', () => expect(receiptProblems(base)).toEqual([]));
  it('sin facturas, valor cero, fecha mala, descuadre', () => {
    expect(receiptProblems({ ...base, applications: [] }).join(' ')).toMatch(/No hay facturas/);
    expect(receiptProblems({ ...base, amount: 0 }).join(' ')).toMatch(/cero/);
    expect(receiptProblems({ ...base, date: 'hoy' }).join(' ')).toMatch(/fecha/);
    expect(receiptProblems({ ...base, amount: 150 }).join(' ')).toMatch(/no coinciden/);
  });
  it('nota crédito', () => {
    const note = { invoiceNumber: 'FV-1-1', invoiceExternalId: null, customerTaxId: null, date: '2026-10-19', reason: 2 as const, observations: '', mode: 'total' as const, items: [] };
    expect(creditNoteProblems(note)).toEqual([]);
    expect(creditNoteProblems({ ...note, invoiceNumber: '' }).join(' ')).toMatch(/factura/);
    expect(creditNoteProblems({ ...note, mode: 'items' }).join(' ')).toMatch(/al menos una línea/);
    expect(
      creditNoteProblems({ ...note, mode: 'items', items: [{ description: 'x', productCode: null, quantity: 0, unitPrice: 5, taxRate: 'iva_19' }] }).join(' '),
    ).toMatch(/código.*cantidad/s);
  });
});

describe('llave de idempotencia', () => {
  it('estable, distinta por borrador y apta para Siigo (alfanumérica, ≤ 30)', () => {
    const a = outboxIdempotencyKey('org', 'receipt', 'd1');
    expect(a).toBe(outboxIdempotencyKey('org', 'receipt', 'd1'));
    expect(a).not.toBe(outboxIdempotencyKey('org', 'receipt', 'd2'));
    expect(a).not.toBe(outboxIdempotencyKey('org', 'credit_note', 'd1'));
    expect(a).toMatch(/^[A-Za-z0-9]{1,30}$/);
  });
});
