import { describe, expect, it } from 'vitest';
import { normalizeApiFeed } from './api-source';

describe('API sources for Feed', () => {
  it('normalizes arrays of objects with stable first-seen columns and nested JSON as text', () => {
    const result = normalizeApiFeed([
      { id: '001', customer: { name: 'Ana' } },
      { customer: { name: 'Beto' }, amount: 20 },
    ]);
    expect(result.tables).toEqual([
      {
        name: 'API',
        rows: [
          ['id', 'customer', 'amount'],
          ['001', '{"name":"Ana"}', null],
          [null, '{"name":"Beto"}', 20],
        ],
      },
    ]);
  });

  it('keeps non-tabular responses as bounded text', () => {
    expect(normalizeApiFeed({ status: 'ok' })).toMatchObject({
      text: '{\n  "status": "ok"\n}',
      truncated: false,
    });
  });

  it('caps rows and reports truncation', () => {
    const result = normalizeApiFeed(Array.from({ length: 501 }, (_, id) => ({ id })));
    expect(result.tables?.[0]?.rows).toHaveLength(501); // header + 500 records
    expect(result.truncated).toBe(true);
  });
});
