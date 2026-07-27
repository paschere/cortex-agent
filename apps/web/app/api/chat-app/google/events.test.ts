import { describe, expect, it } from 'vitest';
import { type ChatEvent, invokedFunctionOf, readActionParameters } from './events';

/**
 * Google sends a button press in two shapes at once and has been migrating
 * between them for years. An approval id read out of the wrong one is silently
 * empty, and the click then looks like a stale button — the failure mode with
 * no error anywhere. Both shapes are pinned here.
 */

describe('readActionParameters', () => {
  it('reads the map form used by add-on invocations', () => {
    const event = {
      type: 'CARD_CLICKED',
      common: {
        invokedFunction: 'zippy_approval_decision',
        parameters: { approvalId: 'abc', decision: 'approve' },
      },
    } as ChatEvent;
    expect(readActionParameters(event)).toEqual({ approvalId: 'abc', decision: 'approve' });
    expect(invokedFunctionOf(event)).toBe('zippy_approval_decision');
  });

  it('reads the list form used by plain Chat app events', () => {
    const event = {
      type: 'CARD_CLICKED',
      action: {
        actionMethodName: 'zippy_approval_decision',
        parameters: [
          { key: 'approvalId', value: 'abc' },
          { key: 'decision', value: 'decline' },
        ],
      },
    } as ChatEvent;
    expect(readActionParameters(event)).toEqual({ approvalId: 'abc', decision: 'decline' });
    expect(invokedFunctionOf(event)).toBe('zippy_approval_decision');
  });

  it('lets the map win when Google sends both', () => {
    const event = {
      action: { parameters: [{ key: 'decision', value: 'approve' }] },
      common: { parameters: { decision: 'decline', approvalId: 'abc' } },
    } as ChatEvent;
    expect(readActionParameters(event)).toEqual({ approvalId: 'abc', decision: 'decline' });
  });

  it('drops values that are not scalars instead of stringifying objects', () => {
    const event = {
      common: { parameters: { approvalId: 'abc', nested: { a: 1 }, count: 2, flag: true } },
    } as unknown as ChatEvent;
    expect(readActionParameters(event)).toEqual({ approvalId: 'abc', count: '2', flag: 'true' });
  });

  it('returns nothing for an event with no action at all', () => {
    expect(readActionParameters({ type: 'MESSAGE' } as ChatEvent)).toEqual({});
    expect(invokedFunctionOf({ type: 'MESSAGE' } as ChatEvent)).toBe('');
  });
});
