import { getTool } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { isGlobalActionTool } from './actions';

function knownTool(id: string) {
  const definition = getTool(id);
  if (!definition) throw new Error(`Missing registered tool ${id}`);
  return definition;
}

describe('global action registry boundary', () => {
  it('includes curated operational actions whose own tool flag is intentionally absent', () => {
    const errand = knownTool('errands.start');
    expect(errand.requiresConfirmation ?? false).toBe(false);
    expect(isGlobalActionTool(errand)).toBe(true);
  });

  it('includes registry tools that explicitly require confirmation', () => {
    const payment = knownTool('payments.record');
    expect(payment.requiresConfirmation).toBe(true);
    expect(isGlobalActionTool(payment)).toBe(true);
  });

  it('does not turn ordinary readers into global actions', () => {
    expect(isGlobalActionTool(knownTool('kb.search'))).toBe(false);
  });
});
