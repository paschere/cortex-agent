import { describe, expect, it } from 'vitest';
import { feedFingerprint } from './fingerprint';

describe('Feed content identity', () => {
  it('ignores spreadsheet container metadata but preserves changed cells and types', () => {
    const tables = [
      {
        name: 'Pagos',
        rows: [
          ['id', 'monto'],
          ['001', 10],
        ],
      },
    ];
    expect(feedFingerprint({ text: 'Vista uno', tables })).toBe(
      feedFingerprint({ text: 'Vista dos', tables }),
    );
    expect(feedFingerprint({ text: '', tables })).not.toBe(
      feedFingerprint({
        text: '',
        tables: [
          {
            name: 'Pagos',
            rows: [
              ['id', 'monto'],
              ['001', 20],
            ],
          },
        ],
      }),
    );
  });
  it('does not merge different origins or full and partial captures', () => {
    expect(feedFingerprint({ text: 'x', sourceUrl: 'https://a.test' })).not.toBe(
      feedFingerprint({ text: 'x', sourceUrl: 'https://b.test' }),
    );
    expect(feedFingerprint({ text: 'x' })).not.toBe(
      feedFingerprint({ text: 'x', truncated: true }),
    );
  });
});
