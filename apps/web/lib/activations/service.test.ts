import { describe, expect, it } from 'vitest';
import { simulateDefinition, simulateInvoices, validateMappingForSheet } from './service';

const mapping = { invoiceNumber: 0, issuer: 1, amount: 2, currency: 3, issuedOn: 4 };

describe('invoice activation simulation', () => {
  it('uses issuer, invoice number and explicit currency for conservative duplicate identity', () => {
    const rows = simulateInvoices(
      '10000000-0000-4000-8000-000000000000',
      {
        name: 'Facturas',
        rows: [
          ['Número', 'Emisor', 'Monto', 'Moneda', 'Fecha'],
          ['001', 'Acme SAS', '100', 'COP', '2026-09-01'],
          ['001', ' acme  sas ', '999', 'cop', '2026-09-02'],
          ['001', 'Acme SAS', '100', 'USD', '2026-09-01'],
        ],
      },
      mapping,
    );
    expect(rows.map((row) => row.status)).toEqual(['matched', 'matched', 'unmatched']);
    expect(rows[0]?.sourceKey).toBe(rows[1]?.sourceKey);
    expect(rows[2]?.sourceKey).not.toBe(rows[0]?.sourceKey);
  });

  it('does not infer missing currency and preserves amounts as source text', () => {
    const [row] = simulateInvoices(
      '10000000-0000-4000-8000-000000000000',
      {
        name: 'Facturas',
        rows: [
          ['n', 'e', 'a', 'c', 'f'],
          ['F-9', 'Acme', '1.250,50', '', '09/01/2026'],
        ],
      },
      mapping,
    );
    expect(row?.amount).toBe('1.250,50');
    expect(row?.status).toBe('invalid');
    expect(row?.reasons).toContain('La moneda debe venir explícita con código de 3 letras.');
    expect(row?.reasons).toContain('La fecha debe venir como AAAA-MM-DD.');
  });

  it('rejects calendar rollovers and ambiguous thousand/decimal separators', () => {
    const [row] = simulateInvoices(
      'same-feed-content',
      {
        name: 'Facturas',
        rows: [
          ['n', 'e', 'a', 'c', 'f'],
          ['F-10', 'Acme', '100.000', 'COP', '2026-02-30'],
        ],
      },
      mapping,
    );
    expect(row?.status).toBe('invalid');
    expect(row?.reasons).toContain('El monto no es un número decimal inequívoco.');
    expect(row?.reasons).toContain('La fecha debe venir como AAAA-MM-DD.');
  });

  it('excludes negative amounts because credit notes are outside this activation', () => {
    const [row] = simulateInvoices(
      'same-feed-content',
      {
        name: 'Facturas',
        rows: [
          ['n', 'e', 'a', 'c', 'f'],
          ['NC-1', 'Acme', '-100', 'COP', '2026-09-01'],
        ],
      },
      mapping,
    );
    expect(row?.status).toBe('invalid');
    expect(row?.reasons).toContain('El monto no es un número decimal inequívoco.');
  });

  it('rejects identifiers that cannot be represented without truncation', () => {
    const [row] = simulateInvoices(
      'same-feed-content',
      {
        name: 'Facturas',
        rows: [
          ['n', 'e', 'a', 'c', 'f'],
          ['F'.repeat(241), 'Acme', '100', 'COP', '2026-09-01'],
        ],
      },
      mapping,
    );
    expect(row?.status).toBe('invalid');
    expect(row?.reasons).toContain('El número de factura es demasiado largo.');
  });

  it('keeps dedupe identity stable across reuploads of the same Feed content', () => {
    const sheet = {
      name: 'Facturas',
      rows: [
        ['n', 'e', 'a', 'c', 'f'],
        ['F-11', 'Acme', '100', 'COP', '2026-09-01'],
      ],
    };
    expect(simulateInvoices('content-hash', sheet, mapping)[0]?.sourceKey).toBe(
      simulateInvoices('content-hash', sheet, mapping)[0]?.sourceKey,
    );
    expect(simulateInvoices('different-content', sheet, mapping)[0]?.sourceKey).not.toBe(
      simulateInvoices('content-hash', sheet, mapping)[0]?.sourceKey,
    );
  });

  it('does not create a duplicate group from one valid row and one invalid peer', () => {
    const rows = simulateInvoices(
      'content-hash',
      {
        name: 'Facturas',
        rows: [
          ['n', 'e', 'a', 'c', 'f'],
          ['F-12', 'Acme', '100', 'COP', '2026-09-01'],
          ['F-12', 'Acme', '-100', 'COP', '2026-09-02'],
        ],
      },
      mapping,
    );
    expect(rows.map((row) => row.status)).toEqual(['unmatched', 'invalid']);
  });

  it('rejects mapping indices outside the selected sheet', () => {
    expect(() =>
      validateMappingForSheet({ name: 'Corta', rows: [['n', 'e']] }, { ...mapping, issuedOn: 99 }),
    ).toThrow('columna que no existe');
  });

  it('matches generic duplicate groups and leaves single rows unmatched', () => {
    const rows = simulateDefinition(
      'content',
      {
        name: 'Stock',
        rows: [
          ['SKU', 'Bodega'],
          ['A1', 'Norte'],
          ['A1', 'Sur'],
          ['B2', 'Norte'],
        ],
      },
      {
        version: 1,
        name: 'SKU repetido',
        kind: 'table_rule',
        rule: 'duplicates',
        conditions: [],
        match: 'all',
        groupBy: [0],
        evidenceColumns: [1],
        caseTitle: 'Revisar {{SKU}}',
        caseObjective: 'Validar inventario',
        caseNextAction: 'Comparar bodegas',
      },
    );
    expect(rows.map((row) => row.status)).toEqual(['matched', 'matched', 'unmatched']);
    expect(rows[0]?.values.map((value) => value.header)).toEqual(['SKU', 'Bodega']);
  });

  it('evaluates generic conditions without code execution', () => {
    const rows = simulateDefinition(
      'content',
      {
        name: 'Cartera',
        rows: [
          ['Cliente', 'Días'],
          ['Ana', '31'],
          ['Luis', '5'],
        ],
      },
      {
        version: 1,
        name: 'Cartera vencida',
        kind: 'table_rule',
        rule: 'conditions',
        conditions: [{ column: 1, operator: 'gt', value: '30' }],
        match: 'all',
        groupBy: [],
        evidenceColumns: [0],
        caseTitle: 'Cobrar a {{Cliente}}',
        caseObjective: 'Revisar cartera',
        caseNextAction: 'Contactar al cliente',
      },
    );
    expect(rows.map((row) => row.status)).toEqual(['matched', 'unmatched']);
  });

  it('does not group blank keys or rows filtered out by duplicate conditions', () => {
    const rows = simulateDefinition(
      'content',
      {
        name: 'Stock',
        rows: [
          ['SKU', 'Estado'],
          ['', 'activo'],
          ['', 'activo'],
          ['A1', 'inactivo'],
          ['A1', 'inactivo'],
        ],
      },
      {
        version: 1,
        name: 'SKU activo repetido',
        kind: 'table_rule',
        rule: 'duplicates',
        conditions: [{ column: 1, operator: 'equals', value: 'activo' }],
        match: 'all',
        groupBy: [0],
        caseTitle: 'Revisar SKU',
        caseObjective: 'Validar',
        caseNextAction: 'Comparar',
      },
    );
    expect(rows.map((row) => row.status)).toEqual(['invalid', 'invalid', 'unmatched', 'unmatched']);
  });

  it('keeps grouping tuples collision-safe', () => {
    const rows = simulateDefinition(
      'content',
      {
        name: 'Datos',
        rows: [
          ['A', 'B'],
          ['a|b', 'c'],
          ['a', 'b|c'],
        ],
      },
      {
        version: 1,
        name: 'Combinación repetida',
        kind: 'table_rule',
        rule: 'duplicates',
        conditions: [],
        match: 'all',
        groupBy: [0, 1],
        caseTitle: 'Revisar',
        caseObjective: 'Validar',
        caseNextAction: 'Comparar',
      },
    );
    expect(rows.map((row) => row.status)).toEqual(['unmatched', 'unmatched']);
    expect(rows[0]?.groupKey).not.toBe(rows[1]?.groupKey);
  });

  it('marks malformed dates and unbounded numbers invalid instead of throwing', () => {
    const definition = {
      version: 1 as const,
      name: 'Fechas',
      kind: 'table_rule' as const,
      rule: 'conditions' as const,
      conditions: [{ column: 0, operator: 'before_today' as const }],
      match: 'all' as const,
      groupBy: [],
      caseTitle: 'Revisar',
      caseObjective: 'Validar',
      caseNextAction: 'Comparar',
    };
    expect(
      simulateDefinition(
        'content',
        { name: 'Datos', rows: [['Fecha'], ['2026-99-01']] },
        definition,
      )[0]?.status,
    ).toBe('invalid');
  });

  it('compares integers beyond Number safe precision exactly', () => {
    const rows = simulateDefinition(
      'content',
      { name: 'Datos', rows: [['Saldo'], ['9007199254740993'], ['9007199254740992']] },
      {
        version: 1,
        name: 'Saldo alto',
        kind: 'table_rule',
        rule: 'conditions',
        conditions: [{ column: 0, operator: 'gt', value: '9007199254740992' }],
        match: 'all',
        groupBy: [],
        caseTitle: 'Revisar saldo',
        caseObjective: 'Validar',
        caseNextAction: 'Comparar',
      },
    );
    expect(rows.map((row) => row.status)).toEqual(['matched', 'unmatched']);
  });
});
