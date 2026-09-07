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
    ])
      expect(mandatoryHumanConfirmation(id)).toBe(true);
  });
  it('does not confuse financial consultation or receipt recording with paying', () => {
    for (const id of [
      'payments.list',
      'payments.record',
      'payroll.team_overview',
      'gmail.send_draft',
    ])
      expect(mandatoryHumanConfirmation(id)).toBe(false);
  });
});
