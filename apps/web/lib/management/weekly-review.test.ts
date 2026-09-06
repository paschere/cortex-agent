import { describe, expect, it } from 'vitest';
import type { ManagementCaseData } from './shape';
import { type ReviewEvent, evidenceClosures } from './weekly-review';
function event(revision: number, state: ManagementCaseData['state'], evidence = true): ReviewEvent {
  return {
    case_id: 'case',
    revision,
    created_at: '2026-09-01T12:00:00Z',
    data: {
      state,
      evidence: evidence
        ? {
            reference: 'https://example.com/proof',
            observation: 'Pago comprobado',
            observedOn: '2026-09-01',
          }
        : null,
    } as ManagementCaseData,
  };
}
describe('weekly evidence closures', () => {
  it('counts the transition to verified with proof, once per case', () => {
    expect(
      evidenceClosures([event(2, 'verified'), event(3, 'verified')], [event(1, 'review')]),
    ).toHaveLength(1);
  });
  it('does not count edits to previously verified cases', () => {
    expect(evidenceClosures([event(3, 'verified')], [event(2, 'verified')])).toEqual([]);
  });
  it('does not infer closure from a reply, missing proof or missing history', () => {
    expect(evidenceClosures([event(2, 'review')], [event(1, 'working')])).toEqual([]);
    expect(evidenceClosures([event(2, 'verified', false)], [event(1, 'review')])).toEqual([]);
    expect(evidenceClosures([event(2, 'verified')], [])).toEqual([]);
  });
});
