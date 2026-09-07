import { describe, expect, it } from 'vitest';
import { confirmationResults, pendingConfirmationIndex } from './confirmation-claim';
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

describe('legacy multi-step proposals', () => {
  const parts = [
    {
      type: 'tool-invocation',
      toolInvocation: {
        state: 'result',
        toolCallId: result.toolCallId,
        toolName: 'payments_approve',
        args: result.result.input,
        result: result.result,
      },
    },
  ];
  it('recovers an earlier tool step omitted by a text-only final step', () => {
    for (const saved of [[], null]) {
      const recovered = confirmationResults(saved, parts);
      expect(
        pendingConfirmationIndex(recovered, 'payments.approve', result.result.input, 'call'),
      ).toBe(0);
      expect(pendingConfirmationIndex(recovered, 'payments.approve', { amount: 999 }, 'call')).toBe(
        -1,
      );
    }
  });
  it('never resurrects a claimed or finished proposal from stale parts', () => {
    for (const output of [{ __confirmation_in_progress: true }, { ok: true }, { __error: true }]) {
      const recovered = confirmationResults([{ ...result, result: output }], parts);
      expect(recovered).toHaveLength(1);
      expect(
        pendingConfirmationIndex(recovered, 'payments.approve', result.result.input, 'call'),
      ).toBe(-1);
    }
  });
  it('refuses ambiguous recovery and ignores unfinished invocations', () => {
    expect(
      pendingConfirmationIndex(
        confirmationResults([], [...parts, ...parts]),
        'payments.approve',
        result.result.input,
        'call',
      ),
    ).toBe(-1);
    expect(
      confirmationResults(
        [],
        [{ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'call' } }],
      ),
    ).toEqual([]);
  });
});
