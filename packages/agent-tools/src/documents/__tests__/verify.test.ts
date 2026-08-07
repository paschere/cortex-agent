import { describe, expect, it } from 'vitest';
import {
  canonicalFrom,
  numbersIn,
  quoteSupportsAmount,
  quoteSupportsNit,
  readCurrency,
  verifyClassification,
  verifyFields,
} from '../verify';

/**
 * THE GATE, WITHOUT A MODEL AND WITHOUT A DATABASE.
 *
 * Every assertion here is about something being REFUSED. That is the shape of
 * the module: the model proposes, and this file is the part that disposes. A
 * test suite for an extractor that only checked what it accepts would pass
 * happily on an extractor that accepts everything.
 */

const TODAY = '2026-08-06';

const INVOICE_CHUNKS = [
  {
    id: 'chunk-1',
    chunk_index: 0,
    content: [
      'FACTURA ELECTRÓNICA DE VENTA No. FE-4471',
      'Emisor: COLTRANS S.A.S. NIT 900.123.456-8',
      'Fecha de expedición: 15 de julio de 2026',
      'Subtotal: $1.260.504',
      'IVA (19%): $239.496',
      'TOTAL A PAGAR: $1.500.000 M/CTE',
    ].join('\n'),
  },
];

const CONTRACT_CHUNKS = [
  {
    id: 'chunk-c',
    chunk_index: 0,
    content: [
      'CONTRATO DE PRESTACIÓN DE SERVICIOS No. 2026-118',
      'Entre las partes: SERVIENTREGA S.A., NIT 860.512.330-3',
      'El presente contrato se firma el 1 de enero de 2026 y tendrá una vigencia de doce meses.',
    ].join('\n'),
  },
];

describe('a field with no usable citation', () => {
  it('is refused when the quote is too short to check', () => {
    const { accepted, rejected } = verifyFields(
      [{ fieldKey: 'invoice_number', text: 'FE-4471', quote: 'FE-4471' }],
      INVOICE_CHUNKS,
      'invoice',
      TODAY,
    );
    expect(accepted).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/demasiado corta/);
  });

  it('is refused when the quote is not in the document, however plausible', () => {
    const { accepted, rejected } = verifyFields(
      [
        {
          fieldKey: 'total',
          number: 1_500_000,
          // A perfectly reasonable sentence. It is not on the page.
          quote: 'El valor total de la factura asciende a $1.500.000 pesos.',
        },
      ],
      INVOICE_CHUNKS,
      'invoice',
      TODAY,
    );
    expect(accepted).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/no aparece textualmente/);
  });
});

describe('an amount that was calculated rather than read', () => {
  it('is refused even when the arithmetic is right', () => {
    // 1.260.504 + 239.496 = 1.500.000 exactly. The subtotal line does not
    // vouch for the total, and this is the single most likely way a wrong
    // figure would enter the ledger looking correct.
    const { accepted, rejected } = verifyFields(
      [{ fieldKey: 'total', number: 1_500_000, quote: 'Subtotal: $1.260.504' }],
      INVOICE_CHUNKS,
      'invoice',
      TODAY,
    );
    expect(accepted).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/calculado, no leído/);
  });

  it('is accepted when the digits really are on the page, Colombian formatting and all', () => {
    const { accepted } = verifyFields(
      [{ fieldKey: 'total', number: 1_500_000, quote: 'TOTAL A PAGAR: $1.500.000 M/CTE' }],
      INVOICE_CHUNKS,
      'invoice',
      TODAY,
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.valueNumber).toBe(1_500_000);
    // "M/CTE" is a currency, written by a person, on that line.
    expect(accepted[0]?.currency).toBe('COP');
  });

  it('reads both separator conventions, because documents use both', () => {
    expect(numbersIn('total 1.500.000,50')).toContain(1_500_000.5);
    expect(numbersIn('total 1,500,000.50')).toContain(1_500_000.5);
    expect(quoteSupportsAmount('valor declarado 12.345,67 COP', 12_345.67)).toBe(true);
    expect(quoteSupportsAmount('valor declarado 12.345,67 COP', 12_345.68)).toBe(false);
  });
});

describe('a date that was calculated rather than read', () => {
  it('refuses "doce meses desde el 1 de enero de 2026" proposed as 2027-01-01', () => {
    const { accepted, rejected } = verifyFields(
      [
        {
          fieldKey: 'expires_on',
          date: '2027-01-01',
          quote:
            'El presente contrato se firma el 1 de enero de 2026 y tendrá una vigencia de doce meses.',
        },
      ],
      CONTRACT_CHUNKS,
      'contract',
      TODAY,
    );
    expect(accepted).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/calculada, no leída/);
  });

  it('accepts the date the sentence actually states', () => {
    const { accepted } = verifyFields(
      [
        {
          fieldKey: 'signed_on',
          date: '2026-01-01',
          quote:
            'El presente contrato se firma el 1 de enero de 2026 y tendrá una vigencia de doce meses.',
        },
      ],
      CONTRACT_CHUNKS,
      'contract',
      TODAY,
    );
    expect(accepted[0]?.valueDate).toBe('2026-01-01');
  });
});

describe('NITs', () => {
  it('accepts the digits as printed, with or without the separators', () => {
    expect(quoteSupportsNit('Emisor: COLTRANS S.A.S. NIT 900.123.456-8', '9001234568')).toBe(true);
    expect(quoteSupportsNit('Emisor: COLTRANS S.A.S. NIT 900.123.456-8', '900123456')).toBe(true);
  });

  it('refuses a NIT that is not the one on the page', () => {
    expect(quoteSupportsNit('NIT 900.123.456-8', '900123457')).toBe(false);
    expect(quoteSupportsNit('Factura No. 4471 del 15 de julio', '9001234568')).toBe(false);
  });
});

describe('currency', () => {
  it('reads it only when it is named', () => {
    expect(readCurrency('TOTAL: $1.500.000 M/CTE')).toBe('COP');
    expect(readCurrency('VALOR FOB USD 3.200')).toBe('USD');
    // A bare peso sign is not a currency. This is the annoying-and-correct case.
    expect(readCurrency('TOTAL: $1.500.000')).toBeNull();
  });

  it('leaves the amount without a currency rather than assuming pesos', () => {
    const { accepted } = verifyFields(
      [{ fieldKey: 'total', number: 1_500_000, quote: 'TOTAL A PAGAR: $1.500.000 M/CTE' }],
      [{ id: 'c', chunk_index: 0, content: 'TOTAL A PAGAR: $1.500.000 M/CTE' }],
      'invoice',
      TODAY,
    );
    expect(accepted[0]?.currency).toBe('COP');

    const bare = verifyFields(
      [{ fieldKey: 'total', number: 1_500_000, quote: 'TOTAL A PAGAR: $1.500.000' }],
      [{ id: 'c', chunk_index: 0, content: 'TOTAL A PAGAR: $1.500.000' }],
      'invoice',
      TODAY,
    );
    expect(bare.accepted[0]?.valueNumber).toBe(1_500_000);
    expect(bare.accepted[0]?.currency).toBeNull();
  });
});

describe('classification', () => {
  it('accepts a type the document names out loud', () => {
    const outcome = verifyClassification(
      { docType: 'invoice', quote: 'FACTURA ELECTRÓNICA DE VENTA No. FE-4471' },
      INVOICE_CHUNKS,
    );
    expect(outcome.docType).toBe('invoice');
  });

  it('refuses a type deduced from the contents rather than read', () => {
    const outcome = verifyClassification(
      // A real sentence from the document, which says nothing about it being a
      // waybill. This is what a confident guess looks like.
      { docType: 'waybill', quote: 'Emisor: COLTRANS S.A.S. NIT 900.123.456-8' },
      INVOICE_CHUNKS,
    );
    expect(outcome.docType).toBeNull();
    expect('reason' in outcome && outcome.reason).toMatch(/deducido, no leído/);
  });

  it('treats "I do not know" as an answer', () => {
    const outcome = verifyClassification({ docType: null, quote: '' }, INVOICE_CHUNKS);
    expect(outcome.docType).toBeNull();
    expect('reason' in outcome && outcome.reason).toBeTruthy();
  });
});

describe('what reaches a total', () => {
  it('is only what a person confirmed', () => {
    const fields = [
      {
        fieldKey: 'total',
        reviewState: 'confirmed' as const,
        text: null,
        number: 1_500_000,
        date: null,
        currency: 'COP',
      },
      {
        fieldKey: 'iva',
        reviewState: 'pending' as const,
        text: null,
        number: 239_496,
        date: null,
        currency: 'COP',
      },
      {
        fieldKey: 'issued_on',
        reviewState: 'rejected' as const,
        text: null,
        number: null,
        date: '2026-07-15',
        currency: null,
      },
    ];
    const canonical = canonicalFrom('invoice', fields);
    expect(canonical.total_amount).toBe(1_500_000);
    expect(canonical.currency).toBe('COP');
    // Read, verified, stored — and still not a fact.
    expect(canonical.tax_amount).toBeNull();
    expect(canonical.issued_on).toBeNull();
  });
});
