import { activationRequestSchema, isSameOrigin } from '@/lib/activations/request';
import { describe, expect, it } from 'vitest';

describe('activation API boundary', () => {
  it('rejects cross-origin mutations', () => {
    const request = {
      headers: new Headers({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }),
      nextUrl: new URL('https://cortex.example/api/activations'),
    };
    expect(isSameOrigin(request as never)).toBe(false);
  });

  it('requires explicit sharing consent for commit', () => {
    expect(
      activationRequestSchema.safeParse({ action: 'commit', runId: crypto.randomUUID() }).success,
    ).toBe(false);
  });

  it('rejects a mapping that reuses a column', () => {
    expect(
      activationRequestSchema.safeParse({
        action: 'simulate',
        sourceId: crypto.randomUUID(),
        sheetIndex: 0,
        definition: {
          version: 1,
          name: 'Facturas',
          kind: 'invoice_duplicates',
          mapping: { invoiceNumber: 0, issuer: 0, amount: 2, currency: 3, issuedOn: 4 },
        },
      }).success,
    ).toBe(false);
  });
});
