import { describe, expect, it } from 'vitest';
import {
  automationInput,
  automationTransitionSourceStatuses,
  recurringDefinitionError,
  sameHeaders,
} from './automations';
import type { ActivationDefinition } from './types';
const rule: ActivationDefinition = {
  version: 1,
  name: 'Inventario',
  kind: 'table_rule',
  rule: 'conditions',
  conditions: [{ column: 1, operator: 'lt', value: '10' }],
  match: 'all',
  groupBy: [],
  caseTitle: 'Revisar',
  caseObjective: 'Validar',
  caseNextAction: 'Reponer',
};
describe('recurring activation authorization', () => {
  it('does not let pause and resume bypass a mandatory review', () => {
    expect(automationTransitionSourceStatuses('pause')).toEqual(['active']);
    expect(automationTransitionSourceStatuses('resume')).toEqual(['paused']);
    expect(automationTransitionSourceStatuses('pause')).not.toContain('needs_review');
  });
  it('requires explicit future sharing and supported frequency', () => {
    const input = {
      action: 'create',
      runId: '11111111-1111-4111-8111-111111111111',
      trigger: 'on_change',
      intervalMinutes: 60,
      shareConfirmed: true,
    };
    expect(automationInput.safeParse(input).success).toBe(true);
    expect(automationInput.safeParse({ ...input, shareConfirmed: false }).success).toBe(false);
    expect(automationInput.safeParse({ ...input, intervalMinutes: 1 }).success).toBe(false);
  });
  it('requires a business identity for condition matches across versions', () => {
    expect(recurringDefinitionError(rule)).not.toBeNull();
    expect(recurringDefinitionError({ ...rule, identityColumns: [0] })).toBeNull();
  });
  it('rejects reordered or renamed columns instead of silently remapping', () => {
    expect(sameHeaders(['SKU', 'Stock'], ['SKU', 'Stock'])).toBe(true);
    expect(sameHeaders(['SKU', 'Stock'], ['Stock', 'SKU'])).toBe(false);
    expect(sameHeaders(['SKU', 'Stock'], ['SKU', 'Units'])).toBe(false);
    expect(sameHeaders(['SKU', 'Stock'], ['SKU'])).toBe(false);
  });
});
