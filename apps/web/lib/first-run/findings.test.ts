import { describe, expect, it } from 'vitest';
import { type FindingsInput, buildFindings, chatHref, daysBetween } from './findings';

const empty: FindingsInput = {
  today: '2026-10-08',
  receivables: { count: 0, total: 0, currency: 'COP', top: [] },
  payables: { count: 0, total: 0, currency: 'COP', next: null },
  expiring: [],
  topClients: [],
  commitments: { overdue: 0, oldestTitle: null },
  documentsReady: 0,
};

describe('buildFindings', () => {
  it('sin datos no inventa nada', () => {
    expect(buildFindings(empty)).toEqual([]);
  });

  it('cartera vencida va primero y trae siguiente paso en el chat', () => {
    const out = buildFindings({
      ...empty,
      receivables: {
        count: 3,
        total: 4_500_000,
        currency: 'COP',
        top: [{ name: 'Acme', balance: 3_000_000, daysLate: 12 }],
      },
      payables: { count: 2, total: 1_000_000, currency: 'COP', next: null },
    });
    expect(out[0]?.id).toBe('receivables');
    expect(out[0]?.title).toContain('3 facturas vencidas');
    expect(out[0]?.detail).toContain('Acme');
    expect(out[0]?.action.kind).toBe('chat');
    expect(out.map((f) => f.id)).toEqual(['receivables', 'payables']);
  });

  it('vencimientos: ignora lo lejano, ordena y marca vencido como alerta', () => {
    const out = buildFindings({
      ...empty,
      expiring: [
        { title: 'SOAT', expiresOn: '2026-10-01' },
        { title: 'Lejano', expiresOn: '2027-06-01' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.tone).toBe('alert');
    expect(out[0]?.title).toContain('venció hace 7 días');
  });

  it('nunca pasa de cinco', () => {
    const out = buildFindings({
      today: '2026-10-08',
      receivables: { count: 1, total: 10, currency: 'COP', top: [] },
      payables: { count: 1, total: 10, currency: 'COP', next: null },
      expiring: [{ title: 'X', expiresOn: '2026-10-09' }],
      topClients: [{ name: 'A', invoices: 4 }],
      commitments: { overdue: 2, oldestTitle: 'Pagar' },
      documentsReady: 9,
    });
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it('documentos leídos llenan cuando hay pocos hallazgos', () => {
    const out = buildFindings({ ...empty, documentsReady: 12 });
    expect(out[0]?.id).toBe('documents');
  });
});

describe('utilidades', () => {
  it('daysBetween y chatHref', () => {
    expect(daysBetween('2026-10-01', '2026-10-08')).toBe(7);
    expect(chatHref('hola mundo')).toBe('/chat?prompt=hola%20mundo');
  });
});
