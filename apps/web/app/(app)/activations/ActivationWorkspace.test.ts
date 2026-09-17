import type { ActivationCandidate } from '@/lib/activations/types';
import { describe, expect, it } from 'vitest';
import { groupCandidates, resolveInitialSource, suggestMapping } from './ActivationWorkspace';

describe('Activations column mapping', () => {
  it('suggests distinct invoice columns from Spanish headers', () => {
    expect(
      suggestMapping(['Número factura', 'Proveedor', 'Total', 'Moneda', 'Fecha emisión']),
    ).toEqual({
      invoiceNumber: 0,
      issuer: 1,
      amount: 2,
      currency: 3,
      issuedOn: 4,
    });
  });

  it('leaves missing columns unresolved instead of reusing evidence', () => {
    expect(suggestMapping(['Factura', 'Descripción'])).toEqual({
      invoiceNumber: 0,
      issuer: -1,
      amount: -1,
      currency: -1,
      issuedOn: -1,
    });
  });

  it('creates one review group per shared source key and keeps unmatched rows out', () => {
    const candidate = (
      rowIndex: number,
      sourceKey: string,
      status: ActivationCandidate['status'],
    ) => ({
      rowIndex,
      sourceKey,
      status,
      groupKey: status === 'matched' ? sourceKey : null,
      values: [{ column: 0, header: 'ID', value: `F-${rowIndex}` }],
      reasons: [],
    });
    const grouped = groupCandidates([
      candidate(2, 'same', 'matched'),
      candidate(7, 'same', 'matched'),
      candidate(9, 'other', 'matched'),
      candidate(10, 'unique', 'unmatched'),
      candidate(11, 'invalid', 'invalid'),
    ]);

    expect(grouped.matchedGroups.size).toBe(2);
    expect(grouped.matchedGroups.get('same')?.map((item) => item.rowIndex)).toEqual([2, 7]);
    expect(grouped.unmatched.map((item) => item.rowIndex)).toEqual([10]);
    expect(grouped.invalid.map((item) => item.rowIndex)).toEqual([11]);
  });

  it('accepts a linked source only when it belongs to the loaded workspace response', () => {
    const sources = [
      {
        id: 'owned',
        filename: 'facturas.xlsx',
        createdAt: '',
        expiresAt: '',
        kind: 'table' as const,
        canPrepare: false,
        sheets: [],
        preparedViews: [],
      },
    ];
    expect(resolveInitialSource(sources, 'owned')).toBe('owned');
    expect(resolveInitialSource(sources, 'another-workspace')).toBe('');
  });
});
