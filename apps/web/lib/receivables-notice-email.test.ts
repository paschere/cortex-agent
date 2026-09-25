import { describe, expect, it } from 'vitest';
import { renderReceivablesNoticeEmail } from './receivables-notice-email';

const risk = {
  today: '2026-09-25',
  cop: {
    receivablesOverdue: 38_500_000,
    overdueInvoices: 7,
    paymentsOverdue: 1_200_000,
    paymentsDueSoon: 3_000_000,
    paymentCommitments: 2,
    finesPending: 0,
    fines: 0,
    total: 42_700_000,
  },
  otherCurrencies: [{ currency: 'USD', receivablesOverdue: 1200, overdueInvoices: 1 }],
  topInvoices: [],
};

describe('el correo de cartera', () => {
  it('nombra la factura, el saldo y la mora, y no mezcla monedas', () => {
    const mail = renderReceivablesNoticeEmail({
      organizationName: 'Transportes Andinos',
      risk,
      crossed: [
        {
          id: 'x',
          docNumber: 'FE-1203',
          clientId: null,
          clientName: 'Nexa Logística',
          counterparty: null,
          currency: 'COP',
          balance: 12_400_000,
          dueOn: '2026-07-27',
          daysOverdue: 60,
          stage: 60,
        },
      ],
    });
    expect(mail.subject).toContain('Nexa Logística');
    expect(mail.subject).toContain('pasó los 60 días');
    expect(mail.text).toContain('FE-1203');
    expect(mail.text).toMatch(/38\.500\.000/);
    expect(mail.text).toContain('USD');
    expect(mail.html).toContain('Urgente');
  });
});
