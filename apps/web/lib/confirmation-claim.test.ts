import { describe, expect, it } from 'vitest';
import { pendingConfirmationIndex } from './confirmation-claim';
const result = {
  toolCallId: 'call',
  result: {
    __requires_confirmation: true,
    toolId: 'payments.approve',
    input: { currency: 'COP', amount: 10 },
  },
};
describe('confirmation is tied to the proposed action', () => {
  it('accepts equivalent input with different object order', () =>
    expect(
      pendingConfirmationIndex(
        [result],
        'payments.approve',
        { amount: 10, currency: 'COP' },
        'call',
      ),
    ).toBe(0));
  it('refuses edited amount, tool and call', () => {
    expect(
      pendingConfirmationIndex(
        [result],
        'payments.approve',
        { amount: 100, currency: 'COP' },
        'call',
      ),
    ).toBe(-1);
    expect(pendingConfirmationIndex([result], 'payments.send', result.result.input, 'call')).toBe(
      -1,
    );
    expect(
      pendingConfirmationIndex([result], 'payments.approve', result.result.input, 'other'),
    ).toBe(-1);
  });
  it('refuses ambiguity and already claimed execution', () => {
    expect(
      pendingConfirmationIndex([result, result], 'payments.approve', result.result.input),
    ).toBe(-1);
    expect(
      pendingConfirmationIndex(
        [{ ...result, result: { __confirmation_in_progress: true } }],
        'payments.approve',
        result.result.input,
      ),
    ).toBe(-1);
  });
});
