import { describe, expect, it } from 'vitest';
import { mandatoryHumanConfirmation } from './mandatory-confirmation';
describe('non-delegable company actions', () => {
  it('requires a human for money execution, deletion and access changes', () => {
    for (const id of [
      'payments.approve',
      'banking.transfer',
      'documents.delete',
      'kb.share_space',
      'security.set_action_policy',
      'reports.share',
      'payments.import_bank_statement',
      'payables.approve',
      'sales.invoice_emit',
      'accounting.write_purchase',
      'accounting.write_receipt',
      'accounting.write_supplier_payment',
      'close.close_period',
    ])
      expect(mandatoryHumanConfirmation(id)).toBe(true);
  });
  it('does not confuse financial consultation or receipt recording with paying', () => {
    for (const id of [
      'payments.list',
      'payments.record',
      'payments.preview_bank_statement',
      'payments.bank_unmatched',
      'payroll.team_overview',
      'gmail.send_draft',
    ])
      expect(mandatoryHumanConfirmation(id)).toBe(false);
  });
});
